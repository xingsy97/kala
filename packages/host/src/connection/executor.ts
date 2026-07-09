/**
 * Executor connection tracking + tool dispatch bridge.
 *
 * An executor is a daemon: it announces once (with a stable `workspaceId`),
 * then serves `tool:call`s for any session the host routes to it. The
 * registry maps `executorId → Bind`, with per-session pending call lists
 * inside each Bind (so cancel/redispatch can iterate one session at a time
 * without touching unrelated sessions).
 *
 * Routing: each session carries a `workspaceId` (set at create time from the
 * "New" flow, see ADR 0014). `callTool` matches that workspaceId against a
 * live executor's announced workspaceId. If none is attached, the call fails
 * loudly — sessions do not "fall over" to a different machine. Sessions
 * predating the workspaceId field pass undefined and get the first available
 * executor as a legacy fallback.
 */

import type { Server, Socket } from 'socket.io'

import type {
  CallToolEffect,
} from '@agent-kernel/kernel'
import type {
  AttachedExecutor,
  BgKillResult,
  BgListResult,
  BgOutputResult,
  ClientKillBgTask,
  ClientListBgTasks,
  ClientListDirs,
  ClientListFiles,
  ClientReadBgOutput,
  ClientReadFile,
  ClientReadOverflow,
  CopyOverflowSession,
  CopyOverflowSessionResult,
  DeleteOverflowSession,
  DeleteOverflowSessionResult,
  DirListResult,
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ExecutorToolResult,
  FileContentsResult,
  FileListResult,
  OverflowContentsResult,
  ServerExecutorChangedPayload,
  ToolResultAck,
} from '@agent-kernel/shared'

import type { ToolDispatcher } from '../loop.js'

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000

type Pending = {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string
  resolve: (result: { ok: boolean; content: string }) => void
  timer: NodeJS.Timeout
}

export type ExecutorChangeListener = (change: ServerExecutorChangedPayload) => void

/**
 * Lets the registry look up a session's target workspace without a store
 * dependency. Wired at registry-construction time from server.ts, backed by
 * `SessionStore.get(sessionId)?.workspaceId`.
 */
export type WorkspaceResolver = {
  workspaceIdFor(sessionId: string): string | undefined
}

export type ExecutorLookup = {
  executorForSession(sessionId: string): AttachedExecutor | undefined
  listDirs(workspaceId: string, path: string | undefined, requestId: string): Promise<DirListResult>
  listFiles(payload: ClientListFiles): Promise<FileListResult>
  readFile(payload: ClientReadFile): Promise<FileContentsResult>
  readOverflow(payload: ClientReadOverflow, workspaceId: string): Promise<OverflowContentsResult>
  copyOverflowSession(workspaceId: string, sourceSessionId: string, targetSessionId: string): Promise<CopyOverflowSessionResult>
  deleteOverflowSession(workspaceId: string, sessionId: string): Promise<DeleteOverflowSessionResult>
  listBg(payload: ClientListBgTasks): Promise<BgListResult>
  readBg(payload: ClientReadBgOutput): Promise<BgOutputResult>
  killBg(payload: ClientKillBgTask): Promise<BgKillResult>
}

export type ExecutorRegistry = ToolDispatcher & ExecutorLookup & {
  attach(
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >,
    announcement: ExecutorAnnounce,
    clientVersion?: string,
  ): void
  detach(
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >,
  ): void
  fulfill(sessionId: string, result: ExecutorToolResult): void
  activeSessions(): string[]
  snapshot(): AttachedExecutor[]
  onChange(listener: ExecutorChangeListener): () => void
}

export function createExecutorRegistry(
  _io: Server,
  resolver: WorkspaceResolver,
  toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
): ExecutorRegistry {
  type Bind = {
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >
    announcement: ExecutorAnnounce
    attachedAt: string
    clientVersion?: string
    /** callId → Pending. Session is inside Pending — one flat map is enough for O(1) fulfill. */
    pending: Map<string, Pending>
  }
  const byExecutor = new Map<string, Bind>()
  const socketToExecutor = new Map<string, string>()
  const listeners = new Set<ExecutorChangeListener>()

  function emitChange(change: ServerExecutorChangedPayload): void {
    for (const l of listeners) l(change)
  }

  function toAttached(bind: Bind): AttachedExecutor {
    const out: AttachedExecutor = {
      ...bind.announcement,
      attachedAt: bind.attachedAt,
    }
    if (bind.clientVersion !== undefined) out.clientVersion = bind.clientVersion
    return out
  }

  function synthesizeFailure(bind: Bind, reason: string): void {
    for (const p of bind.pending.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, content: reason })
    }
    bind.pending.clear()
  }

  /**
   * Move outstanding pending calls from the old bind to the new one and
   * re-emit `tool:call` over the fresh socket. Timers are recreated so the
   * timeout window restarts from the reconnect.
   *
   * Session identity is baked into each Pending, so the new socket gets the
   * same sessionId in the payload — the daemon doesn't know or care which
   * session moved.
   */
  function redispatchPending(oldBind: Bind, newBind: Bind): void {
    for (const p of oldBind.pending.values()) {
      clearTimeout(p.timer)
      const timer = setTimeout(() => {
        if (newBind.pending.delete(p.callId)) {
          p.resolve({
            ok: false,
            content: `tool call timed out after ${toolTimeoutMs}ms (post-reconnect)`,
          })
        }
      }, toolTimeoutMs)
      newBind.pending.set(p.callId, {
        sessionId: p.sessionId,
        callId: p.callId,
        name: p.name,
        input: p.input,
        ...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
        resolve: p.resolve,
        timer,
      })
      newBind.socket.emit(
        'tool:call',
        {
          sessionId: p.sessionId,
          callId: p.callId,
          name: p.name,
          input: p.input,
          ...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
          timeoutMs: toolTimeoutMs,
        },
        (ack: ToolResultAck) => {
          const pending = newBind.pending.get(ack.callId)
          if (!pending) return
          clearTimeout(pending.timer)
          newBind.pending.delete(ack.callId)
          pending.resolve({ ok: ack.ok, content: ack.content })
        },
      )
    }
    oldBind.pending.clear()
  }

  function findBindByWorkspace(workspaceId: string): Bind | undefined {
    for (const bind of byExecutor.values()) {
      if (bind.announcement.workspaceId === workspaceId) return bind
    }
    return undefined
  }

  function defaultDirList(
    requestId: string,
    workspaceId: string,
    path: string | undefined,
    error: string,
  ): DirListResult {
    return {
      requestId,
      workspaceId,
      path: path ?? '',
      roots: [],
      entries: [],
      error,
    }
  }

  /**
   * Sessions predating the workspaceId field carry no target. Route them to
   * whichever executor is online. Kept only for legacy JSONL headers — new
   * sessions always have `workspaceId` set at create time.
   */
  function pickAnyBind(): Bind | undefined {
    return byExecutor.values().next().value as Bind | undefined
  }

  function pickBindFor(sessionId: string):
    | { ok: true; bind: Bind }
    | { ok: false; reason: string } {
    const targetWorkspace = resolver.workspaceIdFor(sessionId)
    if (targetWorkspace === undefined) {
      const any = pickAnyBind()
      if (!any) return { ok: false, reason: 'no executor connected' }
      return { ok: true, bind: any }
    }
    const bind = findBindByWorkspace(targetWorkspace)
    if (!bind)
      return {
        ok: false,
        reason: `workspace ${targetWorkspace} is offline — start its executor to run tools`,
      }
    return { ok: true, bind }
  }

  /**
   * Host-initiated direct-mode tool call. Sent as an ordinary `tool:call`
   * with `dispatchMode: 'direct'` — the executor runs the tool identically
   * to a kernel-initiated call, but the host doesn't feed the result back
   * through the kernel FSM. The tool's stdout string is expected to be
   * JSON; we parse it and hand the caller the typed result. On timeout
   * or wire failure the caller gets a synthetic error result of type T
   * built via `onError(errorMessage)`.
   */
  function dispatchDirectTool<T>(
    bind: Bind,
    workspaceId: string,
    name: string,
    input: Record<string, unknown>,
    onError: (msg: string) => T,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const callId = `direct-${Math.random().toString(36).slice(2, 10)}`
      const timer = setTimeout(() => {
        resolve(onError(`${name} timed out after ${toolTimeoutMs}ms`))
      }, toolTimeoutMs)
      // sessionId here is a routing convenience; the direct-mode flag tells
      // the executor's runOne to skip the tool_result event dispatch on
      // the host side. Use the workspaceId as the pseudo-sessionId so any
      // future audit trace can correlate.
      bind.socket.emit(
        'tool:call',
        {
          sessionId: `__direct:${workspaceId}`,
          callId,
          name,
          input,
          timeoutMs: toolTimeoutMs,
          dispatchMode: 'direct',
        },
        (ack: ToolResultAck) => {
          clearTimeout(timer)
          if (!ack.ok) {
            resolve(onError(ack.content || `${name} failed`))
            return
          }
          try {
            resolve(JSON.parse(ack.content) as T)
          } catch (err) {
            resolve(
              onError(
                `${name} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
          }
        },
      )
    })
  }

  return {
    attach(socket, announcement, clientVersion) {
      const executorId = announcement.executorId
      const workspaceId = announcement.workspaceId
      const newBind: Bind = {
        socket,
        announcement,
        attachedAt: new Date().toISOString(),
        pending: new Map(),
        ...(clientVersion !== undefined ? { clientVersion } : {}),
      }

      // Case 1: same executorId already attached → normal reconnect. Preserve
      // outstanding calls and swap in the new socket. This is the path
      // triggered when a single executor process restarts or its socket
      // briefly disconnects.
      const existingSame = byExecutor.get(executorId)
      if (existingSame) {
        socketToExecutor.delete(existingSame.socket.id)
        redispatchPending(existingSame, newBind)
        byExecutor.set(executorId, newBind)
        socketToExecutor.set(socket.id, executorId)
        emitChange({
          change: 'updated',
          executorId,
          executor: toAttached(newBind),
        })
        return
      }

      // Case 2: different executorId but same workspaceId → a *different*
      // process is claiming the same workspace. That happens when a
      // duplicate `~/.agent-kernel/workspace-id` file was copied to another
      // machine, or when two processes on the same host started before the
      // local-instance lockfile could take effect.
      //
      // Arbitration: if the current claimant's socket is still connected,
      // reject the newcomer with a permanent error. If it's already gone
      // (a disconnect event that hasn't propagated, or a race), let the
      // newcomer take over.
      const wsClaimant = findBindByWorkspace(workspaceId)
      if (wsClaimant && wsClaimant.announcement.executorId !== executorId) {
        if (wsClaimant.socket.connected) {
          socket.emit('executor:host_reject', {
            code: 'workspace_id_conflict',
            message:
              `workspace ${workspaceId} is already claimed by ` +
              `executor ${wsClaimant.announcement.executorId} ` +
              `(from ${wsClaimant.announcement.hostname ?? '?'}). ` +
              `Two executors cannot hold the same workspaceId simultaneously — ` +
              `check for a duplicate ~/.agent-kernel/workspace-id file across machines.`,
          })
          // Server-initiated disconnect: the executor's socket.io client sees
          // this as `disconnect('io server disconnect')` and, with the retry
          // logic in fix 3, will stop reconnecting instead of hot-looping.
          socket.disconnect(true)
          return
        }
        // Stale claimant: take over. Cancel its in-flight calls, evict it
        // from the registry, then fall through to normal attach.
        synthesizeFailure(wsClaimant, 'workspace claimed by new executor')
        byExecutor.delete(wsClaimant.announcement.executorId)
        socketToExecutor.delete(wsClaimant.socket.id)
        emitChange({
          change: 'detached',
          executorId: wsClaimant.announcement.executorId,
        })
      }

      // Case 3: brand-new executor + fresh workspaceId. Normal attach.
      byExecutor.set(executorId, newBind)
      socketToExecutor.set(socket.id, executorId)
      emitChange({
        change: 'attached',
        executorId,
        executor: toAttached(newBind),
      })
    },
    detach(socket) {
      const executorId = socketToExecutor.get(socket.id)
      if (!executorId) return
      const bind = byExecutor.get(executorId)
      if (!bind || bind.socket.id !== socket.id) return
      synthesizeFailure(bind, 'executor disconnected')
      byExecutor.delete(executorId)
      socketToExecutor.delete(socket.id)
      emitChange({
        change: 'detached',
        executorId,
      })
    },
    fulfill(_sessionId, result) {
      // A callId is unique across the host; scan all executors is O(N executors),
      // but N is tiny (usually 1). Keeping this simple avoids a second index.
      for (const bind of byExecutor.values()) {
        const pending = bind.pending.get(result.callId)
        if (!pending) continue
        clearTimeout(pending.timer)
        bind.pending.delete(result.callId)
        pending.resolve({ ok: result.ok, content: result.content })
        return
      }
    },
    async callTool(sessionId, eff: CallToolEffect) {
      const picked = pickBindFor(sessionId)
      if (!picked.ok) return { ok: false, content: picked.reason }
      const bind = picked.bind
      return await new Promise<{ ok: boolean; content: string }>((resolve) => {
        const timer = setTimeout(() => {
          if (bind.pending.delete(eff.callId)) {
            resolve({
              ok: false,
              content: `tool call timed out after ${toolTimeoutMs}ms`,
            })
          }
        }, toolTimeoutMs)
        bind.pending.set(eff.callId, {
          sessionId,
          callId: eff.callId,
          name: eff.name,
          input: eff.input,
          ...(eff.cwd !== undefined ? { cwd: eff.cwd } : {}),
          resolve,
          timer,
        })
        bind.socket.emit(
          'tool:call',
          {
            sessionId,
            callId: eff.callId,
            name: eff.name,
            input: eff.input,
            ...(eff.cwd !== undefined ? { cwd: eff.cwd } : {}),
            timeoutMs: toolTimeoutMs,
          },
          (ack: ToolResultAck) => {
            const pending = bind.pending.get(ack.callId)
            if (!pending) return
            clearTimeout(pending.timer)
            bind.pending.delete(ack.callId)
            pending.resolve({ ok: ack.ok, content: ack.content })
          },
        )
      })
    },
    cancelPending(sessionId) {
      // Iterate every bind and cancel any pending call attached to this
      // session. With sticky routing gone there's no single "owner"
      // executor — but calls are still scoped per-session inside each bind.
      for (const bind of byExecutor.values()) {
        for (const p of [...bind.pending.values()]) {
          if (p.sessionId !== sessionId) continue
          bind.socket.emit('tool:cancel', { sessionId, callId: p.callId })
          clearTimeout(p.timer)
          bind.pending.delete(p.callId)
          p.resolve({ ok: false, content: 'cancelled by user' })
        }
      }
    },
    activeSessions() {
      const out = new Set<string>()
      for (const bind of byExecutor.values()) {
        for (const p of bind.pending.values()) out.add(p.sessionId)
      }
      return [...out]
    },
    snapshot() {
      return [...byExecutor.values()].map(toAttached)
    },
    executorForSession(sessionId) {
      const picked = pickBindFor(sessionId)
      return picked.ok ? toAttached(picked.bind) : undefined
    },
    async listDirs(workspaceId, path, requestId) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind) {
        return defaultDirList(requestId, workspaceId, path, 'workspace offline')
      }
      return await dispatchDirectTool<DirListResult>(
        bind,
        workspaceId,
        '__fs_list_dirs',
        { requestId, workspaceId, ...(path !== undefined ? { path } : {}) },
        (msg) => defaultDirList(requestId, workspaceId, path, msg),
      )
    },
    async listFiles(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          files: [],
          truncated: false,
          error: 'workspace offline',
        }
      }
      return await dispatchDirectTool<FileListResult>(
        bind,
        payload.workspaceId,
        '__fs_list_files',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          files: [],
          truncated: false,
          error: msg,
        }),
      )
    },
    async readFile(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          path: payload.path,
          error: 'workspace offline',
        }
      }
      return await dispatchDirectTool<FileContentsResult>(
        bind,
        payload.workspaceId,
        '__fs_read_file',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          path: payload.path,
          error: msg,
        }),
      )
    },
    async readOverflow(payload, workspaceId) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          sessionId: payload.sessionId,
          callId: payload.callId,
          error: 'workspace offline',
        }
      }
      return await dispatchDirectTool<OverflowContentsResult>(
        bind,
        workspaceId,
        '__fs_read_overflow',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          sessionId: payload.sessionId,
          callId: payload.callId,
          error: msg,
        }),
      )
    },
    async copyOverflowSession(workspaceId, sourceSessionId, targetSessionId) {
      const bind = findBindByWorkspace(workspaceId)
      const payload: CopyOverflowSession = {
        requestId: `${Date.now()}-${sourceSessionId}-${targetSessionId}`,
        sourceSessionId,
        targetSessionId,
      }
      if (!bind) return { ...payload, copied: false, error: 'workspace offline' }
      return await dispatchDirectTool<CopyOverflowSessionResult>(
        bind,
        workspaceId,
        '__fs_copy_overflow_session',
        payload as unknown as Record<string, unknown>,
        (msg) => ({ ...payload, copied: false, error: msg }),
      )
    },
    async deleteOverflowSession(workspaceId, sessionId) {
      const bind = findBindByWorkspace(workspaceId)
      const payload: DeleteOverflowSession = {
        requestId: `${Date.now()}-${sessionId}`,
        sessionId,
      }
      if (!bind) return { ...payload, deleted: false, error: 'workspace offline' }
      return await dispatchDirectTool<DeleteOverflowSessionResult>(
        bind,
        workspaceId,
        '__fs_delete_overflow_session',
        payload as unknown as Record<string, unknown>,
        (msg) => ({ ...payload, deleted: false, error: msg }),
      )
    },
    async listBg(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          tasks: [],
          error: 'workspace offline',
        }
      }
      return await dispatchDirectTool<BgListResult>(
        bind,
        payload.workspaceId,
        '__bg_list',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          tasks: [],
          error: msg,
        }),
      )
    },
    async readBg(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          taskId: payload.taskId,
          content: '',
          nextOffset: 0,
          done: true,
          status: 'exited',
          bytesTruncated: 0,
          error: 'workspace offline',
        }
      }
      return await dispatchDirectTool<BgOutputResult>(
        bind,
        payload.workspaceId,
        '__bg_output',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          taskId: payload.taskId,
          content: '',
          nextOffset: 0,
          done: true,
          status: 'exited',
          bytesTruncated: 0,
          error: msg,
        }),
      )
    },
    async killBg(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          taskId: payload.taskId,
          killed: false,
          error: 'workspace offline',
        }
      }
      return await dispatchDirectTool<BgKillResult>(
        bind,
        payload.workspaceId,
        '__bg_kill',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          taskId: payload.taskId,
          killed: false,
          error: msg,
        }),
      )
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

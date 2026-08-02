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
  WorkspaceExecRequest,
  WorkspaceExecResponse,
  WorkspaceReadBinaryRequest,
  WorkspaceReadBinaryResponse,
} from '@agent-kernel/shared/workspace-exec'
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
  ClientReadOverflow,
  ClientTerminalCreate,
  ClientTerminalInput,
  ClientTerminalKill,
  ClientTerminalResize,
  CopyOverflowSession,
  CopyOverflowSessionResult,
  DeleteOverflowSession,
  DeleteOverflowSessionResult,
  DirListResult,
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  FileListResult,
  OverflowContentsResult,
  ServerExecutorChangedPayload,
  TerminalCreateResult,
  TerminalKillResult,
  ToolResultAck,
} from '@agent-kernel/shared'

import type { ToolDispatcher } from '../loop.js'
import type { AuditLogger } from '../audit-log.js'

export const DEFAULT_TOOL_ACK_TIMEOUT_MS = 60_000

/**
 * How long to hold a detached executor's pending calls and its "attached"
 * state visible to dashboards, waiting for the process to reconnect with the
 * same workspaceId. Covers routine executor restarts (systemd/tmux respawn,
 * user Ctrl+C+re-run, transient socket drops) so in-flight tool calls survive
 * and the UI doesn't flicker offline.
 */
export const DETACH_GRACE_MS = 5_000

type Pending = {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string
  resolve: (result: { ok: boolean; content: string }) => void
  timer: NodeJS.Timeout
  deadlineAt: number
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
  readOverflow(payload: ClientReadOverflow, workspaceId: string): Promise<OverflowContentsResult>
  copyOverflowSession(workspaceId: string, sourceSessionId: string, targetSessionId: string): Promise<CopyOverflowSessionResult>
  deleteOverflowSession(workspaceId: string, sessionId: string): Promise<DeleteOverflowSessionResult>
  listBg(payload: ClientListBgTasks): Promise<BgListResult>
  readBg(payload: ClientReadBgOutput): Promise<BgOutputResult>
  killBg(payload: ClientKillBgTask): Promise<BgKillResult>
  createTerminal(payload: ClientTerminalCreate): Promise<TerminalCreateResult>
  inputTerminal(payload: ClientTerminalInput): void
  resizeTerminal(payload: ClientTerminalResize): void
  killTerminal(payload: ClientTerminalKill): Promise<TerminalKillResult>
  workspaceExec(payload: WorkspaceExecRequest): Promise<WorkspaceExecResponse>
  workspaceReadBinary(payload: WorkspaceReadBinaryRequest): Promise<WorkspaceReadBinaryResponse>
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
  activeSessions(): string[]
  snapshot(): AttachedExecutor[]
  renameWorkspace(workspaceId: string, workspaceName: string): AttachedExecutor | undefined
  onChange(listener: ExecutorChangeListener): () => void
}

export function createExecutorRegistry(
  _io: Server,
  resolver: WorkspaceResolver,
  toolAckTimeoutMs = DEFAULT_TOOL_ACK_TIMEOUT_MS,
  audit?: AuditLogger,
  detachGraceMs = DETACH_GRACE_MS,
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

  /**
   * Workspaces whose executor socket just went away but where we're still
   * within the grace window. Pending calls are kept in `bind.pending` so a
   * fast reconnect can pick them up via `redispatchPending`. Keyed by
   * workspaceId so a restarted process with a fresh executorId can find its
   * predecessor.
   */
  type Detaching = { bind: Bind; timer: NodeJS.Timeout }
  const detaching = new Map<string, Detaching>()

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
      const ackTimeoutMs = ackTimeoutMsFor(p.name, p.input, toolAckTimeoutMs)
      // Preserve the original absolute deadline. A reconnect must not grant a
      // fresh timeout window; repeated network flaps would otherwise keep an
      // orphaned tool call pending forever.
      const remainingMs = Math.max(0, p.deadlineAt - Date.now())
      const timer = setTimeout(() => {
        if (newBind.pending.delete(p.callId)) {
          p.resolve({
            ok: false,
            content: `tool call ack timed out after ${ackTimeoutMs}ms (post-reconnect)`,
          })
        }
      }, remainingMs)
      newBind.pending.set(p.callId, {
        sessionId: p.sessionId,
        callId: p.callId,
        name: p.name,
        input: p.input,
        ...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
        resolve: p.resolve,
        timer,
        deadlineAt: p.deadlineAt,
      })
      newBind.socket.emit(
        'tool:call',
        {
          sessionId: p.sessionId,
          callId: p.callId,
          name: p.name,
          input: p.input,
          ...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
          ackTimeoutMs,
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

  function allPendingBinds(): Iterable<Bind> {
    return (function* () {
      yield* byExecutor.values()
      for (const entry of detaching.values()) yield entry.bind
    })()
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
   * Host-initiated internal tool RPC. Sent as an ordinary `tool:call`; the
   * executor runs the tool identically to a kernel-initiated call, while host
   * keeps the result out of the kernel FSM and returns it to the caller.
   */
  function callInternalTool<T>(
    bind: Bind,
    workspaceId: string,
    name: string,
    input: Record<string, unknown>,
    onError: (msg: string) => T,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const callId = `direct-${Math.random().toString(36).slice(2, 10)}`
      const timer = setTimeout(() => {
        resolve(onError(`${name} ack timed out after ${toolAckTimeoutMs}ms`))
        audit?.log({ action: 'internal_tool.result', actor: { kind: 'system' }, target: { workspaceId, callId, toolName: name }, outcome: 'error', error: 'timeout' })
      }, toolAckTimeoutMs)
      // sessionId here is a routing convenience for executor-side overflow
      // paths and audit correlation. It never mutates a real session.
      bind.socket.emit(
        'tool:call',
        {
          sessionId: `__internal:${workspaceId}`,
          callId,
          name,
          input,
          ackTimeoutMs: toolAckTimeoutMs,
        },
        (ack: ToolResultAck) => {
          clearTimeout(timer)
          audit?.log({ action: 'internal_tool.result', actor: { kind: 'system' }, target: { workspaceId, callId, toolName: name }, outcome: ack.ok ? 'ok' : 'error', metadata: { contentBytes: Buffer.byteLength(ack.content, 'utf8') }, ...(ack.ok ? {} : { error: ack.content.slice(0, 200) }) })
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

      // Case 1b: an earlier bind for this workspaceId is inside the detach
      // grace window (process restarted with a fresh executorId, or the
      // socket dropped and reconnected before the timer fired). Cancel the
      // pending detach, move any in-flight pending calls to the new bind,
      // and surface the swap as `updated` — the dashboard never sees a
      // detach flicker.
      const pendingDetach = detaching.get(workspaceId)
      if (pendingDetach) {
        clearTimeout(pendingDetach.timer)
        detaching.delete(workspaceId)
        redispatchPending(pendingDetach.bind, newBind)
        byExecutor.set(executorId, newBind)
        socketToExecutor.set(socket.id, executorId)
        emitChange({
          change: 'updated',
          executorId,
          executor: toAttached(newBind),
        })
        return
      }

      // Case 2: different executorId but same workspaceId AND the previous
      // claimant is still actively attached (no detach in flight). A
      // *different* process is claiming the same workspace — duplicate
      // `~/.agent-kernel/workspace-id` copied to another machine, or two
      // processes racing before the local lockfile takes effect.
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
      const workspaceId = bind.announcement.workspaceId

      // Move the bind out of the active registry and into the grace window.
      // We keep `bind.pending` intact so `redispatchPending` can resurrect
      // in-flight tool calls if the executor reconnects within DETACH_GRACE_MS.
      // Routing (findBindByWorkspace / pickBindFor) skips detaching binds —
      // new tool calls fail with "workspace offline" until reconnect.
      byExecutor.delete(executorId)
      socketToExecutor.delete(socket.id)
      const prior = detaching.get(workspaceId)
      if (prior) {
        clearTimeout(prior.timer)
        synthesizeFailure(prior.bind, 'executor disconnected')
      }
      const timer = setTimeout(() => {
        detaching.delete(workspaceId)
        synthesizeFailure(bind, 'executor disconnected')
        emitChange({
          change: 'detached',
          executorId,
        })
      }, detachGraceMs)
      detaching.set(workspaceId, { bind, timer })
    },
    async callTool(sessionId, eff: CallToolEffect) {
      const picked = pickBindFor(sessionId)
      if (!picked.ok) return { ok: false, content: picked.reason }
      const bind = picked.bind
      const ackTimeoutMs = ackTimeoutMsFor(eff.name, eff.input, toolAckTimeoutMs)
      audit?.log({ action: 'tool.dispatch', actor: { kind: 'system' }, target: { sessionId, workspaceId: bind.announcement.workspaceId, callId: eff.callId, toolName: eff.name }, outcome: 'ok', metadata: { cwd: eff.cwd } })
      return await new Promise<{ ok: boolean; content: string }>((resolve) => {
        const deadlineAt = Date.now() + ackTimeoutMs
        const timer = setTimeout(() => {
          if (bind.pending.delete(eff.callId)) {
            audit?.log({ action: 'tool.result', actor: { kind: 'executor', executorId: bind.announcement.executorId, workspaceId: bind.announcement.workspaceId }, target: { sessionId, callId: eff.callId, toolName: eff.name }, outcome: 'error', error: 'timeout' })
            resolve({
              ok: false,
              content: `tool call ack timed out after ${ackTimeoutMs}ms`,
            })
          }
        }, ackTimeoutMs)
        bind.pending.set(eff.callId, {
          sessionId,
          callId: eff.callId,
          name: eff.name,
          input: eff.input,
          ...(eff.cwd !== undefined ? { cwd: eff.cwd } : {}),
          resolve,
          timer,
          deadlineAt,
        })
        bind.socket.emit(
          'tool:call',
          {
            sessionId,
            callId: eff.callId,
            name: eff.name,
            input: eff.input,
            ...(eff.cwd !== undefined ? { cwd: eff.cwd } : {}),
            ackTimeoutMs,
          },
          (ack: ToolResultAck) => {
            const pending = bind.pending.get(ack.callId)
            if (!pending) return
            clearTimeout(pending.timer)
            bind.pending.delete(ack.callId)
            audit?.log({ action: 'tool.result', actor: { kind: 'executor', executorId: bind.announcement.executorId, workspaceId: bind.announcement.workspaceId }, target: { sessionId, callId: ack.callId, toolName: eff.name }, outcome: ack.ok ? 'ok' : 'error', metadata: { contentBytes: Buffer.byteLength(ack.content, 'utf8') }, ...(ack.ok ? {} : { error: ack.content.slice(0, 200) }) })
            pending.resolve({ ok: ack.ok, content: ack.content })
          },
        )
      })
    },
    cancelPending(sessionId) {
      // Detached binds retain calls during the reconnect grace window. They
      // must remain cancellable or a cancelled call can be redispatched when
      // the executor returns. Emitting to a disconnected socket is harmless;
      // resolving/removing the pending entry is the authoritative action.
      for (const bind of allPendingBinds()) {
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
      for (const bind of allPendingBinds()) {
        for (const p of bind.pending.values()) out.add(p.sessionId)
      }
      return [...out]
    },
    snapshot() {
      return [...byExecutor.values()].map(toAttached)
    },
    renameWorkspace(workspaceId, workspaceName) {
      const bind = findBindByWorkspace(workspaceId)
      if (!bind) return undefined
      bind.announcement = { ...bind.announcement, workspaceName }
      const executor = toAttached(bind)
      emitChange({
        change: 'updated',
        executorId: bind.announcement.executorId,
        executor,
      })
      return executor
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
      return await callInternalTool<DirListResult>(
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
      return await callInternalTool<FileListResult>(
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
      return await callInternalTool<OverflowContentsResult>(
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
      return await callInternalTool<CopyOverflowSessionResult>(
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
      return await callInternalTool<DeleteOverflowSessionResult>(
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
          sessionId: payload.sessionId,
          tasks: [],
          error: 'workspace offline',
        }
      }
      return await callInternalTool<BgListResult>(
        bind,
        payload.workspaceId,
        '__bg_list',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
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
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          content: '',
          nextOffset: 0,
          done: true,
          status: 'exited',
          bytesTruncated: 0,
          error: 'workspace offline',
        }
      }
      return await callInternalTool<BgOutputResult>(
        bind,
        payload.workspaceId,
        '__bg_output',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
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
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          killed: false,
          error: 'workspace offline',
        }
      }
      return await callInternalTool<BgKillResult>(
        bind,
        payload.workspaceId,
        '__bg_kill',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          killed: false,
          error: msg,
        }),
      )
    },
    async createTerminal(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          error: 'workspace offline',
        }
      }
      return await new Promise<TerminalCreateResult>((resolve) => {
        bind.socket.emit('terminal:create', payload, (result) => resolve(result))
      })
    },
    inputTerminal(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      bind?.socket.emit('terminal:input', payload)
    },
    resizeTerminal(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      bind?.socket.emit('terminal:resize', payload)
    },
    async killTerminal(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          workspaceId: payload.workspaceId,
          sessionId: payload.sessionId,
          terminalId: payload.terminalId,
          killed: false,
          error: 'workspace offline',
        }
      }
      return await new Promise<TerminalKillResult>((resolve) => {
        bind.socket.emit('terminal:kill', payload, (result) => resolve(result))
      })
    },
    async workspaceExec(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          stdout: '',
          stderr: '',
          exitCode: null,
          durationMs: 0,
          error: { code: 'EACCES', message: 'workspace offline' },
        }
      }
      return await callInternalTool<WorkspaceExecResponse>(
        bind,
        payload.workspaceId,
        '__workspace_exec',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          stdout: '',
          stderr: '',
          exitCode: null,
          durationMs: 0,
          error: { code: 'EIO', message: msg },
        }),
      )
    },
    async workspaceReadBinary(payload) {
      const bind = findBindByWorkspace(payload.workspaceId)
      if (!bind) {
        return {
          requestId: payload.requestId,
          base64: '',
          mime: 'application/octet-stream',
          size: 0,
          error: { code: 'EACCES', message: 'workspace offline' },
        }
      }
      return await callInternalTool<WorkspaceReadBinaryResponse>(
        bind,
        payload.workspaceId,
        '__workspace_read_binary',
        payload as unknown as Record<string, unknown>,
        (msg) => ({
          requestId: payload.requestId,
          base64: '',
          mime: 'application/octet-stream',
          size: 0,
          error: { code: 'EIO', message: msg },
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

function ackTimeoutMsFor(
  toolName: string,
  input: Record<string, unknown>,
  defaultAckTimeoutMs: number,
): number {
  if (toolName !== 'bash') return defaultAckTimeoutMs
  if (input['run_in_background'] === true) return defaultAckTimeoutMs
  const toolTimeoutMs = bashToolTimeoutMs(input)
  if (toolTimeoutMs === undefined) return defaultAckTimeoutMs
  return Math.max(defaultAckTimeoutMs, toolTimeoutMs + Math.min(Math.max(Math.round(toolTimeoutMs * 0.1), 5_000), 60_000))
}

function bashToolTimeoutMs(input: Record<string, unknown>): number | undefined {
  const seconds = positiveInt(input['timeout_seconds']) ?? positiveInt(input['timeoutSeconds'])
  if (seconds !== undefined) return seconds * 1000
  return positiveInt(input['timeout_ms']) ?? positiveInt(input['timeoutMs'])
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

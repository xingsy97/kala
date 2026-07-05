/**
 * Executor connection tracking + tool dispatch bridge.
 *
 * An executor is a daemon: it announces once (with a stable `workspaceId`),
 * then serves `tool:call`s for any session the host routes to it. The
 * registry maps `executorId  -  Bind`, with per-session pending call lists
 * inside each Bind (so cancel/redispatch can iterate one session at a time
 * without touching unrelated sessions).
 *
 * Routing: each session carries a `workspaceId` (set at create time from the
 * "New" flow, see ADR 0014). `callTool` matches that workspaceId against a
 * live executor's announced workspaceId. If none is attached, the call fails
 * loudly  -  sessions do not "fall over" to a different machine. Sessions
 * predating the workspaceId field pass undefined and get the first available
 * executor as a legacy fallback.
 */

import type { Server, Socket } from 'socket.io'

import type {
  CallToolEffect,
} from '@agent-kernel/kernel'
import type {
  AttachedExecutor,
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ExecutorToolResult,
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
    /** callId  -  Pending. Session is inside Pending  -  one flat map is enough for O(1) fulfill. */
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
   * same sessionId in the payload  -  the daemon doesn't know or care which
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

  /**
   * Sessions predating the workspaceId field carry no target. Route them to
   * whichever executor is online. Kept only for legacy JSONL headers  -  new
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
        reason: `workspace ${targetWorkspace} is offline  -  start its executor to run tools`,
      }
    return { ok: true, bind }
  }

  return {
    attach(socket, announcement, clientVersion) {
      const executorId = announcement.executorId
      const existing = byExecutor.get(executorId)
      const bind: Bind = {
        socket,
        announcement,
        attachedAt: new Date().toISOString(),
        pending: new Map(),
        ...(clientVersion !== undefined ? { clientVersion } : {}),
      }
      if (existing) {
        // Same executor, new socket: reconnect. Preserve outstanding calls.
        socketToExecutor.delete(existing.socket.id)
        redispatchPending(existing, bind)
      }
      byExecutor.set(executorId, bind)
      socketToExecutor.set(socket.id, executorId)
      emitChange({
        change: existing ? 'updated' : 'attached',
        executorId,
        executor: toAttached(bind),
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
      // executor  -  but calls are still scoped per-session inside each bind.
      for (const bind of byExecutor.values()) {
        for (const p of bind.pending.values()) {
          if (p.sessionId !== sessionId) continue
          bind.socket.emit('tool:cancel', { sessionId, callId: p.callId })
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
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

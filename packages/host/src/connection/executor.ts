/**
 * Executor connection tracking + tool dispatch bridge.
 *
 * Each session may have (at most) one executor connected. The connection
 * layer stores the socket, exposes a `callTool` that resolves when the
 * executor ACKs, and cleans up on disconnect (synthesizing failure
 * `tool_result`s for anything still outstanding).
 */

import type { Server, Socket } from 'socket.io'

import type {
  CallToolEffect,
} from '@agent-kernel/kernel'
import type {
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ExecutorToolResult,
  ToolResultAck,
} from '@agent-kernel/shared'

import type { ToolDispatcher } from '../loop.js'

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000

type Pending = {
  callId: string
  name: string
  input: Record<string, unknown>
  resolve: (result: { ok: boolean; content: string }) => void
  timer: NodeJS.Timeout
}

export type ExecutorRegistry = ToolDispatcher & {
  attach(
    sessionId: string,
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >,
    announcement: ExecutorAnnounce,
  ): void
  detach(
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >,
  ): void
  fulfill(sessionId: string, result: ExecutorToolResult): void
  activeSessions(): string[]
}

export function createExecutorRegistry(
  _io: Server,
  toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
): ExecutorRegistry {
  type Bind = {
    socket: Socket<
      ExecutorClientToServerEvents,
      ExecutorServerToClientEvents
    >
    announcement: ExecutorAnnounce
    pending: Map<string, Pending>
  }
  const bySession = new Map<string, Bind>()
  const socketToSession = new Map<string, string>()

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
   * timeout window restarts from the reconnect  -  otherwise a slow reconnect
   * would immediately time out every in-flight call.
   *
   * Because we now capture (name, input) at dispatch time, the new executor
   * can actually re-run the call. If the old executor is still alive and
   * eventually delivers a `tool_result` first, the fulfill path drains the
   * pending entry and the redispatched call becomes a no-op ACK (see the
   * ack callback below, which checks `bind.pending.get(...)` before
   * resolving).
   */
  function redispatchPending(oldBind: Bind, newBind: Bind, sessionId: string): void {
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
        callId: p.callId,
        name: p.name,
        input: p.input,
        resolve: p.resolve,
        timer,
      })
      newBind.socket.emit(
        'tool:call',
        {
          sessionId,
          callId: p.callId,
          name: p.name,
          input: p.input,
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

  return {
    attach(sessionId, socket, announcement) {
      const existing = bySession.get(sessionId)
      const bind: Bind = {
        socket,
        announcement,
        pending: new Map(),
      }
      if (existing) {
        // Same session, new socket: reconnect. Preserve outstanding calls
        // so the kernel doesn't see a wave of `tool_result{ok:false}` just
        // because the network blipped. The old socket's `disconnect` will
        // fire; by then we've unregistered its socketToSession entry so
        // detach() becomes a no-op.
        socketToSession.delete(existing.socket.id)
        redispatchPending(existing, bind, sessionId)
      }
      bySession.set(sessionId, bind)
      socketToSession.set(socket.id, sessionId)
    },
    detach(socket) {
      const sessionId = socketToSession.get(socket.id)
      if (!sessionId) return
      const bind = bySession.get(sessionId)
      if (!bind || bind.socket.id !== socket.id) return
      synthesizeFailure(bind, 'executor disconnected')
      bySession.delete(sessionId)
      socketToSession.delete(socket.id)
    },
    fulfill(sessionId, result) {
      const bind = bySession.get(sessionId)
      if (!bind) return
      const pending = bind.pending.get(result.callId)
      if (!pending) return
      clearTimeout(pending.timer)
      bind.pending.delete(result.callId)
      pending.resolve({ ok: result.ok, content: result.content })
    },
    async callTool(sessionId, eff: CallToolEffect) {
      const bind = bySession.get(sessionId)
      if (!bind) {
        return { ok: false, content: 'no executor connected for this session' }
      }
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
          callId: eff.callId,
          name: eff.name,
          input: eff.input,
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
      const bind = bySession.get(sessionId)
      if (!bind) return
      for (const p of bind.pending.values()) {
        bind.socket.emit('tool:cancel', { sessionId, callId: p.callId })
      }
    },
    activeSessions() {
      return [...bySession.keys()]
    },
  }
}

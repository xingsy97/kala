/**
 * Executor Socket.IO namespace wiring.
 *
 * An executor is a daemon: it announces once (with a stable `workspaceId`)
 * and then serves `tool:call` messages routed to it by the host. There is
 * no per-session subscription  -  one executor may serve many sessions whose
 * `workspaceId` matches its announced id.
 */

import type {
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ExecutorToolResult,
  HandshakeAuth,
  ServerBgTaskEvicted,
  ServerBgTaskUpdated,
  SessionErrorScope,
} from '@agent-kernel/shared'
import { isCompatibleVersion } from '@agent-kernel/shared'
import type { AgentConfig } from '@agent-kernel/kernel'
import type { Namespace } from 'socket.io'

import { SessionStore } from '../store/session.js'
import { createExecutorRegistry } from './executor.js'
import type { DashboardNs } from './dashboard-ns.js'

export type ExecutorNs = Namespace<
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents
>

export type ExecutorDeps = {
  store: SessionStore
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig
  authToken?: string
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
  /**
   * Dashboard namespace used to fan out background-task push events into
   * per-workspace rooms. When a dashboard subscribes to `workspace:<id>`,
   * it receives `server:bg_task_updated` / `server:bg_task_evicted` for
   * every task running on that workspace's executor.
   */
  dashboardNs: DashboardNs
}

export function configureExecutorNamespace(
  ns: ExecutorNs,
  deps: ExecutorDeps,
): void {
  ns.use((socket, nextFn) => {
    const auth = socket.handshake.auth as HandshakeAuth | undefined
    if (!auth || auth.role !== 'executor') {
      nextFn(new Error('role_mismatch'))
      return
    }
    if (typeof auth.clientVersion !== 'string' || !isCompatibleVersion(auth.clientVersion)) {
      nextFn(new Error('version_incompatible'))
      return
    }
    if (deps.authToken && auth.token !== deps.authToken) {
      nextFn(new Error('auth_failed'))
      return
    }
    nextFn()
  })

  ns.on('connection', (socket) => {
    const auth = socket.handshake.auth as HandshakeAuth
    // An executor is a daemon: no session binding at connect time. Host
    // routes each `tool:call` to it by sessionId when needed.
    socket.on('executor:announce', (payload: ExecutorAnnounce) => {
      deps.executors.attach(socket, payload, auth.clientVersion)
    })
    socket.on('executor:tool_result', (payload: ExecutorToolResult) => {
      deps.executors.fulfill(payload.sessionId, payload)
    })
    socket.on('executor:bg_task_updated', (payload: ServerBgTaskUpdated) => {
      deps.dashboardNs
        .to(`workspace:${payload.workspaceId}`)
        .emit('server:bg_task_updated', payload)
    })
    socket.on('executor:bg_task_evicted', (payload: ServerBgTaskEvicted) => {
      deps.dashboardNs
        .to(`workspace:${payload.workspaceId}`)
        .emit('server:bg_task_evicted', payload)
    })
    socket.on('disconnect', () => {
      deps.executors.detach(socket)
    })
  })
}

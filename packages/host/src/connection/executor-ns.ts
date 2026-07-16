/**
 * Executor Socket.IO namespace wiring.
 *
 * An executor is a daemon: it announces once (with a stable `workspaceId`)
 * and then serves `tool:call` messages routed to it by the host. There is
 * no per-session subscription — one executor may serve many sessions whose
 * `workspaceId` matches its announced id.
 */

import type {
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  HandshakeAuth,
  ServerBgTaskEvicted,
  ServerBgTaskUpdated,
  SessionErrorScope,
} from '@agent-kernel/shared'
import { isCompatibleVersion, schema } from '@agent-kernel/shared'
import type { AgentConfig } from '@agent-kernel/kernel'
import type { Namespace } from 'socket.io'

import { SessionStore } from '../store/session.js'
import { createExecutorRegistry } from './executor.js'
import type { DashboardNs } from './dashboard-ns.js'
import type { AuthConfig, ExecutorIdentity } from '../auth-control.js'
import { authenticateExecutorToken, validateExecutorAnnouncement } from '../auth-control.js'
import type { AuditLogger } from '../audit-log.js'
import { parseWire } from '../wire-validation.js'

export type ExecutorNs = Namespace<
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents
>

export type ExecutorDeps = {
  store: SessionStore
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig | (() => AgentConfig)
  auth?: AuthConfig
  audit?: AuditLogger
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
  /**
   * Dashboard namespace used to fan out background-task push events into
   * per-session rooms. Background tasks physically run in a workspace
   * executor but are owned by the session that spawned them.
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
    const identity = authenticateExecutorToken(auth, deps.auth)
    if (!identity.accepted) {
      deps.audit?.log({ action: 'executor.socket_reject', actor: { kind: 'anonymous' }, outcome: 'denied', error: identity.reason ?? 'auth_failed' })
      nextFn(new Error(identity.reason ?? 'auth_failed'))
      return
    }
    socket.data.executorIdentity = identity
    deps.audit?.log({ action: 'executor.socket_accept', actor: { kind: 'token', ...(identity.label ? { label: identity.label } : {}) }, outcome: 'ok', metadata: { scopedWorkspaceId: identity.workspaceId } })
    nextFn()
  })

  ns.on('connection', (socket) => {
    const auth = socket.handshake.auth as HandshakeAuth
    // An executor is a daemon: no session binding at connect time. Host
    // routes each `tool:call` to it by sessionId when needed.
    socket.on('executor:announce', (rawPayload: ExecutorAnnounce) => {
      const payload = parseWire(schema.ExecutorAnnounceSchema, rawPayload, {
        channel: 'executor:announce',
        peer: socket.id,
      })
      if (!payload) return
      const identity = socket.data.executorIdentity as ExecutorIdentity | undefined
      const valid = validateExecutorAnnouncement(identity ?? { accepted: true }, payload.workspaceId)
      if (!valid.ok) {
        deps.audit?.log({ action: 'executor.announce_reject', actor: { kind: 'executor', executorId: payload.executorId, workspaceId: payload.workspaceId, ...(identity?.label ? { label: identity.label } : {}) }, target: { workspaceId: payload.workspaceId }, outcome: 'denied', error: valid.reason })
        const code: 'workspace_identity_mismatch' | 'auth_failed' =
          valid.reason === 'workspace_identity_mismatch' ? 'workspace_identity_mismatch' : 'auth_failed'
        socket.emit('executor:host_reject', {
          code,
          message: valid.reason,
        })
        socket.disconnect(true)
        return
      }
      if (identity?.inviteToken) {
        const bound = deps.auth?.executorIdentityStore?.consumeInvite(identity.inviteToken, payload.workspaceId, payload.workspaceName)
        if (!bound?.ok) {
          const reason = bound?.reason ?? 'invalid_invite'
          deps.audit?.log({ action: 'executor.invite_reject', actor: { kind: 'executor', executorId: payload.executorId, workspaceId: payload.workspaceId }, target: { workspaceId: payload.workspaceId }, outcome: 'denied', error: reason })
          socket.emit('executor:host_reject', { code: 'auth_failed', message: reason })
          socket.disconnect(true)
          return
        }
        socket.emit('executor:welcome', { token: bound.token, workspaceId: payload.workspaceId })
        socket.data.executorIdentity = { accepted: true, token: bound.token, workspaceId: payload.workspaceId, label: payload.workspaceName }
        deps.audit?.log({ action: 'executor.invite_bound', actor: { kind: 'executor', executorId: payload.executorId, workspaceId: payload.workspaceId }, target: { workspaceId: payload.workspaceId }, outcome: 'ok' })
      } else if (identity?.token) {
        deps.auth?.executorIdentityStore?.markSeen(identity.token)
      }
      deps.audit?.log({ action: 'executor.announce_accept', actor: { kind: 'executor', executorId: payload.executorId, workspaceId: payload.workspaceId, ...(identity?.label ? { label: identity.label } : {}) }, target: { workspaceId: payload.workspaceId }, outcome: 'ok', metadata: { workspaceName: payload.workspaceName } })
      deps.executors.attach(socket, payload, auth.clientVersion)
    })
    socket.on('executor:bg_task_updated', (rawPayload: ServerBgTaskUpdated) => {
      const payload = parseWire(schema.ServerBgTaskUpdatedSchema, rawPayload, {
        channel: 'executor:bg_task_updated',
        peer: socket.id,
      })
      if (!payload) return
      const room = `session:${payload.sessionId}`
      deps.dashboardNs.to(room).emit('server:bg_task_updated', payload)
      deps.dashboardNs.to(room).emit('server:control_update', {
        kind: 'bg_task_updated',
        ...payload,
      })
    })
    socket.on('executor:tool_progress', (rawPayload) => {
      const payload = parseWire(schema.ToolProgressPayloadSchema, rawPayload, {
        channel: 'executor:tool_progress',
        peer: socket.id,
      })
      if (!payload) return
      deps.dashboardNs
        .to(`session:${payload.sessionId}`)
        .emit('server:control_update', {
          kind: 'tool_progress',
          ...payload,
        })
    })
    socket.on('executor:bg_task_evicted', (rawPayload: ServerBgTaskEvicted) => {
      const payload = parseWire(schema.ServerBgTaskEvictedSchema, rawPayload, {
        channel: 'executor:bg_task_evicted',
        peer: socket.id,
      })
      if (!payload) return
      const room = `session:${payload.sessionId}`
      deps.dashboardNs.to(room).emit('server:bg_task_evicted', payload)
      deps.dashboardNs.to(room).emit('server:control_update', {
        kind: 'bg_task_evicted',
        ...payload,
      })
    })
    socket.on('disconnect', () => {
      deps.executors.detach(socket)
    })
  })
}

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
  ServerTerminalExit,
  ServerTerminalOutput,
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
import { sessionRoom } from './rooms.js'
import { executorAnnouncedConnectionMeta, executorPendingConnectionMeta, type ConnectionMeta } from './socket-metadata.js'
import type { ExecutorInstallationStore } from '../store/executor-installation.js'

export type ExecutorNs = Namespace<
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents
>

export type ExecutorDeps = {
  store: SessionStore
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig | (() => AgentConfig)
  auth?: AuthConfig
  installations?: ExecutorInstallationStore
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
  const executorIdentities = new WeakMap<object, ExecutorIdentity>()
  const executorAnnouncements = new WeakMap<object, ExecutorAnnounce>()
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
    executorIdentities.set(socket, identity)
    socket.data.executorIdentity = publicExecutorIdentity(identity)
    const connectionMeta = executorPendingConnectionMeta({ clientVersion: auth.clientVersion })
    socket.data.connectionMeta = connectionMeta
    deps.audit?.log({ action: 'executor.socket_accept', actor: { kind: 'token', ...(identity.label ? { label: identity.label } : {}) }, outcome: 'ok', metadata: { ...auditConnectionMeta(connectionMeta), scopedWorkspaceId: identity.workspaceId } })
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
      const identity = executorIdentities.get(socket)
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
        const nextIdentity = { accepted: true, token: bound.token, workspaceId: payload.workspaceId, label: payload.workspaceName }
        executorIdentities.set(socket, nextIdentity)
        socket.data.executorIdentity = publicExecutorIdentity(nextIdentity)
        deps.audit?.log({ action: 'executor.invite_bound', actor: { kind: 'executor', executorId: payload.executorId, workspaceId: payload.workspaceId }, target: { workspaceId: payload.workspaceId }, outcome: 'ok' })
      } else if (identity?.token) {
        deps.auth?.executorIdentityStore?.markSeen(identity.token)
      }
      const connectionMeta = executorAnnouncedConnectionMeta({
        current: socket.data.connectionMeta as ConnectionMeta | undefined,
        announcement: payload,
        clientVersion: auth.clientVersion,
      })
      socket.data.connectionMeta = connectionMeta
      deps.audit?.log({ action: 'executor.announce_accept', actor: { kind: 'executor', executorId: payload.executorId, workspaceId: payload.workspaceId, ...(identity?.label ? { label: identity.label } : {}) }, target: { workspaceId: payload.workspaceId }, outcome: 'ok', metadata: { ...auditConnectionMeta(connectionMeta), workspaceName: payload.workspaceName } })
      executorAnnouncements.set(socket, payload)
      deps.executors.attach(socket, payload, auth.clientVersion)
      const installId = payload.installId ?? auth.installId
      if (installId && identity?.token) {
        const completed = deps.installations?.markOnline(installId, payload.workspaceId, {
          executorId: payload.executorId,
          ...(payload.executorVersion ? { executorVersion: payload.executorVersion } : {}),
          workspaceName: payload.workspaceName,
        })
        deps.audit?.log({ action: 'executor_install.online', actor: { kind: 'executor', executorId: payload.executorId, workspaceId: payload.workspaceId }, target: { workspaceId: payload.workspaceId }, outcome: completed ? 'ok' : 'error', metadata: { installId }, ...(completed ? {} : { error: 'installation record did not accept online transition' }) })
        if (!completed) deps.broadcastError(payload.workspaceId, 'host', `Executor connected, but installation ${installId} could not be marked complete. Re-open Add Workspace or reinstall this Executor.`)
      }
    })
    socket.on('executor:bg_task_updated', async (rawPayload: ServerBgTaskUpdated) => {
      const payload = parseWire(schema.ServerBgTaskUpdatedSchema, rawPayload, {
        channel: 'executor:bg_task_updated',
        peer: socket.id,
      })
      if (!payload || !await acceptsExecutorSessionPayload(socket, deps.store, executorAnnouncements, payload.workspaceId, payload.sessionId)) return
      const room = sessionRoom(payload.sessionId)
      deps.dashboardNs.to(room).emit('server:control_update', {
        kind: 'bg_task_updated',
        ...payload,
      })
    })
    socket.on('executor:tool_progress', async (rawPayload) => {
      const payload = parseWire(schema.ToolProgressPayloadSchema, rawPayload, {
        channel: 'executor:tool_progress',
        peer: socket.id,
      })
      if (!payload || !await acceptsExecutorSessionPayload(socket, deps.store, executorAnnouncements, undefined, payload.sessionId)) return
      deps.dashboardNs
        .to(sessionRoom(payload.sessionId))
        .emit('server:control_update', {
          kind: 'tool_progress',
          ...payload,
        })
    })
    socket.on('executor:bg_task_evicted', async (rawPayload: ServerBgTaskEvicted) => {
      const payload = parseWire(schema.ServerBgTaskEvictedSchema, rawPayload, {
        channel: 'executor:bg_task_evicted',
        peer: socket.id,
      })
      if (!payload || !await acceptsExecutorSessionPayload(socket, deps.store, executorAnnouncements, payload.workspaceId, payload.sessionId)) return
      const room = sessionRoom(payload.sessionId)
      deps.dashboardNs.to(room).emit('server:control_update', {
        kind: 'bg_task_evicted',
        ...payload,
      })
    })
    socket.on('executor:terminal_output', async (rawPayload: ServerTerminalOutput) => {
      const payload = parseWire(schema.ServerTerminalOutputSchema, rawPayload, {
        channel: 'executor:terminal_output',
        peer: socket.id,
      })
      if (!payload || !await acceptsExecutorSessionPayload(socket, deps.store, executorAnnouncements, payload.workspaceId, payload.sessionId)) return
      deps.dashboardNs.to(sessionRoom(payload.sessionId)).emit('server:terminal_output', payload)
    })
    socket.on('executor:terminal_exit', async (rawPayload: ServerTerminalExit) => {
      const payload = parseWire(schema.ServerTerminalExitSchema, rawPayload, {
        channel: 'executor:terminal_exit',
        peer: socket.id,
      })
      if (!payload || !await acceptsExecutorSessionPayload(socket, deps.store, executorAnnouncements, payload.workspaceId, payload.sessionId)) return
      deps.dashboardNs.to(sessionRoom(payload.sessionId)).emit('server:terminal_exit', payload)
    })
    socket.on('disconnect', () => {
      deps.executors.detach(socket)
    })
  })
}

async function acceptsExecutorSessionPayload(
  socket: object,
  store: SessionStore,
  announcements: WeakMap<object, ExecutorAnnounce>,
  payloadWorkspaceId: string | undefined,
  sessionId: string,
): Promise<boolean> {
  const announcement = announcements.get(socket)
  if (!announcement || (payloadWorkspaceId !== undefined && payloadWorkspaceId !== announcement.workspaceId)) return false
  const record = store.get(sessionId) ?? await store.load(sessionId).catch(() => undefined)
  return record?.workspaceId === announcement.workspaceId
}

function publicExecutorIdentity(identity: ExecutorIdentity): Record<string, unknown> {
  return {
    accepted: identity.accepted,
    ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
    ...(identity.label ? { label: identity.label } : {}),
    ...(identity.reason ? { reason: identity.reason } : {}),
  }
}

function auditConnectionMeta(meta: ConnectionMeta): Record<string, unknown> {
  return {
    connectionKind: meta.kind,
    connectionLabel: meta.label,
    clientVersion: meta.clientVersion,
  }
}

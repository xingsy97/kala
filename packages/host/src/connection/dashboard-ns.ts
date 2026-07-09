/**
 * Dashboard Socket.IO namespace wiring.
 *
 * One socket per connected browser tab. The connection is bound to a
 * `sessionId` at handshake time (via `auth.sessionId`); the browser sees
 * `session:ready` up front and subscribes to a room named `session:<id>`.
 *
 * Every `client:*` event on this namespace maps to a call into the host
 * loop, the session store, or the executor registry. Nothing here decides
 * *what* the kernel does — that stays in the kernel. This file is protocol
 * mapping only.
 */

import type {
  ClientCancel,
  ClientCancelStream,
  ClientClear,
  ClientCompact,
  ClientConsolidateMemory,
  ClientCreateSession,
  ClientDeleteSession,
  ClientFork,
  ClientGitDiff,
  ClientGitStatus,
  ClientInterruptSubAgent,
  ClientKillBgTask,
  ClientListAgentTypes,
  ClientListBgTasks,
  ClientListDirs,
  ClientListExecutors,
  ClientListFiles,
  ClientListSessions,
  ClientListSubAgents,
  ClientLoadHistory,
  ClientLoadLogArtifact,
  ClientReadBgOutput,
  ClientReadFile,
  ClientReadOverflow,
  ClientDeleteQueuedMessage,
  ClientReorderQueuedMessage,
  ClientRenameWorkspace,
  ClientRenameSession,
  ClientSetApprovalMode,
  ClientSetCwd,
  ClientTerminalCreate,
  ClientTerminalInput,
  ClientTerminalKill,
  ClientTerminalResize,
  ClientUpdateQueuedMessage,
  ClientSubscribe,
  ClientUserApprove,
  ClientUserMessage,
  ClientUserReject,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  EventAppendedEvent,
  HandshakeAuth,
  AttachedExecutor,
  ServerHistoryPayload,
  ServerMessageQueueEvent,
  SessionErrorScope,
  SessionReadyEvent,
  SubAgentSummary,
} from '@agent-kernel/shared'
import { isCompatibleVersion, schema } from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  MessageContent,
} from '@agent-kernel/kernel'
import { createInitialState, fold } from '@agent-kernel/kernel'
import type { Namespace } from 'socket.io'
import { ulid } from 'ulid'

import type { HostLoopDeps, LoopHandle } from '../loop.js'
import { consolidateMemory, type ConsolidationOutcome } from '../extensions/memory-consolidation.js'
import { markSubAgentInterrupted } from '../extensions/agent-tool.js'
import { resetCompactRuntime } from '../extensions/compaction.js'
import { readSessionLog } from '../store/log.js'
import { SessionStore, type SessionRecord } from '../store/session.js'
import { createExecutorRegistry } from './executor.js'
import { dirname, resolve as resolvePath, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AuthConfig } from '../auth-control.js'
import { authenticateDashboardHandshake } from '../auth-control.js'
import type { AuditActor, AuditLogger } from '../audit-log.js'
import { parseWire, type WireValidationContext } from '../wire-validation.js'
import { isSkillManager } from '../extensions/skills.js'
import { contextSnapshot, snapshotFromConfig, type ContextWindowOverride } from '../context/manager.js'
import { sessionRoom } from './rooms.js'
import { dashboardConnectionMeta, type ConnectionMeta } from './socket-metadata.js'

export type QueuedUserMessage = {
  id: string
  text: string
  mode: 'steer' | 'queue'
  createdAt: string
  content?: readonly MessageContent[]
  model?: string
}

export type MessageQueueManager = {
  enqueue(sessionId: string, msg: QueuedUserMessage, priority?: 'front'): void
  reorder(sessionId: string, id: string, beforeId?: string | null): void
  update(sessionId: string, id: string, text: string): void
  delete(sessionId: string, id: string): void
  pending(sessionId: string): number
  snapshot(sessionId: string): ServerMessageQueueEvent
  drain(sessionId: string): Promise<void>
}

export type DashboardNs = Namespace<
  DashboardClientToServerEvents,
  DashboardServerToClientEvents
>

export function isRestingStatus(status: AgentState['status']): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

export type DashboardDeps = {
  store: SessionStore
  loop: LoopHandle
  loopDeps: HostLoopDeps
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig | (() => AgentConfig)
  auth?: AuthConfig
  audit?: AuditLogger
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
  contextWindowForModel?(model: string | undefined): ContextWindowOverride | undefined
  normalizeModelRef?(model: string): string | undefined
  dashboardNs: DashboardNs
  messageQueues: MessageQueueManager
  executorSnapshot?(): readonly AttachedExecutor[]
  onSessionCreated?(record: SessionRecord): void | Promise<void>
  onSessionDeleted?(record: SessionRecord): void | Promise<void>
  renameWorkspace?(workspaceId: string, workspaceName: string): Promise<string>
}

export function configureDashboardNamespace(
  ns: DashboardNs,
  deps: DashboardDeps,
): void {
  const getDefaultConfig = (): AgentConfig => typeof deps.defaultConfig === 'function'
    ? deps.defaultConfig()
    : deps.defaultConfig
  ns.use((socket, nextFn) => {
    const auth = socket.handshake.auth as HandshakeAuth | undefined
    if (!auth || auth.role !== 'dashboard') {
      nextFn(new Error('role_mismatch'))
      return
    }
    if (typeof auth.clientVersion !== 'string' || !isCompatibleVersion(auth.clientVersion)) {
      nextFn(new Error('version_incompatible'))
      return
    }
    const authResult = authenticateDashboardHandshake(auth, socket.request, deps.auth)
    if (!authResult.ok) {
      deps.audit?.log({ action: 'dashboard.socket_reject', actor: { kind: 'anonymous' }, target: { sessionId: auth.sessionId }, outcome: 'denied', error: authResult.reason })
      nextFn(new Error(authResult.reason))
      return
    }
    if (!auth.sessionId) {
      nextFn(new Error('missing_session_id'))
      return
    }
    const connectionMeta = dashboardConnectionMeta({
      actor: authResult.actor,
      clientVersion: auth.clientVersion,
    })
    socket.data.dashboardActor = authResult.actor
    socket.data.connectionMeta = connectionMeta
    deps.audit?.log({ action: 'dashboard.socket_accept', actor: authResult.actor, target: { sessionId: auth.sessionId }, outcome: 'ok', metadata: auditConnectionMeta(connectionMeta) })
    nextFn()
  })

  ns.on('connection', async (socket) => {
    const auth = socket.handshake.auth as HandshakeAuth
    // Middleware guarantees auth.sessionId is present for the dashboard role.
    const sessionId = auth.sessionId!

    // Local `vparse` — closes over `socket.id` + the connected sessionId so
    // handlers can call `vparse(schema.X, raw, 'client:x')` in one line.
    const vparse = <T>(
      s: import('zod').ZodType<T>,
      raw: unknown,
      channel: string,
      overrideSessionId?: string,
    ): T | undefined => {
      const ctx: WireValidationContext = {
        channel,
        peer: socket.id,
        sessionId: overrideSessionId ?? sessionId,
      }
      return parseWire(s, raw, ctx)
    }
    const validateBgSessionAccess = async (targetSessionId: string, workspaceId: string): Promise<string | undefined> => {
      if (targetSessionId !== sessionId) {
        return 'This workspace operation belongs to another session. Switch back to that session and reopen the panel.'
      }
      const record = deps.store.get(targetSessionId) ?? (await deps.store.load(targetSessionId).catch(() => undefined))
      if (!record) return 'unknown session'
      if (record.workspaceId !== workspaceId) return 'session does not belong to workspace'
      return undefined
    }
    const auditScopedAccessDenied = (action: string, targetSessionId: string, workspaceId: string, error: string): void => {
      deps.audit?.log({ action, actor: auditActor(socket), target: { sessionId: targetSessionId, workspaceId }, outcome: 'denied', error })
    }

    // Register first-paint request handlers before any awaited session load.
    // The dashboard emits these immediately after the websocket connects or
    // after `session:ready`; if we install handlers later, those one-shot
    // requests can be lost and the UI stays on "no session selected".
    socket.on('client:list_executors', (raw: ClientListExecutors) => {
      if (!vparse(schema.ClientListExecutorsSchema, raw, 'client:list_executors')) return
      socket.emit('server:executors', { executors: executorSnapshotFor(deps) })
    })

    socket.on('client:list_sessions', async (raw: ClientListSessions) => {
      if (!vparse(schema.ClientListSessionsSchema, raw, 'client:list_sessions')) return
      const sessions = await deps.store.listSummaries()
      socket.emit('server:sessions', { sessions })
    })

    socket.on('client:load_history', async (raw: ClientLoadHistory) => {
      const p = vparse(schema.ClientLoadHistorySchema, raw, 'client:load_history', (raw as ClientLoadHistory | undefined)?.sessionId)
      if (!p) return
      try {
        let target: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!target) {
          try {
            target = await deps.store.load(p.sessionId)
          } catch {
            // Session hasn't been persisted yet — reply with an empty
            // history rather than broadcasting an error the dashboard would
            // render as a red banner. This is the expected state for a
            // freshly-connected new session.
            const empty: ServerHistoryPayload = {
              sessionId: p.sessionId,
              entries: [],
            }
            socket.emit('server:history', empty)
            return
          }
        }
        const parsed = await readSessionLog(target.logPath)
        const since = p.sinceCursor ?? 0
        const entries: EventAppendedEvent[] = parsed.events
          .filter((e) => e.seq > since)
          .map((e) => ({
            sessionId: p.sessionId,
            seq: e.seq,
            ts: e.ts,
            event: e.event,
            effects: e.effects,
            ...(e.effectsArtifact ? { hasEffectsArtifact: true } : {}),
            ...(e.llmTraceArtifact ? { hasLlmTraceArtifact: true } : {}),
            ...(e.llmTrace ? { llmTrace: e.llmTrace } : {}),
            ...(e.model ? { model: e.model } : {}),
          }))
        const payload: ServerHistoryPayload = { sessionId: p.sessionId, entries }
        socket.emit('server:history', payload)
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:load_log_artifact', async (raw: ClientLoadLogArtifact) => {
      const p = vparse(schema.ClientLoadLogArtifactSchema, raw, 'client:load_log_artifact', (raw as ClientLoadLogArtifact | undefined)?.sessionId)
      if (!p) return
      try {
        let target: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!target) target = await deps.store.load(p.sessionId)
        const parsed = await readSessionLog(target.logPath)
        const entry = parsed.events.find((e) => e.seq === p.seq)
        if (!entry) {
          socket.emit('server:log_artifact', { sessionId: p.sessionId, seq: p.seq, error: 'event not found' })
          return
        }
        const payload: { effects?: unknown; llmTrace?: unknown } = {}
        if (entry.effectsArtifact) {
          payload.effects = await readJsonLogArtifact(target.logPath, entry.effectsArtifact.path)
        }
        if (entry.llmTraceArtifact) {
          payload.llmTrace = await readJsonLogArtifact(target.logPath, entry.llmTraceArtifact.path)
        } else if (entry.llmTrace) {
          payload.llmTrace = entry.llmTrace
        }
        socket.emit('server:log_artifact', {
          sessionId: p.sessionId,
          seq: p.seq,
          ...(payload.effects ? { effects: payload.effects as never } : {}),
          ...(payload.llmTrace ? { llmTrace: payload.llmTrace as never } : {}),
        })
      } catch (err) {
        socket.emit('server:log_artifact', {
          sessionId: p.sessionId,
          seq: p.seq,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Do NOT auto-create the session on connect. A dashboard opening a fresh
    // random UUID must not materialize a JSONL file on disk — otherwise
    // "click New" and "delete last session" both silently resurrect an empty
    // session behind the user's back. Lazy-create instead: the first
    // dispatched user event (`client:user_message` / `client:fork`) is what
    // commits a session to disk. Until then the dashboard sees an ephemeral
    // initial state.
    let record: SessionRecord | undefined = deps.store.get(sessionId)
    if (!record) {
      try {
        record = await deps.store.load(sessionId)
      } catch {
        record = undefined
      }
    }
    if (record) await refreshSessionSkillsIfNeeded(deps, record)
    await socket.join(sessionRoom(sessionId))
    const ready: SessionReadyEvent = record
      ? readyEventFor(record, selectedModelForRecord(record), 'load', contextWindowForSession(deps, record))
        : ephemeralReadyEventFor(
          sessionId,
          getDefaultConfig(),
        )
    socket.emit('session:ready', ready)
    socket.emit('server:message_queue', deps.messageQueues.snapshot(sessionId))

    socket.on('subscribe', async (raw: ClientSubscribe) => {
      const p = vparse(schema.ClientSubscribeSchema, raw, 'subscribe', (raw as ClientSubscribe | undefined)?.sessionId)
      if (!p) return
      const { sessionId } = p
      let target = deps.store.get(sessionId)
      if (!target) {
        try {
          target = await deps.store.load(sessionId)
        } catch {
          target = undefined
        }
      }
      if (target) {
        await refreshSessionSkillsIfNeeded(deps, target)
      }
      await socket.join(sessionRoom(sessionId))
      const payload: SessionReadyEvent = target
        ? readyEventFor(target, selectedModelForRecord(target), 'load', contextWindowForSession(deps, target))
        : ephemeralReadyEventFor(
            sessionId,
            getDefaultConfig(),
          )
      socket.emit('session:ready', payload)
      socket.emit('server:message_queue', deps.messageQueues.snapshot(sessionId))
    })

    socket.on('client:user_message', async (raw: ClientUserMessage) => {
      const p = vparse(schema.ClientUserMessageSchema, raw, 'client:user_message', (raw as ClientUserMessage | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.user_message', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { messageBytes: Buffer.byteLength(p.text, 'utf8'), mode: p.mode ?? 'steer' } })
      await handleUserMessage(deps, p)
    })
    socket.on('client:user_approve', async (raw: ClientUserApprove) => {
      const p = vparse(schema.ClientUserApproveSchema, raw, 'client:user_approve', (raw as ClientUserApprove | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.user_approve', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok' })
      const evt: AgentEvent = { kind: 'user_approve', callId: p.callId }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:user_reject', async (raw: ClientUserReject) => {
      const p = vparse(schema.ClientUserRejectSchema, raw, 'client:user_reject', (raw as ClientUserReject | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.user_reject', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok', metadata: { reasonBytes: p.reason ? Buffer.byteLength(p.reason, 'utf8') : 0 } })
      const evt: AgentEvent = {
        kind: 'user_reject',
        callId: p.callId,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:cancel', async (raw: ClientCancel) => {
      const p = vparse(schema.ClientCancelSchema, raw, 'client:cancel', (raw as ClientCancel | undefined)?.sessionId)
      if (!p) return
      const evt: AgentEvent = { kind: 'cancel' }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:interrupt_sub_agent', async (raw: ClientInterruptSubAgent) => {
      const p = vparse(schema.ClientInterruptSubAgentSchema, raw, 'client:interrupt_sub_agent')
      if (!p) return
      try {
        const result = markSubAgentInterrupted(p.parentSessionId, p.parentCallId, p.childSessionId)
        if (!result.ok) {
          deps.broadcastError(p.parentSessionId, 'host', result.error ?? 'sub-agent interrupt failed')
          return
        }
        await deps.loop.dispatch(result.childSessionId, { kind: 'cancel' })
      } catch (err) {
        deps.broadcastError(
          p.parentSessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:clear', async (raw: ClientClear) => {
      const p = vparse(schema.ClientClearSchema, raw, 'client:clear', (raw as ClientClear | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'dashboard.session_clear', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok' })
      deps.loopDeps.tools.cancelPending(p.sessionId)
      deps.loop.cancelStream(p.sessionId)
      const evt: AgentEvent = { kind: 'clear' }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:compact', async (raw: ClientCompact) => {
      const p = vparse(schema.ClientCompactSchema, raw, 'client:compact', (raw as ClientCompact | undefined)?.sessionId)
      if (!p) return
      try {
        let record: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!record) {
          try {
            record = await deps.store.load(p.sessionId)
          } catch {
            record = undefined
          }
        }
        if (!record) {
          deps.broadcastError(
            p.sessionId,
            'host',
            'session not created — nothing to compact',
          )
          return
        }
        await deps.loop.compact(p.sessionId)
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'kernel',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:cancel_stream', (raw: ClientCancelStream) => {
      const p = vparse(schema.ClientCancelStreamSchema, raw, 'client:cancel_stream', (raw as ClientCancelStream | undefined)?.sessionId)
      if (!p) return
      // No error path — cancelStream is a no-op when nothing is streaming.
      // The loop turns the abort into a normal llm_response, so the FSM
      // and log stay coherent without any special-case wiring here.
      deps.loop.cancelStream(p.sessionId)
    })
    socket.on('client:set_approval_mode', async (raw: ClientSetApprovalMode) => {
      const p = vparse(schema.ClientSetApprovalModeSchema, raw, 'client:set_approval_mode', (raw as ClientSetApprovalMode | undefined)?.sessionId)
      if (!p) return
      // Guard rail: `allow_all` may only be set when the operator opted in
      // via env flag on the host. Prevents a compromised dashboard from
      // silently disabling every approval prompt on an unattended session.
      // The other three modes are freely settable.
      if (p.mode === 'allow_all' && process.env.AK_ALLOW_ALL_OK !== '1') {
        deps.audit?.log({ action: 'dashboard.approval_mode_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'denied', metadata: { mode: p.mode }, error: 'AK_ALLOW_ALL_OK is not enabled' })
        deps.broadcastError(
          p.sessionId,
          'host',
          'approval mode "allow_all" requires AK_ALLOW_ALL_OK=1 on the host',
        )
        return
      }
      await safeDispatch(deps, p.sessionId, {
        kind: 'approval_mode_changed',
        mode: p.mode,
      })
      deps.audit?.log({ action: 'dashboard.approval_mode_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { mode: p.mode } })
    })
    socket.on('client:set_cwd', async (raw: ClientSetCwd) => {
      const p = vparse(schema.ClientSetCwdSchema, raw, 'client:set_cwd', (raw as ClientSetCwd | undefined)?.sessionId)
      if (!p) return
      const record = await loadRecordForDashboard(deps, p.sessionId)
      if (!record) {
        deps.broadcastError(p.sessionId, 'host', 'unknown session')
        return
      }
      if (!isRestingStatus(record.state.status)) {
        deps.broadcastError(
          p.sessionId,
          'host',
          `cannot change cwd while session status is ${record.state.status}`,
        )
        return
      }
      const validation = await validateSessionCwd(deps, record, p.cwd)
      if (!validation.ok) {
        deps.audit?.log({ action: 'dashboard.cwd_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'denied', metadata: { cwd: p.cwd }, error: validation.reason })
        deps.broadcastError(p.sessionId, 'host', validation.reason)
        return
      }
      await safeDispatch(deps, p.sessionId, {
        kind: 'cwd_changed',
        cwd: validation.cwd,
      })
      deps.audit?.log({ action: 'dashboard.cwd_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { cwd: validation.cwd } })
      await broadcastSessionList(deps)
    })
    socket.on('client:reorder_queued_message', (raw: ClientReorderQueuedMessage) => {
      const p = vparse(schema.ClientReorderQueuedMessageSchema, raw, 'client:reorder_queued_message', (raw as ClientReorderQueuedMessage | undefined)?.sessionId)
      if (!p) return
      deps.messageQueues.reorder(p.sessionId, p.id, p.beforeId)
    })
    socket.on('client:update_queued_message', (raw: ClientUpdateQueuedMessage) => {
      const p = vparse(schema.ClientUpdateQueuedMessageSchema, raw, 'client:update_queued_message', (raw as ClientUpdateQueuedMessage | undefined)?.sessionId)
      if (!p) return
      deps.messageQueues.update(p.sessionId, p.id, p.text)
    })
    socket.on('client:delete_queued_message', (raw: ClientDeleteQueuedMessage) => {
      const p = vparse(schema.ClientDeleteQueuedMessageSchema, raw, 'client:delete_queued_message', (raw as ClientDeleteQueuedMessage | undefined)?.sessionId)
      if (!p) return
      deps.messageQueues.delete(p.sessionId, p.id)
    })
    socket.on('client:rename_session', async (raw: ClientRenameSession) => {
      const p = vparse(schema.ClientRenameSessionSchema, raw, 'client:rename_session', (raw as ClientRenameSession | undefined)?.sessionId)
      if (!p) return
      try {
        const applied = await deps.store.rename(p.sessionId, p.label)
        deps.dashboardNs.emit('server:control_update', {
          kind: 'session_meta_changed',
          sessionId: p.sessionId,
          label: applied,
        })
        await broadcastSessionList(deps)
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:rename_workspace', async (raw: ClientRenameWorkspace) => {
      const p = vparse(schema.ClientRenameWorkspaceSchema, raw, 'client:rename_workspace')
      if (!p) return
      try {
        const applied = deps.renameWorkspace
          ? await deps.renameWorkspace(p.workspaceId, p.workspaceName)
          : p.workspaceName.trim()
        deps.dashboardNs.emit('server:control_update', {
          kind: 'workspace_meta_changed',
          workspaceId: p.workspaceId,
          workspaceName: applied,
        })
        deps.dashboardNs.emit('server:executors', { executors: executorSnapshotFor(deps) })
        await broadcastSessionList(deps)
      } catch (err) {
        deps.broadcastError(
          p.workspaceId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
    socket.on('client:list_dirs', async (raw: ClientListDirs) => {
      const p = vparse(schema.ClientListDirsSchema, raw, 'client:list_dirs') as ClientListDirs | undefined
      if (!p) return
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.list_dirs', p.sessionId, p.workspaceId, error)
          socket.emit('server:dir_list', { requestId: p.requestId, workspaceId: p.workspaceId, path: p.path ?? '', roots: [], entries: [], error })
          return
        }
      }
      deps.audit?.log({ action: 'internal_tool.list_dirs', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok', metadata: { path: p.path } })
      const result = await deps.executors.listDirs(p.workspaceId, p.path, p.requestId)
      socket.emit('server:dir_list', result)
    })
    socket.on('client:list_files', async (raw: ClientListFiles) => {
      const p = vparse(schema.ClientListFilesSchema, raw, 'client:list_files') as ClientListFiles | undefined
      if (!p) return
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.list_files', p.sessionId, p.workspaceId, error)
          socket.emit('server:file_list', { requestId: p.requestId, workspaceId: p.workspaceId, files: [], truncated: false, error })
          return
        }
      }
      const result = await deps.executors.listFiles(p)
      socket.emit('server:file_list', result)
    })
    socket.on('client:read_file', async (raw: ClientReadFile) => {
      const p = vparse(schema.ClientReadFileSchema, raw, 'client:read_file') as ClientReadFile | undefined
      if (!p) return
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.read_file', p.sessionId, p.workspaceId, error)
          socket.emit('server:file_contents', { requestId: p.requestId, workspaceId: p.workspaceId, path: p.path, kind: 'error', error })
          return
        }
      }
      deps.audit?.log({ action: 'internal_tool.read_file', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok', metadata: { path: p.path } })
      const result = await deps.executors.readFile(p)
      socket.emit('server:file_contents', result)
    })
    socket.on('git:status', async (raw: ClientGitStatus, ack) => {
      const p = vparse(schema.ClientGitStatusSchema, raw, 'git:status', (raw as ClientGitStatus | undefined)?.sessionId)
      if (!p) return
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.git_status', p.sessionId, p.workspaceId, error)
          return ack({ requestId: p.requestId, workspaceId: p.workspaceId, files: [], error: { code: 'internal_error', message: error } })
        }
      }
      deps.audit?.log({ action: 'internal_tool.git_status', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok' })
      const result = await deps.executors.gitStatus(p)
      ack(result)
    })
    socket.on('git:diff', async (raw: ClientGitDiff, ack) => {
      const p = vparse(schema.ClientGitDiffSchema, raw, 'git:diff', (raw as ClientGitDiff | undefined)?.sessionId)
      if (!p) return
      if (p.sessionId) {
        const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
        if (error) {
          auditScopedAccessDenied('internal_tool.git_diff', p.sessionId, p.workspaceId, error)
          return ack({ requestId: p.requestId, workspaceId: p.workspaceId, error: { code: 'internal_error', message: error } })
        }
      }
      deps.audit?.log({ action: 'internal_tool.git_diff', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok', metadata: { path: p.path, staged: p.staged === true } })
      const result = await deps.executors.gitDiff(p)
      ack(result)
    })
    socket.on('client:read_overflow', async (raw: ClientReadOverflow) => {
      const p = vparse(schema.ClientReadOverflowSchema, raw, 'client:read_overflow', (raw as ClientReadOverflow | undefined)?.sessionId)
      if (!p) return
      deps.audit?.log({ action: 'internal_tool.read_overflow', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok' })
      const record = deps.store.get(p.sessionId) ?? (await deps.store.load(p.sessionId).catch(() => undefined))
      const workspaceId = record?.workspaceId
      if (!workspaceId) {
        socket.emit('server:overflow_contents', {
          requestId: p.requestId,
          sessionId: p.sessionId,
          callId: p.callId,
          error: 'unknown session or session has no workspace',
        })
        return
      }
      const result = await deps.executors.readOverflow(p, workspaceId)
      socket.emit('server:overflow_contents', result)
    })
    socket.on('bg:list', async (raw: ClientListBgTasks, ack) => {
      const p = vparse(schema.ClientListBgTasksSchema, raw, 'bg:list', (raw as ClientListBgTasks | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('background_task.list', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, tasks: [], error })
      }
      const result = await deps.executors.listBg(p)
      ack(result)
    })
    socket.on('bg:output', async (raw: ClientReadBgOutput, ack) => {
      const p = vparse(schema.ClientReadBgOutputSchema, raw, 'bg:output', (raw as ClientReadBgOutput | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('background_task.output', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, taskId: p.taskId, content: '', nextOffset: 0, done: true, status: 'exited', bytesTruncated: 0, error })
      }
      const result = await deps.executors.readBg(p)
      ack(result)
    })
    socket.on('bg:kill', async (raw: ClientKillBgTask, ack) => {
      const p = vparse(schema.ClientKillBgTaskSchema, raw, 'bg:kill', (raw as ClientKillBgTask | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('background_task.kill', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, taskId: p.taskId, killed: false, error })
      }
      const result = await deps.executors.killBg(p)
      ack(result)
    })
    socket.on('terminal:create', async (raw: ClientTerminalCreate, ack) => {
      const p = vparse(schema.ClientTerminalCreateSchema, raw, 'terminal:create', (raw as ClientTerminalCreate | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('terminal.create', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, error })
      }
      const result = await deps.executors.createTerminal(p)
      ack(result)
    })
    socket.on('terminal:input', async (raw: ClientTerminalInput) => {
      const p = vparse(schema.ClientTerminalInputSchema, raw, 'terminal:input', (raw as ClientTerminalInput | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('terminal.input', p.sessionId, p.workspaceId, error)
        return
      }
      deps.executors.inputTerminal(p)
    })
    socket.on('terminal:resize', async (raw: ClientTerminalResize) => {
      const p = vparse(schema.ClientTerminalResizeSchema, raw, 'terminal:resize', (raw as ClientTerminalResize | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('terminal.resize', p.sessionId, p.workspaceId, error)
        return
      }
      deps.executors.resizeTerminal(p)
    })
    socket.on('terminal:kill', async (raw: ClientTerminalKill, ack) => {
      const p = vparse(schema.ClientTerminalKillSchema, raw, 'terminal:kill', (raw as ClientTerminalKill | undefined)?.sessionId)
      if (!p) return
      const error = await validateBgSessionAccess(p.sessionId, p.workspaceId)
      if (error) {
        auditScopedAccessDenied('terminal.kill', p.sessionId, p.workspaceId, error)
        return ack({ requestId: p.requestId, workspaceId: p.workspaceId, sessionId: p.sessionId, terminalId: p.terminalId, killed: false, error })
      }
      const result = await deps.executors.killTerminal(p)
      ack(result)
    })
    socket.on('sub_agent:list', async (raw: ClientListSubAgents, ack) => {
      const p = vparse(schema.ClientListSubAgentsSchema, raw, 'sub_agent:list')
      if (!p) return
      const children: SubAgentSummary[] = []
      for (const rec of await deps.store.listChildren(p.parentSessionId)) {
        const status: SubAgentSummary['status'] =
          rec.state.status === 'done'
            ? 'completed'
            : rec.state.status === 'error'
              ? 'failed'
              : 'running'
        children.push({
          childSessionId: rec.sessionId,
          ...(rec.parentCallId !== undefined ? { parentCallId: rec.parentCallId } : {}),
          ...(rec.agentType !== undefined ? { agentType: rec.agentType } : {}),
          status,
          ...(rec.subAgentStartedAt !== undefined ? { startedAt: rec.subAgentStartedAt } : {}),
          ...(status !== 'running' && rec.lastEventAt !== undefined ? { finishedAt: rec.lastEventAt } : {}),
        })
      }
      ack({ requestId: p.requestId, parentSessionId: p.parentSessionId, children })
    })
    socket.on('agent_types:list', (raw: ClientListAgentTypes, ack) => {
      const p = vparse(schema.ClientListAgentTypesSchema, raw, 'agent_types:list')
      if (!p) return
      // Registry loader lives behind a follow-up (docs/host/sub-agent-design.md §6).
      // Return an empty list so dashboards that call this on mount don't crash;
      // the Composer '@agent-name' menu shows an empty state until the loader ships.
      ack({ requestId: p.requestId, types: [] })
    })
    socket.on('client:consolidate_memory', async (raw: ClientConsolidateMemory) => {
      const p = vparse(schema.ClientConsolidateMemorySchema, raw, 'client:consolidate_memory', (raw as ClientConsolidateMemory | undefined)?.sessionId)
      if (!p) return
      const outcome = await consolidateMemory(deps.loopDeps, p.sessionId).catch(
        (err: unknown): ConsolidationOutcome => ({
          saved: [],
          skipped: 0,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      const payload = {
        requestId: p.requestId,
        sessionId: p.sessionId,
        saved: outcome.saved,
        skipped: outcome.skipped,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      }
      socket.emit('server:memory_consolidated', payload)
    })
    socket.on('client:create_session', async (raw: ClientCreateSession) => {
      const parsed = vparse(schema.ClientCreateSessionSchema, raw, 'client:create_session', (raw as ClientCreateSession | undefined)?.sessionId)
      if (!parsed) return
      let p: ClientCreateSession = parsed
      try {
        const selectedModel = p.selectedModel?.trim()
        const normalizedSelectedModel = selectedModel ? normalizeIncomingModel(deps, selectedModel) : undefined
        if (selectedModel && !normalizedSelectedModel) {
          socket.emit('session:error', {
            sessionId: p.sessionId,
            scope: 'host',
            message: `unknown or ambiguous model: ${selectedModel}`,
          })
          return
        }
        const cwd = p.cwd?.trim()
        if (cwd && cwd.length > 0 && p.workspaceId) {
          const validation = await validateWorkspaceCwd(deps, p.workspaceId, cwd)
          if (!validation.ok) {
            deps.audit?.log({ action: 'dashboard.session_create', actor: auditActor(socket), target: { sessionId: p.sessionId, workspaceId: p.workspaceId }, outcome: 'denied', metadata: { cwd }, error: validation.reason })
            socket.emit('session:error', {
              sessionId: p.sessionId,
              scope: 'host',
              message: validation.reason,
            })
            return
          }
          p = { ...p, cwd: validation.cwd }
        }
        const { record, created } = await deps.store.ensure({
          sessionId: p.sessionId,
          defaultConfig: deriveSessionConfig(getDefaultConfig(), p.tools),
          ...(p.workspaceId !== undefined ? { workspaceId: p.workspaceId } : {}),
          ...(p.workspaceName !== undefined
            ? { workspaceName: p.workspaceName }
            : {}),
          ...(p.cwd !== undefined ? { initialCwd: p.cwd } : {}),
          ...(normalizedSelectedModel !== undefined ? { preferences: { selectedModel: normalizedSelectedModel } } : {}),
        })
        await refreshSessionSkillsIfNeeded(deps, record)
        await socket.join(sessionRoom(record.sessionId))
        socket.emit(
          'session:ready',
          readyEventFor(
            record,
            selectedModelForRecord(record),
            created ? 'created' : 'load',
            contextWindowForSession(deps, record),
          ),
        )
        if (created) {
          deps.audit?.log({ action: 'dashboard.session_create', actor: auditActor(socket), target: { sessionId: record.sessionId, workspaceId: record.workspaceId }, outcome: 'ok', metadata: { cwd: record.state.cwd } })
          await broadcastSessionList(deps)
          if (deps.onSessionCreated) {
            try {
              await deps.onSessionCreated(record)
            } catch {
              // Lifecycle hook errors are advisory — swallow.
            }
          }
        }
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:fork', async (raw: ClientFork) => {
      const p = vparse(schema.ClientForkSchema, raw, 'client:fork', (raw as ClientFork | undefined)?.sourceSessionId)
      if (!p) return
      try {
        const source = await deps.store.load(p.sourceSessionId)
        const parsed = await readSessionLog(source.logPath)
        const keptEvents = parsed.events
          .filter((e) => e.seq <= p.cursor)
          .map((e) => e.event)
        const forkedState: AgentState = fold(
          parsed.header.initialState,
          keptEvents,
          parsed.header.config,
        )
        const newId = p.newSessionId ?? ulid()
        const record = await deps.store.create({
          sessionId: newId,
          config: source.config,
          parentSessionId: p.sourceSessionId,
          parentCursor: p.cursor,
          initialState: forkedState,
          ...(source.workspaceId !== undefined
            ? { workspaceId: source.workspaceId }
            : {}),
          ...(source.workspaceName !== undefined
            ? { workspaceName: source.workspaceName }
            : {}),
        })
        await refreshSessionSkillsIfNeeded(deps, record)
        const parentModel = selectedModelForRecord(source)
        if (parentModel) {
          await deps.store.updatePreferences(record.sessionId, { selectedModel: parentModel })
          record.preferences = { ...record.preferences, selectedModel: parentModel }
        }
        if (source.workspaceId) {
          await deps.executors.copyOverflowSession(
            source.workspaceId,
            p.sourceSessionId,
            record.sessionId,
          ).catch(() => undefined)
        }
        await socket.join(sessionRoom(record.sessionId))
        const forked: SessionReadyEvent = {
          sessionId: record.sessionId,
          reason: 'forked',
          parentSessionId: p.sourceSessionId,
          parentCursor: p.cursor,
          cursor: record.state.cursor,
          state: record.state,
          config: record.config,
          contextSnapshot: contextSnapshot(record, record.state.messages, contextWindowForSession(deps, record)),
          ...(parentModel ? { selectedModel: parentModel } : {}),
          ...(record.workspaceId !== undefined
            ? { workspaceId: record.workspaceId }
            : {}),
          ...(record.workspaceName !== undefined
            ? { workspaceName: record.workspaceName }
            : {}),
        }
        socket.emit('session:ready', forked)
        deps.audit?.log({ action: 'dashboard.session_fork', actor: auditActor(socket), target: { sessionId: record.sessionId, sourceSessionId: p.sourceSessionId }, outcome: 'ok', refs: { parentCursor: p.cursor } })
        await broadcastSessionList(deps)
        if (typeof p.seedMessage === 'string' && p.seedMessage.trim().length > 0) {
          await deps.loop.dispatch(record.sessionId, {
            kind: 'user_message',
            text: p.seedMessage,
          }, parentModel ? { model: parentModel } : undefined)
        }
      } catch (err) {
        deps.broadcastError(
          p.sourceSessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:delete_session', async (raw: ClientDeleteSession) => {
      const p = vparse(schema.ClientDeleteSessionSchema, raw, 'client:delete_session', (raw as ClientDeleteSession | undefined)?.sessionId)
      if (!p) return
      try {
        const targetIds = p.cascade
          ? collectSessionDescendants(await deps.store.listSummaries(), p.sessionId)
          : [p.sessionId]
        for (const targetSessionId of targetIds) {
          const record = deps.store.get(targetSessionId) ?? (await deps.store.load(targetSessionId).catch(() => undefined))
          if (record && deps.onSessionDeleted) {
            try {
              await deps.onSessionDeleted(record)
            } catch {
              // Lifecycle hook errors are advisory — swallow.
            }
          }
          if (record?.workspaceId) {
            await deps.executors.deleteOverflowSession(record.workspaceId, targetSessionId).catch(() => undefined)
          }
          await deps.store.delete(targetSessionId)
          resetCompactRuntime(targetSessionId)
          deps.audit?.log({ action: 'dashboard.session_delete', actor: auditActor(socket), target: { sessionId: targetSessionId, workspaceId: record?.workspaceId }, outcome: 'ok', refs: p.cascade ? { rootSessionId: p.sessionId } : undefined })
          ns.emit('server:session_deleted', { sessionId: targetSessionId })
        }
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:update_preferences', async (raw) => {
      const p = vparse(schema.ClientUpdatePreferencesSchema, raw, 'client:update_preferences', (raw as { sessionId?: string } | undefined)?.sessionId)
      if (!p) return
      if ('selectedModel' in p.preferences) {
        deps.audit?.log({ action: 'dashboard.model_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { model: p.preferences.selectedModel?.trim() ?? '' } })
      }
      await applyPreferencesUpdate(deps, p.sessionId, p.preferences)
    })
  })
}

function executorSnapshotFor(deps: DashboardDeps): readonly AttachedExecutor[] {
  return deps.executorSnapshot ? deps.executorSnapshot() : deps.executors.snapshot()
}

function deriveSessionConfig(
  base: AgentConfig,
  toolAllowlist: readonly string[] | undefined,
): AgentConfig {
  if (!toolAllowlist) return base
  const allowed = new Set(toolAllowlist)
  return { ...base, tools: base.tools.filter((t) => allowed.has(t.name)) }
}

async function refreshSessionSkillsIfNeeded(
  deps: DashboardDeps,
  record: SessionRecord,
): Promise<void> {
  if (!isSkillManager(deps.loopDeps.skills)) return
  await deps.loopDeps.skills.refreshConfig(record)
}

function auditActor(socket: { data: Record<string, unknown> }): AuditActor {
  const actor = socket.data.dashboardActor as AuditActor | undefined
  return actor ?? { kind: 'anonymous' }
}

function auditConnectionMeta(meta: ConnectionMeta): Record<string, unknown> {
  return {
    connectionKind: meta.kind,
    connectionLabel: meta.label,
    clientVersion: meta.clientVersion,
  }
}

/**
 * Apply a partial preferences patch. Empty string on `selectedModel` clears
 * it (back to the host default) and emits a control-plane update.
 */
async function applyPreferencesUpdate(
  deps: DashboardDeps,
  sessionId: string,
  patch: import('@agent-kernel/shared').SessionPreferences,
): Promise<void> {
  const normalizedPatch = normalizePreferencesPatch(deps, sessionId, patch)
  if (!normalizedPatch) return
  let effective: import('@agent-kernel/shared').SessionPreferences
  try {
    effective = await deps.store.updatePreferences(sessionId, normalizedPatch)
  } catch (err) {
    deps.broadcastError(
      sessionId,
      'host',
      err instanceof Error ? err.message : String(err),
    )
    return
  }
  deps.dashboardNs
    .to(sessionRoom(sessionId))
    .emit('server:control_update', {
      kind: 'session_meta_changed',
      sessionId,
      preferences: effective,
    })
  const record = deps.store.get(sessionId)
  if (record) {
    deps.dashboardNs.to(sessionRoom(sessionId)).emit('state:changed', {
      sessionId,
      cursor: record.state.cursor,
      state: record.state,
      contextSnapshot: contextSnapshot(record, record.state.messages, contextWindowForSession(deps, record)),
    })
  }
}

function contextWindowForSession(deps: DashboardDeps, record: SessionRecord): ContextWindowOverride | undefined {
  return deps.contextWindowForModel?.(selectedModelForRecord(record))
}

function selectedModelForRecord(record: SessionRecord): string | undefined {
  return record.preferences.selectedModel
}

function normalizePreferencesPatch(
  deps: DashboardDeps,
  sessionId: string,
  patch: import('@agent-kernel/shared').SessionPreferences,
): import('@agent-kernel/shared').SessionPreferences | null {
  if (!('selectedModel' in patch)) return patch
  const selectedModel = patch.selectedModel?.trim()
  if (!selectedModel) return { ...patch, selectedModel: '' }
  const normalized = normalizeIncomingModel(deps, selectedModel)
  if (!normalized) {
    deps.broadcastError(sessionId, 'host', `unknown or ambiguous model: ${selectedModel}`)
    return null
  }
  return { ...patch, selectedModel: normalized }
}

function normalizeIncomingModel(deps: DashboardDeps, model: string): string | undefined {
  return deps.normalizeModelRef ? deps.normalizeModelRef(model) : model.trim()
}

async function safeDispatch(
  deps: DashboardDeps,
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  try {
    // Sessions must be materialised via `client:create_session` (which binds
    // a workspaceId) or via `client:fork`. A user event arriving against an
    // unknown sessionId means either a stale dashboard URL or a bug — either
    // way we refuse to lazy-create, because a lazy-created session has no
    // workspaceId, cannot route tool calls, and lands in the Explorer's
    // Unassigned bucket forever. Surface the miss so the user notices.
    const record = await loadRecordForDashboard(deps, sessionId)
    if (!record) {
      deps.broadcastError(
        sessionId,
        'host',
        'session not created — click "New" in the sidebar to start a session bound to a workspace',
      )
      return
    }
    await deps.loop.dispatch(sessionId, event)
  } catch (err) {
    deps.broadcastError(
      sessionId,
      'kernel',
      err instanceof Error ? err.message : String(err),
    )
  }
}

async function handleUserMessage(
  deps: DashboardDeps,
  p: ClientUserMessage,
): Promise<void> {
  let record = await loadRecordForDashboard(deps, p.sessionId)
  if (!record) {
    deps.broadcastError(
      p.sessionId,
      'host',
      'session not created — click "New" in the sidebar to start a session bound to a workspace',
    )
    return
  }
  if (record.state.status === 'thinking' && !deps.loop.hasActiveLlmCall(p.sessionId)) {
    await deps.loop.recoverInterruptedLlm(p.sessionId)
    record = await loadRecordForDashboard(deps, p.sessionId)
    if (!record) return
  }
  const mode = p.mode ?? 'steer'
  const selectedModel = selectedModelForRecord(record)
  const queued: QueuedUserMessage = {
    id: ulid(),
    text: p.text,
    mode,
    createdAt: new Date().toISOString(),
    ...(p.content ? { content: p.content } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
  }
  if (mode === 'queue') {
    deps.messageQueues.enqueue(p.sessionId, queued)
    await deps.messageQueues.drain(p.sessionId)
    return
  }
  if (!isRestingStatus(record.state.status)) {
    if (record.state.status === 'thinking') deps.loop.cancelStream(p.sessionId)
    deps.messageQueues.enqueue(p.sessionId, queued, 'front')
    return
  }
  await deps.loop.dispatch(p.sessionId, {
    kind: 'user_message',
    text: p.text,
    ...(p.content ? { content: p.content } : {}),
  }, queued.model ? { model: queued.model } : undefined)
}

async function loadRecordForDashboard(
  deps: DashboardDeps,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  let record: SessionRecord | undefined = deps.store.get(sessionId)
  if (!record) {
    try {
      record = await deps.store.load(sessionId)
    } catch {
      record = undefined
    }
  }
  return record
}

async function validateSessionCwd(
  deps: DashboardDeps,
  record: SessionRecord,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'cwd is empty' }
  const resolved = resolvePath(trimmed)
  const executor = record.workspaceId
    ? deps.executors.snapshot().find((e) => e.workspaceId === record.workspaceId)
    : deps.executors.executorForSession(record.sessionId)
  if (!executor) return { ok: false, reason: record.workspaceId ? 'workspace offline' : 'no executor connected' }
  const roots = executor?.sandboxRoots ?? []
  if (roots.length === 0) return await validateDirectoryExists(deps, executor.workspaceId, resolved)
  for (const root of roots) {
    const r = resolvePath(root)
    if (resolved === r || resolved.startsWith(r + sep)) {
      return await validateDirectoryExists(deps, executor.workspaceId, resolved)
    }
  }
  return {
    ok: false,
    reason: 'cwd outside sandbox roots',
  }
}

async function validateWorkspaceCwd(
  deps: DashboardDeps,
  workspaceId: string,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'cwd is empty' }
  const resolved = resolvePath(trimmed)
  const executor = deps.executors.snapshot().find((e) => e.workspaceId === workspaceId)
  if (!executor) return { ok: false, reason: 'workspace offline' }
  const roots = executor.sandboxRoots ?? []
  if (roots.length === 0) return await validateDirectoryExists(deps, workspaceId, resolved)
  for (const root of roots) {
    const r = resolvePath(root)
    if (resolved === r || resolved.startsWith(r + sep)) {
      return await validateDirectoryExists(deps, workspaceId, resolved)
    }
  }
  return {
    ok: false,
    reason: 'cwd outside sandbox roots',
  }
}

async function validateDirectoryExists(
  deps: DashboardDeps,
  workspaceId: string,
  cwd: string,
): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }> {
  const listed = await deps.executors.listDirs(workspaceId, cwd, ulid())
  if (listed.error) {
    return { ok: false, reason: `cwd is not a readable directory: ${listed.error}` }
  }
  return { ok: true, cwd: listed.path || cwd }
}

async function broadcastSessionList(deps: DashboardDeps): Promise<void> {
  const sessions = await deps.store.listSummaries()
  deps.dashboardNs.emit('server:sessions', { sessions })
}

function collectSessionDescendants(
  sessions: readonly { sessionId: string; parentSessionId?: string }[],
  rootSessionId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentSessionId) continue
    const children = childrenByParent.get(session.parentSessionId) ?? []
    children.push(session.sessionId)
    childrenByParent.set(session.parentSessionId, children)
  }
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [rootSessionId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    queue.push(...(childrenByParent.get(id) ?? []))
  }
  return out
}

async function readJsonLogArtifact(logPath: string, refPath: string): Promise<unknown> {
  const base = dirname(logPath)
  const resolved = resolvePath(base, refPath)
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error('artifact path escapes session directory')
  }
  return JSON.parse(await readFile(resolved, 'utf8'))
}

export function readyEventFor(
  record: SessionRecord,
  selectedModel?: string,
  reason: SessionReadyEvent['reason'] = 'load',
  contextOverride?: ContextWindowOverride,
): SessionReadyEvent {
  return {
    sessionId: record.sessionId,
    reason,
    cursor: record.state.cursor,
    state: record.state,
    config: record.config,
    contextSnapshot: contextSnapshot(record, record.state.messages, contextOverride),
    ...(record.parentSessionId
      ? { parentSessionId: record.parentSessionId }
      : {}),
    ...(record.parentCursor !== undefined
      ? { parentCursor: record.parentCursor }
      : {}),
    ...(record.parentCallId !== undefined
      ? { parentCallId: record.parentCallId }
      : {}),
    ...(record.agentType !== undefined
      ? { agentType: record.agentType }
      : {}),
    ...(record.subAgentStartedAt !== undefined
      ? { subAgentStartedAt: record.subAgentStartedAt }
      : {}),
    ...(record.workspaceId !== undefined
      ? { workspaceId: record.workspaceId }
      : {}),
    ...(record.workspaceName !== undefined
      ? { workspaceName: record.workspaceName }
      : {}),
    ...(selectedModel ? { selectedModel } : {}),
  }
}

// Session-not-yet-on-disk fallback. Returns a plausible `session:ready`
// carrying a fresh initial state so the dashboard can render an empty chat
// and let the user compose a message. Nothing is persisted here; the JSONL
// file is written the first time `client:user_message` / `client:fork`
// forces a `store.ensure()` inside the dispatch path.
export function ephemeralReadyEventFor(
  sessionId: string,
  defaultConfig: AgentConfig,
  selectedModel?: string,
  contextOverride?: ContextWindowOverride,
): SessionReadyEvent {
  const state = createInitialState({
    sessionId,
    ...(defaultConfig.systemPrompt
      ? { systemPrompt: defaultConfig.systemPrompt }
      : {}),
  })
  return {
    sessionId,
    cursor: state.cursor,
    state,
    config: defaultConfig,
    contextSnapshot: snapshotFromConfig(defaultConfig, state.messages, contextOverride, selectedModel),
    ...(selectedModel ? { selectedModel } : {}),
  }
}

/**
 * Dashboard Socket.IO namespace wiring.
 *
 * One socket per connected browser tab. The connection is bound to a
 * `sessionId` at handshake time (via `auth.sessionId`); the browser sees
 * `session:ready` up front and subscribes to a room named `session:<id>`.
 *
 * Every `client:*` event on this namespace maps to a call into the host
 * loop, the session store, or the executor registry. Nothing here decides
 * *what* the kernel does  -  that stays in the kernel. This file is protocol
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
  ClientReadBgOutput,
  ClientReadFile,
  ClientReadOverflow,
  ClientDeleteQueuedMessage,
  ClientReorderQueuedMessage,
  ClientRenameWorkspace,
  ClientRenameSession,
  ClientSetApprovalMode,
  ClientSetCwd,
  ClientSetModel,
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
  SessionForkedEvent,
  SessionReadyEvent,
  SubAgentSummary,
} from '@agent-kernel/shared'
import { isCompatibleVersion } from '@agent-kernel/shared'
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
import { resolve as resolvePath, sep } from 'node:path'
import type { AuthConfig } from '../auth-control.js'
import { authenticateDashboardHandshake } from '../auth-control.js'
import type { AuditActor, AuditLogger } from '../audit-log.js'

export type QueuedUserMessage = {
  id: string
  text: string
  mode: 'steer' | 'queue'
  createdAt: string
  content?: readonly MessageContent[]
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
  defaultConfig: AgentConfig
  auth?: AuthConfig
  audit?: AuditLogger
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
  selectedModels: Map<string, string>
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
    socket.data.dashboardActor = authResult.actor
    deps.audit?.log({ action: 'dashboard.socket_accept', actor: authResult.actor, target: { sessionId: auth.sessionId }, outcome: 'ok' })
    nextFn()
  })

  ns.on('connection', async (socket) => {
    const auth = socket.handshake.auth as HandshakeAuth
    // Middleware guarantees auth.sessionId is present for the dashboard role.
    const sessionId = auth.sessionId!

    // Register first-paint request handlers before any awaited session load.
    // The dashboard emits these immediately after the websocket connects or
    // after `session:ready`; if we install handlers later, those one-shot
    // requests can be lost and the UI stays on "no session selected".
    socket.on('client:list_executors', (_p: ClientListExecutors) => {
      socket.emit('server:executors', { executors: executorSnapshotFor(deps) })
    })

    socket.on('client:list_sessions', async (_p: ClientListSessions) => {
      const sessions = await deps.store.listSummaries()
      socket.emit('server:sessions', { sessions })
    })

    socket.on('client:load_history', async (p: ClientLoadHistory) => {
      try {
        let target: SessionRecord | undefined = deps.store.get(p.sessionId)
        if (!target) {
          try {
            target = await deps.store.load(p.sessionId)
          } catch {
            // Session hasn't been persisted yet  -  reply with an empty
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

    // Do NOT auto-create the session on connect. A dashboard opening a fresh
    // random UUID must not materialize a JSONL file on disk  -  otherwise
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
    await socket.join(`session:${sessionId}`)
    const ready: SessionReadyEvent = record
      ? readyEventFor(record, deps.selectedModels.get(sessionId))
      : ephemeralReadyEventFor(
          sessionId,
          deps.defaultConfig,
          deps.selectedModels.get(sessionId),
        )
    socket.emit('session:ready', ready)
    socket.emit('server:message_queue', deps.messageQueues.snapshot(sessionId))

    socket.on('subscribe', async ({ sessionId }: ClientSubscribe) => {
      let target = deps.store.get(sessionId)
      if (!target) {
        try {
          target = await deps.store.load(sessionId)
        } catch {
          target = undefined
        }
      }
      await socket.join(`session:${sessionId}`)
      const payload: SessionReadyEvent = target
        ? readyEventFor(target, deps.selectedModels.get(sessionId))
        : ephemeralReadyEventFor(
            sessionId,
            deps.defaultConfig,
            deps.selectedModels.get(sessionId),
          )
      socket.emit('session:ready', payload)
      socket.emit('server:message_queue', deps.messageQueues.snapshot(sessionId))
    })

    socket.on('client:user_message', async (p: ClientUserMessage) => {
      deps.audit?.log({ action: 'dashboard.user_message', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { messageBytes: Buffer.byteLength(p.text, 'utf8'), mode: p.mode ?? 'steer' } })
      await handleUserMessage(deps, p)
    })
    socket.on('client:user_approve', async (p: ClientUserApprove) => {
      deps.audit?.log({ action: 'dashboard.user_approve', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok' })
      const evt: AgentEvent = { kind: 'user_approve', callId: p.callId }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:user_reject', async (p: ClientUserReject) => {
      deps.audit?.log({ action: 'dashboard.user_reject', actor: auditActor(socket), target: { sessionId: p.sessionId, callId: p.callId }, outcome: 'ok', metadata: { reasonBytes: p.reason ? Buffer.byteLength(p.reason, 'utf8') : 0 } })
      const evt: AgentEvent = {
        kind: 'user_reject',
        callId: p.callId,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:cancel', async (p: ClientCancel) => {
      const evt: AgentEvent = { kind: 'cancel' }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:interrupt_sub_agent', async (p: ClientInterruptSubAgent) => {
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
    socket.on('client:clear', async (p: ClientClear) => {
      deps.audit?.log({ action: 'dashboard.session_clear', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok' })
      deps.loopDeps.tools.cancelPending(p.sessionId)
      deps.loop.cancelStream(p.sessionId)
      const evt: AgentEvent = { kind: 'clear' }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:compact', async (p: ClientCompact) => {
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
            'session not created  -  nothing to compact',
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
    socket.on('client:cancel_stream', (p: ClientCancelStream) => {
      // No error path  -  cancelStream is a no-op when nothing is streaming.
      // The loop turns the abort into a normal llm_response, so the FSM
      // and log stay coherent without any special-case wiring here.
      deps.loop.cancelStream(p.sessionId)
    })
    socket.on('client:set_approval_mode', async (p: ClientSetApprovalMode) => {
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
    socket.on('client:set_cwd', async (p: ClientSetCwd) => {
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
    socket.on('client:reorder_queued_message', (p: ClientReorderQueuedMessage) => {
      deps.messageQueues.reorder(p.sessionId, p.id, p.beforeId)
    })
    socket.on('client:update_queued_message', (p: ClientUpdateQueuedMessage) => {
      deps.messageQueues.update(p.sessionId, p.id, p.text)
    })
    socket.on('client:delete_queued_message', (p: ClientDeleteQueuedMessage) => {
      deps.messageQueues.delete(p.sessionId, p.id)
    })
    socket.on('client:rename_session', async (p: ClientRenameSession) => {
      try {
        const applied = await deps.store.rename(p.sessionId, p.label)
        deps.dashboardNs.emit('session:renamed', {
          sessionId: p.sessionId,
          label: applied,
        })
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
    socket.on('client:rename_workspace', async (p: ClientRenameWorkspace) => {
      try {
        const applied = deps.renameWorkspace
          ? await deps.renameWorkspace(p.workspaceId, p.workspaceName)
          : p.workspaceName.trim()
        deps.dashboardNs.emit('workspace:renamed', {
          workspaceId: p.workspaceId,
          workspaceName: applied,
        })
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
    socket.on('client:list_dirs', async (p: ClientListDirs) => {
      deps.audit?.log({ action: 'internal_tool.list_dirs', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok', metadata: { path: p.path } })
      const result = await deps.executors.listDirs(p.workspaceId, p.path, p.requestId)
      socket.emit('server:dir_list', result)
    })
    socket.on('client:list_files', async (p: ClientListFiles) => {
      const result = await deps.executors.listFiles(p)
      socket.emit('server:file_list', result)
    })
    socket.on('client:read_file', async (p: ClientReadFile) => {
      deps.audit?.log({ action: 'internal_tool.read_file', actor: auditActor(socket), target: { workspaceId: p.workspaceId }, outcome: 'ok', metadata: { path: p.path } })
      const result = await deps.executors.readFile(p)
      socket.emit('server:file_contents', result)
    })
    socket.on('client:read_overflow', async (p: ClientReadOverflow) => {
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
    socket.on('bg:list', async (p: ClientListBgTasks, ack) => {
      await socket.join(`workspace:${p.workspaceId}`)
      const result = await deps.executors.listBg(p)
      ack(result)
    })
    socket.on('bg:output', async (p: ClientReadBgOutput, ack) => {
      const result = await deps.executors.readBg(p)
      ack(result)
    })
    socket.on('bg:kill', async (p: ClientKillBgTask, ack) => {
      const result = await deps.executors.killBg(p)
      ack(result)
    })
    socket.on('sub_agent:list', (p: ClientListSubAgents, ack) => {
      // Cheap scan  -  we don't expect many thousands of sessions in memory,
      // and each row is a plain object. An index by parentSessionId is a
      // follow-up if this shows up in a profile.
      //
      // Optional fields (parentCallId, agentType, startedAt) are omitted here
      // because SessionRecord does not carry them today. Push events
      // (`server:sub_agent_started/_finished`) DO carry them for live runs; this
      // RPC is the log-replay fallback and returns only what the record has.
      const children: SubAgentSummary[] = []
      for (const rec of deps.store.list()) {
        if (rec.parentSessionId !== p.parentSessionId) continue
        const status: SubAgentSummary['status'] =
          rec.state.status === 'done'
            ? 'completed'
            : rec.state.status === 'error'
              ? 'failed'
              : 'running'
        children.push({
          childSessionId: rec.sessionId,
          status,
        })
      }
      ack({ requestId: p.requestId, parentSessionId: p.parentSessionId, children })
    })
    socket.on('agent_types:list', (p: ClientListAgentTypes, ack) => {
      // Registry loader lives behind a follow-up (docs/host/sub-agent-design.md  - 6).
      // Return an empty list so dashboards that call this on mount don't crash;
      // the Composer '@agent-name' menu shows an empty state until the loader ships.
      ack({ requestId: p.requestId, types: [] })
    })
    socket.on('client:consolidate_memory', async (p: ClientConsolidateMemory) => {
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
    socket.on('client:create_session', async (p: ClientCreateSession) => {
      try {
        const cwd = p.cwd?.trim()
        if (cwd && cwd.length > 0) {
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
          defaultConfig: deps.defaultConfig,
          workspaceId: p.workspaceId,
          ...(p.workspaceName !== undefined
            ? { workspaceName: p.workspaceName }
            : {}),
          ...(p.cwd !== undefined ? { initialCwd: p.cwd } : {}),
        })
        await socket.join(`session:${record.sessionId}`)
        socket.emit(
          'session:ready',
          readyEventFor(
            record,
            deps.selectedModels.get(record.sessionId),
            created ? 'created' : 'load',
          ),
        )
        if (created) {
          deps.audit?.log({ action: 'dashboard.session_create', actor: auditActor(socket), target: { sessionId: record.sessionId, workspaceId: record.workspaceId }, outcome: 'ok', metadata: { cwd: record.state.cwd } })
          await broadcastSessionList(deps)
          if (deps.onSessionCreated) {
            try {
              await deps.onSessionCreated(record)
            } catch {
              // Lifecycle hook errors are advisory  -  swallow.
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

    socket.on('client:fork', async (p: ClientFork) => {
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
        const parentModel = deps.selectedModels.get(p.sourceSessionId)
        if (parentModel) deps.selectedModels.set(record.sessionId, parentModel)
        if (source.workspaceId) {
          await deps.executors.copyOverflowSession(
            source.workspaceId,
            p.sourceSessionId,
            record.sessionId,
          ).catch(() => undefined)
        }
        await socket.join(`session:${record.sessionId}`)
        const forked: SessionForkedEvent = {
          sessionId: record.sessionId,
          reason: 'forked',
          parentSessionId: p.sourceSessionId,
          parentCursor: p.cursor,
          cursor: record.state.cursor,
          state: record.state,
          config: record.config,
          ...(record.workspaceId !== undefined
            ? { workspaceId: record.workspaceId }
            : {}),
          ...(record.workspaceName !== undefined
            ? { workspaceName: record.workspaceName }
            : {}),
        }
        socket.emit('session:forked', forked)
        deps.audit?.log({ action: 'dashboard.session_fork', actor: auditActor(socket), target: { sessionId: record.sessionId, sourceSessionId: p.sourceSessionId }, outcome: 'ok', refs: { parentCursor: p.cursor } })
        await broadcastSessionList(deps)
        if (typeof p.seedMessage === 'string' && p.seedMessage.trim().length > 0) {
          await deps.loop.dispatch(record.sessionId, {
            kind: 'user_message',
            text: p.seedMessage,
          })
        }
      } catch (err) {
        deps.broadcastError(
          p.sourceSessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:delete_session', async (p: ClientDeleteSession) => {
      try {
        const record = deps.store.get(p.sessionId)
        if (record && deps.onSessionDeleted) {
          try {
            await deps.onSessionDeleted(record)
          } catch {
            // Lifecycle hook errors are advisory  -  swallow.
          }
        }
        if (record?.workspaceId) {
          await deps.executors.deleteOverflowSession(record.workspaceId, p.sessionId).catch(() => undefined)
        }
        await deps.store.delete(p.sessionId)
        deps.selectedModels.delete(p.sessionId)
        resetCompactRuntime(p.sessionId)
        deps.audit?.log({ action: 'dashboard.session_delete', actor: auditActor(socket), target: { sessionId: p.sessionId, workspaceId: record?.workspaceId }, outcome: 'ok' })
        ns.emit('server:session_deleted', { sessionId: p.sessionId })
      } catch (err) {
        deps.broadcastError(
          p.sessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })

    socket.on('client:set_model', (p: ClientSetModel) => {
      const trimmed = p.model.trim()
      deps.audit?.log({ action: 'dashboard.model_change', actor: auditActor(socket), target: { sessionId: p.sessionId }, outcome: 'ok', metadata: { model: trimmed } })
      applyPreferencesUpdate(deps, p.sessionId, { selectedModel: trimmed })
    })
    socket.on('client:update_preferences', (p) => {
      applyPreferencesUpdate(deps, p.sessionId, p.preferences)
    })
  })
}

function executorSnapshotFor(deps: DashboardDeps): readonly AttachedExecutor[] {
  return deps.executorSnapshot ? deps.executorSnapshot() : deps.executors.snapshot()
}

function auditActor(socket: { data: Record<string, unknown> }): AuditActor {
  const actor = socket.data.dashboardActor as AuditActor | undefined
  return actor ?? { kind: 'anonymous' }
}

/**
 * Apply a partial preferences patch. Empty string on `selectedModel` clears
 * it (back to the host default). Emits both the new `session:preferences_changed`
 * (canonical) and the legacy `session:model_changed` (kept for one release so
 * old dashboard bundles keep working during rollout).
 */
function applyPreferencesUpdate(
  deps: DashboardDeps,
  sessionId: string,
  patch: import('@agent-kernel/shared').SessionPreferences,
): void {
  if ('selectedModel' in patch) {
    const trimmed = (patch.selectedModel ?? '').trim()
    if (trimmed.length === 0) {
      deps.selectedModels.delete(sessionId)
    } else {
      deps.selectedModels.set(sessionId, trimmed)
    }
    // Legacy emit  -  remove once every dashboard build has migrated to
    // `session:preferences_changed`.
    deps.dashboardNs
      .to(`session:${sessionId}`)
      .emit('session:model_changed', { sessionId, model: trimmed })
  }
  const effective: import('@agent-kernel/shared').SessionPreferences = {
    ...(deps.selectedModels.get(sessionId)
      ? { selectedModel: deps.selectedModels.get(sessionId) }
      : {}),
  }
  deps.dashboardNs
    .to(`session:${sessionId}`)
    .emit('session:preferences_changed', { sessionId, preferences: effective })
  deps.dashboardNs
    .to(`session:${sessionId}`)
    .emit('server:control_update', {
      kind: 'session_meta_changed',
      sessionId,
      preferences: effective,
    })
}

async function safeDispatch(
  deps: DashboardDeps,
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  try {
    // Sessions must be materialised via `client:create_session` (which binds
    // a workspaceId) or via `client:fork`. A user event arriving against an
    // unknown sessionId means either a stale dashboard URL or a bug  -  either
    // way we refuse to lazy-create, because a lazy-created session has no
    // workspaceId, cannot route tool calls, and lands in the Explorer's
    // Unassigned bucket forever. Surface the miss so the user notices.
    const record = await loadRecordForDashboard(deps, sessionId)
    if (!record) {
      deps.broadcastError(
        sessionId,
        'host',
        'session not created  -  click "New" in the sidebar to start a session bound to a workspace',
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
  const record = await loadRecordForDashboard(deps, p.sessionId)
  if (!record) {
    deps.broadcastError(
      p.sessionId,
      'host',
      'session not created  -  click "New" in the sidebar to start a session bound to a workspace',
    )
    return
  }
  const mode = p.mode ?? 'steer'
  const queued: QueuedUserMessage = {
    id: ulid(),
    text: p.text,
    mode,
    createdAt: new Date().toISOString(),
    ...(p.content ? { content: p.content } : {}),
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
  })
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

export function readyEventFor(
  record: SessionRecord,
  selectedModel?: string,
  reason: SessionReadyEvent['reason'] = 'load',
): SessionReadyEvent {
  return {
    sessionId: record.sessionId,
    reason,
    cursor: record.state.cursor,
    state: record.state,
    config: record.config,
    ...(record.parentSessionId
      ? { parentSessionId: record.parentSessionId }
      : {}),
    ...(record.parentCursor !== undefined
      ? { parentCursor: record.parentCursor }
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
    ...(selectedModel ? { selectedModel } : {}),
  }
}

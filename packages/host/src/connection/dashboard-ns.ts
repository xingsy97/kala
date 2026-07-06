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
  ClientCompact,
  ClientCreateSession,
  ClientDeleteSession,
  ClientFork,
  ClientListDirs,
  ClientListExecutors,
  ClientListFiles,
  ClientListSessions,
  ClientLoadHistory,
  ClientReadFile,
  ClientRenameSession,
  ClientSetApprovalMode,
  ClientSetCwd,
  ClientSetModel,
  ClientSubscribe,
  ClientUserApprove,
  ClientUserMessage,
  ClientUserReject,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  EventAppendedEvent,
  HandshakeAuth,
  ServerHistoryPayload,
  ServerMessageQueueEvent,
  SessionErrorScope,
  SessionForkedEvent,
  SessionReadyEvent,
} from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  MessageContent,
} from '@agent-kernel/kernel'
import { createInitialState, fold } from '@agent-kernel/kernel'
import type { Namespace } from 'socket.io'
import { ulid } from 'ulid'

import type { LoopHandle } from '../loop.js'
import { readSessionLog } from '../store/log.js'
import { SessionStore, type SessionRecord } from '../store/session.js'
import { createExecutorRegistry } from './executor.js'
import { resolve as resolvePath, sep } from 'node:path'

export type QueuedUserMessage = {
  id: string
  text: string
  mode: 'steer' | 'queue'
  createdAt: string
  content?: readonly MessageContent[]
}

export type MessageQueueManager = {
  enqueue(sessionId: string, msg: QueuedUserMessage, priority?: 'front'): void
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
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig
  authToken?: string
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
  selectedModels: Map<string, string>
  dashboardNs: DashboardNs
  messageQueues: MessageQueueManager
  onSessionCreated?(record: SessionRecord): void | Promise<void>
  onSessionDeleted?(record: SessionRecord): void | Promise<void>
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
    if (deps.authToken && auth.token !== deps.authToken) {
      nextFn(new Error('auth_failed'))
      return
    }
    if (!auth.sessionId) {
      nextFn(new Error('missing_session_id'))
      return
    }
    nextFn()
  })

  ns.on('connection', async (socket) => {
    const auth = socket.handshake.auth as HandshakeAuth
    // Middleware guarantees auth.sessionId is present for the dashboard role.
    const sessionId = auth.sessionId!
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
      await handleUserMessage(deps, p)
    })
    socket.on('client:user_approve', async (p: ClientUserApprove) => {
      const evt: AgentEvent = { kind: 'user_approve', callId: p.callId }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:user_reject', async (p: ClientUserReject) => {
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
    socket.on('client:cancel_stream', (p: ClientCancelStream) => {
      // No error path — cancelStream is a no-op when nothing is streaming.
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
    })
    socket.on('client:set_cwd', async (p: ClientSetCwd) => {
      const validation = validateSessionCwd(deps, p.sessionId, p.cwd)
      if (!validation.ok) {
        deps.broadcastError(p.sessionId, 'host', validation.reason)
        return
      }
      await safeDispatch(deps, p.sessionId, {
        kind: 'cwd_changed',
        cwd: validation.cwd,
      })
      await broadcastSessionList(deps)
    })
    socket.on('client:rename_session', async (p: ClientRenameSession) => {
      try {
        const applied = await deps.store.rename(p.sessionId, p.label)
        deps.dashboardNs.emit('session:renamed', {
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
    socket.on('client:list_dirs', async (p: ClientListDirs) => {
      const result = await deps.executors.listDirs(p.workspaceId, p.path, p.requestId)
      socket.emit('server:dir_list', result)
    })
    socket.on('client:list_files', async (p: ClientListFiles) => {
      const result = await deps.executors.listFiles(p)
      socket.emit('server:file_list', result)
    })
    socket.on('client:read_file', async (p: ClientReadFile) => {
      const result = await deps.executors.readFile(p)
      socket.emit('server:file_contents', result)
    })
    socket.on('client:create_session', async (p: ClientCreateSession) => {
      try {
        const cwd = p.cwd?.trim()
        if (cwd && cwd.length > 0) {
          const validation = validateWorkspaceCwd(deps, p.workspaceId, cwd)
          if (!validation.ok) {
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
          readyEventFor(record, deps.selectedModels.get(record.sessionId)),
        )
        if (created) {
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
        await socket.join(`session:${record.sessionId}`)
        const forked: SessionForkedEvent = {
          sessionId: record.sessionId,
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

    socket.on('client:list_executors', (_p: ClientListExecutors) => {
      socket.emit('server:executors', { executors: deps.executors.snapshot() })
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

    socket.on('client:delete_session', async (p: ClientDeleteSession) => {
      try {
        const record = deps.store.get(p.sessionId)
        if (record && deps.onSessionDeleted) {
          try {
            await deps.onSessionDeleted(record)
          } catch {
            // Lifecycle hook errors are advisory — swallow.
          }
        }
        await deps.store.delete(p.sessionId)
        deps.selectedModels.delete(p.sessionId)
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
      if (trimmed.length === 0) {
        deps.selectedModels.delete(p.sessionId)
      } else {
        deps.selectedModels.set(p.sessionId, trimmed)
      }
      deps.dashboardNs
        .to(`session:${p.sessionId}`)
        .emit('session:model_changed', { sessionId: p.sessionId, model: trimmed })
    })
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
  const record = await loadRecordForDashboard(deps, p.sessionId)
  if (!record) {
    deps.broadcastError(
      p.sessionId,
      'host',
      'session not created — click "New" in the sidebar to start a session bound to a workspace',
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

function validateSessionCwd(
  deps: DashboardDeps,
  sessionId: string,
  cwd: string,
): { ok: true; cwd: string } | { ok: false; reason: string } {
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'cwd is empty' }
  const resolved = resolvePath(trimmed)
  const executor = deps.executors.executorForSession(sessionId)
  const roots = executor?.sandboxRoots ?? []
  if (roots.length === 0) return { ok: true, cwd: resolved }
  for (const root of roots) {
    const r = resolvePath(root)
    if (resolved === r || resolved.startsWith(r + sep)) {
      return { ok: true, cwd: resolved }
    }
  }
  return {
    ok: false,
    reason: 'cwd outside sandbox roots',
  }
}

function validateWorkspaceCwd(
  deps: DashboardDeps,
  workspaceId: string,
  cwd: string,
): { ok: true; cwd: string } | { ok: false; reason: string } {
  const trimmed = cwd.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'cwd is empty' }
  const resolved = resolvePath(trimmed)
  const executor = deps.executors.snapshot().find((e) => e.workspaceId === workspaceId)
  if (!executor) return { ok: false, reason: 'workspace offline' }
  const roots = executor.sandboxRoots ?? []
  if (roots.length === 0) return { ok: true, cwd: resolved }
  for (const root of roots) {
    const r = resolvePath(root)
    if (resolved === r || resolved.startsWith(r + sep)) {
      return { ok: true, cwd: resolved }
    }
  }
  return {
    ok: false,
    reason: 'cwd outside sandbox roots',
  }
}

async function broadcastSessionList(deps: DashboardDeps): Promise<void> {
  const sessions = await deps.store.listSummaries()
  deps.dashboardNs.emit('server:sessions', { sessions })
}

export function readyEventFor(
  record: SessionRecord,
  selectedModel?: string,
): SessionReadyEvent {
  return {
    sessionId: record.sessionId,
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

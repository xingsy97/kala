/**
 * Socket.IO server with `/dashboard` and `/executor` namespaces.
 *
 * Owns handshake auth, room fan-out, and the wiring from wire events to the
 * host loop's `dispatch`. Keep protocol-mapping code here; keep semantics in
 * the loop.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve as resolvePath, sep } from 'node:path'

import type {
  ClientCancel,
  ClientCancelStream,
  ClientCompact,
  ClientCreateSession,
  ClientFork,
  ClientListDirs,
  ClientListExecutors,
  ClientListSessions,
  ClientLoadHistory,
  ClientDeleteSession,
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
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ExecutorToolResult,
  HandshakeAuth,
  ModelInfo,
  ServerHistoryPayload,
  ServerModelsPayload,
  SessionErrorEvent,
  SessionErrorScope,
  SessionForkedEvent,
  SessionReadyEvent,
} from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  RequestApprovalEffect,
} from '@agent-kernel/kernel'
import { createInitialState, fold } from '@agent-kernel/kernel'
import { Server as IOServer, type Namespace } from 'socket.io'
import { ulid } from 'ulid'

import type { LLMAdapter } from './llm/adapter.js'
import type { LoopBroadcast, LoopHandle } from './loop.js'
import { runHostLoop } from './loop.js'
import type { HookConfig, HookPayload, HookRunner } from './hooks.js'
import { selectHooks } from './hooks.js'
import { readSessionLog } from './store/log.js'
import { SessionStore, type SessionRecord } from './store/session.js'
import {
  createExecutorRegistry,
  DEFAULT_TOOL_TIMEOUT_MS,
} from './connection/executor.js'

type QueuedUserMessage = {
  text: string
  content?: readonly import('@agent-kernel/kernel').MessageContent[]
}

type MessageQueueManager = {
  enqueue(sessionId: string, msg: QueuedUserMessage, priority?: 'front'): void
  pending(sessionId: string): number
  drain(sessionId: string): Promise<void>
}

function isRestingStatus(status: AgentState['status']): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

export type HostServerOptions = {
  port: number
  sessionsDir: string
  llm: LLMAdapter
  defaultConfig: AgentConfig
  toolTimeoutMs?: number
  authToken?: string
  httpServer?: HttpServer
  staticDir?: string
  /**
   * Advertised via `GET /models`. When absent the endpoint returns an empty
   * list and the dashboard falls back to whatever the current session says.
   * The CLI populates this from `~/.claude/settings.json` + `~/.codex/config.toml`.
   */
  models?: readonly ModelInfo[]
  defaultModel?: string
  /**
   * User-configured hooks (from `~/.config/agent-kernel/config.toml`). When
   * present the loop invokes matching hooks around every tool dispatch;
   * session_start / session_end hooks fire from server.ts around
   * create/delete.
   */
  hooks?: readonly HookConfig[]
  hookRunner?: HookRunner
}

export type HostServer = {
  readonly io: IOServer
  readonly http: HttpServer
  readonly loop: LoopHandle
  readonly store: SessionStore
  readonly port: number
  close(): Promise<void>
}

type DashboardNs = Namespace<
  DashboardClientToServerEvents,
  DashboardServerToClientEvents
>
type ExecutorNs = Namespace<
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents
>

export async function startHostServer(
  options: HostServerOptions,
): Promise<HostServer> {
  const http = options.httpServer ?? createServer()
  const io = new IOServer(http, {
    cors: { origin: '*' },
  })

  attachJsonRoutes(http, {
    models: options.models ?? [],
    defaultModel: options.defaultModel ?? '',
  })

  if (options.staticDir) {
    attachStaticHandler(http, options.staticDir)
  }

  const store = new SessionStore(options.sessionsDir)
  const executors = createExecutorRegistry(
    io,
    { workspaceIdFor: (sid) => store.get(sid)?.workspaceId },
    options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  )

  // Per-session model override, keyed by sessionId. Ephemeral: not persisted
  // to the JSONL log (the log tracks conversation, not runtime knobs). If
  // the host restarts, sessions revert to the adapter's construction-time
  // default model until the dashboard sets one again.
  const selectedModels = new Map<string, string>()
  const queuedMessages = new Map<string, QueuedUserMessage[]>()
  const drainingQueues = new Set<string>()

  const dashboardNs: DashboardNs = io.of('/dashboard')
  const executorNs: ExecutorNs = io.of('/executor')

  let loop: LoopHandle
  const messageQueues: MessageQueueManager = {
    enqueue(sessionId, msg, priority) {
      const queue = queuedMessages.get(sessionId) ?? []
      if (priority === 'front') queue.unshift(msg)
      else queue.push(msg)
      queuedMessages.set(sessionId, queue)
      dashboardNs.to(`session:${sessionId}`).emit('server:message_queue', {
        sessionId,
        pending: queue.length,
      })
    },
    pending(sessionId) {
      return queuedMessages.get(sessionId)?.length ?? 0
    },
    async drain(sessionId) {
      if (drainingQueues.has(sessionId)) return
      drainingQueues.add(sessionId)
      try {
        while (true) {
          const queue = queuedMessages.get(sessionId) ?? []
          if (queue.length === 0) return
          let record = store.get(sessionId)
          if (!record) {
            try {
              record = await store.load(sessionId)
            } catch {
              return
            }
          }
          if (!record || !isRestingStatus(record.state.status)) return
          const next = queue.shift()
          dashboardNs.to(`session:${sessionId}`).emit('server:message_queue', {
            sessionId,
            pending: queue.length,
          })
          if (queue.length === 0) queuedMessages.delete(sessionId)
          if (!next) return
          await loop.dispatch(sessionId, {
            kind: 'user_message',
            text: next.text,
            ...(next.content ? { content: next.content } : {}),
          })
        }
      } finally {
        drainingQueues.delete(sessionId)
      }
    },
  }

  const broadcast: LoopBroadcast = {
    onEvent(sessionId, seq, event, effects, state) {
      const room = `session:${sessionId}`
      io.of('/dashboard').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects,
      })
      io.of('/dashboard').to(room).emit('state:changed', {
        sessionId,
        cursor: state.cursor,
        state,
      })
      io.of('/executor').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects,
      })
      io.of('/executor').to(room).emit('state:changed', {
        sessionId,
        cursor: state.cursor,
        state,
      })
      if (isRestingStatus(state.status) && messageQueues.pending(sessionId) > 0) {
        setTimeout(() => {
          void messageQueues.drain(sessionId)
        }, 0)
      }
    },
    onApprovalRequired(sessionId, eff: RequestApprovalEffect) {
      io.of('/dashboard').to(`session:${sessionId}`).emit('approval:required', {
        sessionId,
        callId: eff.callId,
        name: eff.name,
        input: eff.input,
      })
    },
    onError(sessionId, message) {
      const payload: SessionErrorEvent = {
        sessionId,
        scope: 'llm',
        message,
      }
      io.of('/dashboard').to(`session:${sessionId}`).emit('session:error', payload)
      io.of('/executor').to(`session:${sessionId}`).emit('session:error', payload)
    },
    onUsageChanged(sessionId, state) {
      io.of('/dashboard').to(`session:${sessionId}`).emit('usage:updated', {
        sessionId,
        usage: state.usage,
      })
    },
    onTokenDelta(sessionId, text) {
      io.of('/dashboard').to(`session:${sessionId}`).emit('session:token_delta', {
        sessionId,
        text,
      })
    },
  }

  loop = runHostLoop({
    store,
    llm: options.llm,
    tools: executors,
    broadcast,
    models: {
      get: (sessionId) => selectedModels.get(sessionId),
    },
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.hookRunner !== undefined ? { hookRunner: options.hookRunner } : {}),
  })

  const fireLifecycleHook = async (
    event: 'session_start' | 'session_end',
    record: SessionRecord,
  ): Promise<void> => {
    const hooks = options.hooks
    const runner = options.hookRunner
    if (!hooks || !runner || hooks.length === 0) return
    const matching = selectHooks(hooks, event)
    if (matching.length === 0) return
    const payload: HookPayload = {
      event,
      sessionId: record.sessionId,
      ...(record.workspaceId !== undefined
        ? { workspaceId: record.workspaceId }
        : {}),
    }
    for (const hook of matching) {
      try {
        await runner.run(hook, payload)
      } catch {
        // Lifecycle hooks are advisory — one failing hook must not block
        // session creation or deletion.
      }
    }
  }

  configureDashboardNamespace(dashboardNs, {
    store,
    loop,
    executors,
    defaultConfig: options.defaultConfig,
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    broadcastError,
    selectedModels,
    dashboardNs,
    messageQueues,
    onSessionCreated: (record) => fireLifecycleHook('session_start', record),
    onSessionDeleted: (record) => fireLifecycleHook('session_end', record),
  })
  configureExecutorNamespace(executorNs, {
    store,
    executors,
    defaultConfig: options.defaultConfig,
    authToken: options.authToken,
    broadcastError,
  })

  // Executor attach/detach/updated events fan out to every connected
  // dashboard socket (not scoped to a session room) — the Workspaces column
  // shows all daemons, not just the one for the currently-selected session.
  executors.onChange((change) => {
    dashboardNs.emit('server:executor_changed', change)
  })

  function broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void {
    const payload: SessionErrorEvent = { sessionId, scope, message }
    dashboardNs.to(`session:${sessionId}`).emit('session:error', payload)
    executorNs.to(`session:${sessionId}`).emit('session:error', payload)
  }

  await new Promise<void>((resolve) => {
    if (http.listening) {
      resolve()
      return
    }
    http.listen(options.port, () => resolve())
  })
  const addr = http.address()
  const port =
    typeof addr === 'object' && addr && 'port' in addr ? addr.port : options.port

  return {
    io,
    http,
    loop,
    store,
    port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        io.close((err) => (err ? reject(err) : resolve()))
      })
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
      })
    },
  }
}

// ============================================================================
// Dashboard namespace
// ============================================================================

type DashboardDeps = {
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

function configureDashboardNamespace(ns: DashboardNs, deps: DashboardDeps): void {
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
    socket.on('client:list_dirs', async (p: ClientListDirs) => {
      const result = await deps.executors.listDirs(p.workspaceId, p.path, p.requestId)
      socket.emit('server:dir_list', result)
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
    text: p.text,
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

function readyEventFor(
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
function ephemeralReadyEventFor(
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

// ============================================================================
// Executor namespace
// ============================================================================

type ExecutorDeps = {
  store: SessionStore
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig
  authToken?: string
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
}

function configureExecutorNamespace(ns: ExecutorNs, deps: ExecutorDeps): void {
  ns.use((socket, nextFn) => {
    const auth = socket.handshake.auth as HandshakeAuth | undefined
    if (!auth || auth.role !== 'executor') {
      nextFn(new Error('role_mismatch'))
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
    socket.on('disconnect', () => {
      deps.executors.detach(socket)
    })
  })
}

// ============================================================================
// Static file serving (dashboard bundle)
// ============================================================================

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function attachJsonRoutes(
  server: HttpServer,
  payloads: { models: readonly ModelInfo[]; defaultModel: string },
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    // Strip query string / fragment before matching, so `/models?ts=…`
    // (cache-buster) still hits.
    const path = url.split('?')[0]!.split('#')[0]
    if (path !== '/models') return
    const body: ServerModelsPayload = {
      models: payloads.models,
      defaultModel: payloads.defaultModel,
    }
    const json = JSON.stringify(body)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(json).toString(),
    })
    if (req.method === 'HEAD') return res.end()
    res.end(json)
  })
}

function attachStaticHandler(server: HttpServer, staticDir: string): void {
  const root = resolvePath(staticDir)
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // Socket.IO's own request listener handles /socket.io/*; skip so we don't
    // clobber its response.
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    // Another handler (e.g. `/models` JSON) may have already responded.
    if (res.headersSent || res.writableEnded) return

    void serveStatic(root, req, res)
  })
}

async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const requested = decodeURIComponent(url.pathname)
  const rel = normalize(requested).replace(/^[/\\]+/, '')
  const abs = join(root, rel)
  // Reject traversal above root.
  if (!abs.startsWith(root + sep) && abs !== root) {
    res.writeHead(403).end()
    return
  }

  const filePath = await pickFile(abs, root)
  if (!filePath) {
    res.writeHead(404).end('not found')
    return
  }
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

async function pickFile(abs: string, root: string): Promise<string | null> {
  try {
    const st = await stat(abs)
    if (st.isFile()) return abs
    if (st.isDirectory()) {
      const idx = join(abs, 'index.html')
      try {
        const s = await stat(idx)
        if (s.isFile()) return idx
      } catch {}
    }
  } catch {}
  // SPA fallback: unknown routes serve index.html (client-side routing).
  const fallback = join(root, 'index.html')
  try {
    const s = await stat(fallback)
    if (s.isFile()) return fallback
  } catch {}
  return null
}

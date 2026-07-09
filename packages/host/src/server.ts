/**
 * Socket.IO server with `/dashboard` and `/executor` namespaces, plus HTTP
 * routes for `/models`, `/settings`, and (optionally) the dashboard bundle.
 *
 * `startHostServer` wires the layers together and returns handles; the
 * namespace-specific event bindings live in `connection/dashboard-ns.ts`
 * and `connection/executor-ns.ts`, and the HTTP routing lives in
 * `http/routes.ts`. This file's job is to construct the pieces and expose
 * a single `close()` for shutdown.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'

import type {
  ModelInfo,
  ServerMessageQueueEvent,
  ServerSettingsPayload,
  SessionErrorEvent,
  SessionErrorScope,
} from '@agent-kernel/shared'
import type {
  AgentConfig,
  RequestApprovalEffect,
} from '@agent-kernel/kernel'
import { Server as IOServer } from 'socket.io'

import type { LLMAdapter } from './llm/adapter.js'
import type { LoopBroadcast, LoopHandle } from './loop.js'
import { runHostLoop } from './loop.js'
import type { HookConfig, HookPayload, HookRunner } from './extensions/hooks.js'
import { selectHooks } from './extensions/hooks.js'
import { createSkillManager, defaultSkillRoots, discoverSkills, type SkillManager, type SkillRegistry } from './extensions/skills.js'
import { SessionStore, type SessionRecord } from './store/session.js'
import { WorkspaceAliasStore } from './store/workspace-alias.js'
import {
  createExecutorRegistry,
  DEFAULT_TOOL_TIMEOUT_MS,
} from './connection/executor.js'
import {
  configureDashboardNamespace,
  type DashboardNs,
  type MessageQueueManager,
  type QueuedUserMessage,
  isRestingStatus,
} from './connection/dashboard-ns.js'
import {
  configureExecutorNamespace,
  type ExecutorNs,
} from './connection/executor-ns.js'
import { attachJsonRoutes, attachReleaseAssetsHandler, attachRequestHandler, attachStaticHandler } from './http/routes.js'
import type { AuthConfig } from './auth-control.js'
import type { AuditLogger } from './audit-log.js'
import { noopAuditLogger } from './audit-log.js'

export type HostServerOptions = {
  port: number
  sessionsDir: string
  llm: LLMAdapter
  defaultConfig: AgentConfig
  toolTimeoutMs?: number
  /**
   * Grace window after an executor disconnects before its "detached" event
   * fans out to dashboards and pending tool calls are failed. Covers routine
   * process restarts. Set to 0 in tests to keep the old instant-detach
   * behavior. Defaults to DETACH_GRACE_MS.
   */
  detachGraceMs?: number
  authToken?: string
  auth?: AuthConfig
  audit?: AuditLogger
  httpServer?: HttpServer
  staticDir?: string
  dashboardHandler?: (req: IncomingMessage, res: ServerResponse) => void
  releaseAssetsDir?: string
  /**
   * Advertised via `GET /models`. When absent the endpoint returns an empty
   * list and the dashboard falls back to whatever the current session says.
   * The CLI populates this from `~/.claude/settings.json` + `~/.codex/config.toml`.
   */
  models?: readonly ModelInfo[] | (() => readonly ModelInfo[])
  defaultModel?: string | (() => string)
  /**
   * User-configured hooks (from `~/.config/agent-kernel/config.toml`). When
   * present the loop invokes matching hooks around every tool dispatch;
   * session_start / session_end hooks fire from server.ts around
   * create/delete.
   */
  hooks?: readonly HookConfig[]
  hookRunner?: HookRunner
  skills?: SkillRegistry | SkillManager
  artifactRootDir?: string | false
  /**
   * Advertised via `GET /settings`. Read-only settings snapshot for the
   * dashboard's Settings dialog — providers, hooks, MCP status, config
   * file paths. Never carries API keys or command args beyond what the
   * operator already put in their config.
   */
  settings?: ServerSettingsPayload | (() => ServerSettingsPayload)
  addManualModel?: Parameters<typeof attachJsonRoutes>[1]['addManualModel']
  deleteManualModel?: Parameters<typeof attachJsonRoutes>[1]['deleteManualModel']
  routerHealth?: () => unknown
}

export type HostServer = {
  readonly io: IOServer
  readonly http: HttpServer
  readonly loop: LoopHandle
  readonly store: SessionStore
  readonly port: number
  close(): Promise<void>
}

export async function startHostServer(
  options: HostServerOptions,
): Promise<HostServer> {
  const auth: AuthConfig | undefined = options.auth ?? (options.authToken ? { sharedToken: options.authToken } : undefined)
  const audit = options.audit ?? noopAuditLogger
  const http = options.httpServer ?? createServer()
  const allowedOrigins = parseAllowedOrigins(process.env.AGENT_KERNEL_ALLOWED_ORIGINS)
  const io = new IOServer(http, {
    cors: allowedOrigins === null ? { origin: '*' } : { origin: allowedOrigins, credentials: true },
  })

  const store = new SessionStore(options.sessionsDir)
  const defaultSkillRootsList = defaultSkillRoots()
  const defaultSkillRegistry = await discoverSkills(defaultSkillRootsList)
  const workspaceAliases = new WorkspaceAliasStore(join(options.sessionsDir, '..', 'workspace-aliases.json'))
  await workspaceAliases.load()

  const executors = createExecutorRegistry(
    io,
    { workspaceIdFor: (sid) => store.get(sid)?.workspaceId },
    options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    audit,
    options.detachGraceMs,
  )

  const settingsWithSkills = (settings: ServerSettingsPayload | (() => ServerSettingsPayload)) => (): ServerSettingsPayload => {
    const base = typeof settings === 'function'
      ? settings()
      : settings
    return {
      ...base,
      skills: {
        count: defaultSkillRegistry.skills.length,
        roots: defaultSkillRootsList,
        diagnostics: defaultSkillRegistry.diagnostics,
      },
    }
  }

  attachJsonRoutes(http, {
    models: options.models ?? [],
    defaultModel: options.defaultModel ?? '',
    ...(options.settings ? { settings: settingsWithSkills(options.settings) } : {}),
    ...(options.addManualModel ? { addManualModel: options.addManualModel } : {}),
    ...(options.deleteManualModel ? { deleteManualModel: options.deleteManualModel } : {}),
    ...(options.artifactRootDir !== undefined ? { artifactRootDir: options.artifactRootDir } : {}),
    ...(options.routerHealth ? { routerHealth: options.routerHealth } : {}),
    ...(auth ? { auth } : {}),
    audit,
    sessions: store,
    executorsSnapshot: () => executors.snapshot().map((executor) => workspaceAliases.apply(executor)),
  })

  if (options.dashboardHandler) {
    if (options.releaseAssetsDir) attachReleaseAssetsHandler(http, options.releaseAssetsDir)
    attachRequestHandler(http, options.dashboardHandler)
  } else if (options.staticDir) {
    if (options.releaseAssetsDir) attachReleaseAssetsHandler(http, options.releaseAssetsDir)
    attachStaticHandler(http, options.staticDir)
  } else if (options.releaseAssetsDir) {
    attachReleaseAssetsHandler(http, options.releaseAssetsDir)
  }

  // Per-session model override, keyed by sessionId. Ephemeral: not persisted
  // to the JSONL log (the log tracks conversation, not runtime knobs). If
  // the host restarts, sessions revert to the adapter's construction-time
  // default model until the dashboard sets one again.
  const selectedModels = new Map<string, string>()
  const queuedMessages = new Map<string, QueuedUserMessage[]>()
  const drainingQueues = new Set<string>()

  const dashboardNs: DashboardNs = io.of('/dashboard') as unknown as DashboardNs
  const executorNs: ExecutorNs = io.of('/executor') as unknown as ExecutorNs

  let loop: LoopHandle
  const queueSnapshot = (sessionId: string): ServerMessageQueueEvent => {
    const queue = queuedMessages.get(sessionId) ?? []
    return {
      sessionId,
      pending: queue.length,
      items: queue.map((item) => ({
        id: item.id,
        text: item.text,
        mode: item.mode,
        createdAt: item.createdAt,
      })),
    }
  }

  const emitQueueUpdate = (sessionId: string): void => {
    dashboardNs.to(`session:${sessionId}`).emit('server:message_queue', queueSnapshot(sessionId))
  }

  const messageQueues: MessageQueueManager = {
    enqueue(sessionId, msg, priority) {
      const queue = queuedMessages.get(sessionId) ?? []
      if (priority === 'front') queue.unshift(msg)
      else queue.push(msg)
      queuedMessages.set(sessionId, queue)
      emitQueueUpdate(sessionId)
    },
    reorder(sessionId, id, beforeId) {
      const queue = queuedMessages.get(sessionId) ?? []
      const from = queue.findIndex((item) => item.id === id)
      if (from === -1) return
      const [item] = queue.splice(from, 1)
      if (!item) return
      const to = beforeId ? queue.findIndex((candidate) => candidate.id === beforeId) : -1
      if (to === -1) queue.push(item)
      else queue.splice(to, 0, item)
      if (queue.length === 0) queuedMessages.delete(sessionId)
      else queuedMessages.set(sessionId, queue)
      emitQueueUpdate(sessionId)
    },
    update(sessionId, id, text) {
      const queue = queuedMessages.get(sessionId) ?? []
      const index = queue.findIndex((item) => item.id === id)
      if (index === -1) return
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      queue[index] = { ...queue[index]!, text: trimmed }
      queuedMessages.set(sessionId, queue)
      emitQueueUpdate(sessionId)
    },
    delete(sessionId, id) {
      const queue = queuedMessages.get(sessionId) ?? []
      const next = queue.filter((item) => item.id !== id)
      if (next.length === queue.length) return
      if (next.length === 0) queuedMessages.delete(sessionId)
      else queuedMessages.set(sessionId, next)
      emitQueueUpdate(sessionId)
    },
    pending(sessionId) {
      return queuedMessages.get(sessionId)?.length ?? 0
    },
    snapshot: queueSnapshot,
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
          if (queue.length === 0) queuedMessages.delete(sessionId)
          emitQueueUpdate(sessionId)
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
    onEvent(sessionId, seq, event, effects, state, llmTrace, model) {
      const room = `session:${sessionId}`
      io.of('/dashboard').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects,
        ...(llmTrace ? { llmTrace } : {}),
        ...(model ? { model } : {}),
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
        ...(llmTrace ? { llmTrace } : {}),
        ...(model ? { model } : {}),
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
    onTokenDelta(sessionId, text) {
      io.of('/dashboard').to(`session:${sessionId}`).emit('session:token_delta', {
        sessionId,
        text,
      })
    },
    onSubAgentStarted(payload) {
      const room = `session:${payload.parentSessionId}`
      io.of('/dashboard').to(room).emit('server:sub_agent_started', payload)
      io.of('/dashboard').to(room).emit('server:control_update', {
        kind: 'sub_agent_started',
        ...payload,
      })
    },
    onSubAgentFinished(payload) {
      const room = `session:${payload.parentSessionId}`
      io.of('/dashboard').to(room).emit('server:sub_agent_finished', payload)
      io.of('/dashboard').to(room).emit('server:control_update', {
        kind: 'sub_agent_finished',
        ...payload,
      })
    },
  }

  const skills = options.skills ?? createSkillManager(store, options.defaultConfig)

  const loopDeps = {
    store,
    llm: options.llm,
    tools: executors,
    broadcast,
    models: {
      get: (sessionId: string) => selectedModels.get(sessionId),
    },
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.hookRunner !== undefined ? { hookRunner: options.hookRunner } : {}),
    skills,
    ...(options.artifactRootDir ? { artifactRootDir: options.artifactRootDir } : {}),
  }
  loop = runHostLoop(loopDeps)

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
    loopDeps,
    executors,
    defaultConfig: options.defaultConfig,
    ...(auth ? { auth } : {}),
    audit,
    broadcastError,
    selectedModels,
    dashboardNs,
    messageQueues,
    executorSnapshot: () => executors.snapshot().map((executor) => workspaceAliases.apply(executor)),
    renameWorkspace: async (workspaceId, workspaceName) => {
      const applied = await workspaceAliases.rename(workspaceId, workspaceName)
      await store.renameWorkspace(workspaceId, applied)
      executors.renameWorkspace(workspaceId, applied)
      return applied
    },
    onSessionCreated: (record) => fireLifecycleHook('session_start', record),
    onSessionDeleted: (record) => fireLifecycleHook('session_end', record),
  })
  configureExecutorNamespace(executorNs, {
    store,
    executors,
    defaultConfig: options.defaultConfig,
    ...(auth ? { auth } : {}),
    audit,
    broadcastError,
    dashboardNs,
  })

  // Executor attach/detach/updated events fan out to every connected
  // dashboard socket (not scoped to a session room) — the Workspaces column
  // shows all daemons, not just the one for the currently-selected session.
  executors.onChange((change) => {
    const effectiveChange = 'executor' in change
      ? { ...change, executor: workspaceAliases.apply(change.executor) }
      : change
    dashboardNs.emit('server:executor_changed', effectiveChange)
    dashboardNs.emit('server:control_update', {
      kind: 'executor_changed',
      ...effectiveChange,
    })
  })

  function broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void {
    const payload: SessionErrorEvent = { sessionId, scope, message }
    dashboardNs.to(`session:${sessionId}`).emit('session:error', payload)
    // Executor no longer subscribes to session:error — it's UI-only.
  }

  await new Promise<void>((resolve, reject) => {
    if (http.listening) {
      resolve()
      return
    }
    const onError = (err: NodeJS.ErrnoException): void => {
      http.off('listening', onListening)
      const message = err.code === 'EADDRINUSE'
        ? `Port ${options.port} is already in use. Stop the process using it or start the host with HOST_PORT=<free-port> or --port <free-port>.`
        : `Failed to start host on port ${options.port}: ${err.message}`
      const wrapped = new Error(message)
      wrapped.cause = err
      reject(wrapped)
    }
    const onListening = (): void => {
      http.off('error', onError)
      resolve()
    }
    http.once('error', onError)
    http.listen(options.port, onListening)
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

/**
 * Parse AGENT_KERNEL_ALLOWED_ORIGINS ("http://a.example.test,http://b.example.test").
 * Returns null when unset/empty (means "keep permissive default"),
 * a string[] otherwise.
 */
function parseAllowedOrigins(raw: string | undefined): string[] | null {
  if (!raw) return null
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list : null
}

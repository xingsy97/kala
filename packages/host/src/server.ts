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

import type {
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  ModelInfo,
  ServerMessageQueueEvent,
  ServerSettingsPayload,
  SessionErrorEvent,
  SessionErrorScope,
} from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentState,
  MessageContent,
  RequestApprovalEffect,
} from '@agent-kernel/kernel'
import { Server as IOServer, type Namespace } from 'socket.io'

import type { LLMAdapter } from './llm/adapter.js'
import type { LoopBroadcast, LoopHandle } from './loop.js'
import { runHostLoop } from './loop.js'
import type { HookConfig, HookPayload, HookRunner } from './hooks.js'
import { selectHooks } from './hooks.js'
import type { SkillRegistry } from './skills.js'
import { SessionStore, type SessionRecord } from './store/session.js'
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
import { attachJsonRoutes, attachRequestHandler, attachStaticHandler } from './http/routes.js'

export type HostServerOptions = {
  port: number
  sessionsDir: string
  llm: LLMAdapter
  defaultConfig: AgentConfig
  toolTimeoutMs?: number
  authToken?: string
  httpServer?: HttpServer
  staticDir?: string
  dashboardHandler?: (req: IncomingMessage, res: ServerResponse) => void
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
  skills?: SkillRegistry
  /**
   * Advertised via `GET /settings`. Read-only settings snapshot for the
   * dashboard's Settings dialog  -  providers, hooks, MCP status, config
   * file paths. Never carries API keys or command args beyond what the
   * operator already put in their config.
   */
  settings?: ServerSettingsPayload | (() => ServerSettingsPayload)
  addManualModel?: Parameters<typeof attachJsonRoutes>[1]['addManualModel']
  deleteManualModel?: Parameters<typeof attachJsonRoutes>[1]['deleteManualModel']
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
  const http = options.httpServer ?? createServer()
  const io = new IOServer(http, {
    cors: { origin: '*' },
  })

  attachJsonRoutes(http, {
    models: options.models ?? [],
    defaultModel: options.defaultModel ?? '',
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.addManualModel ? { addManualModel: options.addManualModel } : {}),
    ...(options.deleteManualModel ? { deleteManualModel: options.deleteManualModel } : {}),
  })

  if (options.dashboardHandler) {
    attachRequestHandler(http, options.dashboardHandler)
  } else if (options.staticDir) {
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
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
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
        // Lifecycle hooks are advisory  -  one failing hook must not block
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
    dashboardNs,
  })

  // Executor attach/detach/updated events fan out to every connected
  // dashboard socket (not scoped to a session room)  -  the Workspaces column
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

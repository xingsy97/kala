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
  AttachedExecutor,
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
import { instrument } from '@socket.io/admin-ui'
import { ulid } from 'ulid'

import type { LLMAdapter } from './llm/adapter.js'
import type { LoopBroadcast, LoopHandle } from './loop.js'
import { runHostLoop } from './loop.js'
import type { HookConfig, HookPayload, HookRunner } from './extensions/hooks.js'
import { selectHooks } from './extensions/hooks.js'
import { createSkillManager, defaultSkillRoots, discoverSkills, type SkillManager, type SkillRegistry } from './extensions/skills.js'
import { SessionStore, type SessionRecord } from './store/session.js'
import { slimEffect } from './store/log.js'
import { WorkspaceAliasStore } from './store/workspace-alias.js'
import { PushSubscriptionStore } from './push/store.js'
import { loadOrCreateVapidKeys } from './push/vapid.js'
import { createPushDispatcher } from './push/dispatch.js'
import { createPushRoutes } from './push/routes.js'
import { PushActivityTracker } from './push/activity.js'
import { OperationalMetrics } from './operational-metrics.js'
import {
  createExecutorRegistry,
  DEFAULT_TOOL_ACK_TIMEOUT_MS,
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
import { sessionRoom } from './connection/rooms.js'
import { attachDynamicStaticMountHandler, attachEmbeddedStaticHandler, attachJsonRoutes, attachReleaseAssetsHandler, claimRoute, attachRequestHandler, attachStaticHandler, type EmbeddedStaticAsset, type StaticMount } from './http/routes.js'
import { SessionArtifactRegistry } from './session-artifact-registry.js'
import { MemoStore } from './memo-store.js'
import type { AuthConfig } from './auth-control.js'
import type { AuditLogger } from './audit-log.js'
import { noopAuditLogger } from './audit-log.js'
import { snapshotFromConfig, type ContextWindowOverride } from './context/manager.js'
import { setWireValidationLogger } from './wire-validation.js'
import type { RuntimeLogger } from './logger.js'
import type { DeploymentMode, RuntimeCapabilities } from '@agent-kernel/shared'
import { FULL_RUNTIME_CAPABILITIES, SOCKET_MAX_HTTP_BUFFER_BYTES } from '@agent-kernel/shared'
import type { SocketAdminConfig } from './socket-admin.js'
import { defaultRestartStatePath, RestartCoordinator } from './restart-coordinator.js'
import { inspectUnitQuiescence } from './tenant-runtime/quiescence.js'
import { socketConnectionAuditSnapshot } from './connection/socket-audit.js'
import { loadPersistedMessageQueue, persistMessageQueueSnapshot } from './message-queue-store.js'
import { readSessionLog } from './store/log.js'
import { modelIdFromRef, resolveModelContextWindow } from './model-capabilities.js'
import type { WebSearchCredentialStore } from './web-search/index.js'
import type { WebSearchCredentialStatus } from './web-search/credential-store.js'
import { ExecutorInstallationStore } from './store/executor-installation.js'
import { attachExecutorInstallationRoutes } from './http/executor-installation-routes.js'

export type HostServerOptions = {
  port: number
  listenHost?: string
  sessionsDir: string
  llm: LLMAdapter
  defaultConfig: AgentConfig | (() => AgentConfig)
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
  embeddedStaticAssets?: readonly EmbeddedStaticAsset[]
  embeddedSocketAdminAssets?: readonly EmbeddedStaticAsset[]
  embeddedReleaseAssets?: readonly EmbeddedStaticAsset[]
  dashboardHandler?: (req: IncomingMessage, res: ServerResponse) => void
  releaseAssetsDir?: string
  socketAdmin?: SocketAdminConfig
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
  webSearchCredentials?: WebSearchCredentialStore
  webSearchCredentialStatus?: () => Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
  setWebSearchCredential?: (provider: 'serper', key: string) => Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
  deleteWebSearchCredential?: (provider: 'serper') => Promise<WebSearchCredentialStatus> | WebSearchCredentialStatus
  artifactRootDir?: string | false
  docsRootDir?: string
  /**
   * Advertised via `GET /settings`. Read-only settings snapshot for the
   * dashboard's Settings dialog — providers, hooks, MCP status, config
   * file paths. Never carries API keys or command args beyond what the
   * operator already put in their config.
   */
  settings?: ServerSettingsPayload | (() => ServerSettingsPayload)
  addManualModel?: Parameters<typeof attachJsonRoutes>[1]['addManualModel']
  deleteManualModel?: Parameters<typeof attachJsonRoutes>[1]['deleteManualModel']
  addManualProvider?: Parameters<typeof attachJsonRoutes>[1]['addManualProvider']
  deleteManualProvider?: Parameters<typeof attachJsonRoutes>[1]['deleteManualProvider']
  setDefaultModel?: Parameters<typeof attachJsonRoutes>[1]['setDefaultModel']
  updateAgentPrompt?: Parameters<typeof attachJsonRoutes>[1]['updateAgentPrompt']
  initializeSocketAdmin?: (input: { password: string; mode?: 'development' | 'production'; activate: (config: SocketAdminConfig) => void }) => ServerSettingsPayload
  updateSocketAdminMode?: Parameters<typeof attachJsonRoutes>[1]['updateSocketAdminMode']
  routerHealth?: () => unknown
  logger?: Pick<RuntimeLogger, 'warn'>
  deploymentMode?: DeploymentMode
  capabilities?: RuntimeCapabilities
  /** Standalone defaults to true; embedders may explicitly retain the guard. */
  allowAllApprovalMode?: boolean
}

export type HostServer = {
  readonly io: IOServer
  readonly http: HttpServer
  readonly loop: LoopHandle
  readonly store: SessionStore
  readonly executorsSnapshot: () => readonly AttachedExecutor[]
  readonly port: number
  close(): Promise<void>
}

export async function startHostServer(
  options: HostServerOptions,
): Promise<HostServer> {
  if (options.logger) {
    setWireValidationLogger((entry) => {
      options.logger?.warn(entry, 'wire validation failed')
    })
  }
  const auth: AuthConfig | undefined = options.auth ?? (options.authToken ? { sharedToken: options.authToken } : undefined)
  const deploymentMode = options.deploymentMode ?? 'standalone'
  const metrics = new OperationalMetrics()
  metrics.increment('agent_kernel_process_starts_total', 'Host process starts', { component: 'host', deployment_mode: deploymentMode })
  const capabilities = options.capabilities ?? FULL_RUNTIME_CAPABILITIES
  const audit = options.audit ?? noopAuditLogger
  const http = options.httpServer ?? createServer()
  const allowedOrigins = parseAllowedOrigins(process.env.AGENT_KERNEL_ALLOWED_ORIGINS)
  const io = new IOServer(http, {
    cors: allowedOrigins === null ? { origin: '*' } : { origin: allowedOrigins, credentials: true },
    maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_BYTES,
    pingInterval: 20_000,
    pingTimeout: 30_000,
    connectionStateRecovery: {
      maxDisconnectionDuration: 120_000,
      // Authentication/version middleware must still run after recovery.
      skipMiddlewares: false,
    },
  })
  const TOKEN_DELTA_BATCH_MS = 16
  const tokenDeltaBatches = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()
  const flushTokenDelta = (sessionId: string): void => {
    const batch = tokenDeltaBatches.get(sessionId)
    if (!batch) return
    clearTimeout(batch.timer)
    tokenDeltaBatches.delete(sessionId)
    if (batch.text.length > 0) {
      io.of('/dashboard').to(sessionRoom(sessionId)).emit('session:token_delta', { sessionId, text: batch.text })
    }
  }
  let closed = false
  const closeServer = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const batch of tokenDeltaBatches.values()) clearTimeout(batch.timer)
    tokenDeltaBatches.clear()
    // Queue persistence and post-turn drains may still be crossing their durable
    // boundary after the last socket closes. Wait before callers remove the
    // Session directory (tests) or replace storage (shutdown/deploy).
    await Promise.allSettled([...queueLoads.values(), ...queueMutations.values()])
    for (let attempt = 0; attempt < 100 && drainingQueues.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    await new Promise<void>((resolve, reject) => {
      io.close((err) => (err ? reject(err) : resolve()))
    })
    await new Promise<void>((resolve) => {
      if (!http.listening) {
        resolve()
        return
      }
      http.close(() => resolve())
    })
  }
  let activeSocketAdmin: SocketAdminConfig | undefined
  const activateSocketAdmin = (config: SocketAdminConfig): void => {
    if (activeSocketAdmin) return
    instrument(io, {
      auth: {
        type: 'basic',
        username: config.username,
        password: config.passwordHash,
      },
      mode: config.mode,
    })
    activeSocketAdmin = config
  }
  if (options.socketAdmin) activateSocketAdmin(options.socketAdmin)

  const getDefaultConfig = (): AgentConfig => typeof options.defaultConfig === 'function'
    ? options.defaultConfig()
    : options.defaultConfig
  const store = new SessionStore(options.sessionsDir, { runtimeConfig: getDefaultConfig })
  const sessionArtifacts = new SessionArtifactRegistry(join(options.sessionsDir, '..', 'session-artifacts'))
  await sessionArtifacts.load()
  const memoStore = new MemoStore(join(options.sessionsDir, '..', 'memos'))
  const defaultSkillRootsList = defaultSkillRoots()
  const defaultSkillRegistry = await discoverSkills(defaultSkillRootsList)
  const workspaceAliases = new WorkspaceAliasStore(join(options.sessionsDir, '..', 'workspace-aliases.json'))
  await workspaceAliases.load()
  const executorInstallations = new ExecutorInstallationStore(join(options.sessionsDir, '..', 'executor-installations.json'))
  executorInstallations.load()
  attachExecutorInstallationRoutes(http, {
    store: executorInstallations,
    ...(auth?.executorIdentityStore ? { identities: auth.executorIdentityStore } : {}),
    ...(auth ? { auth } : {}),
    deploymentMode,
    audit,
  })

  // Web Push (see docs/planning/roadmap-notes/pwa-mobile-and-push.md §5).
  // Fail-open: if VAPID isn't configured / can't be generated, dispatcher
  // short-circuits and /push/vapid-public-key returns publicKey:null so the
  // dashboard hides the push UI instead of erroring on subscribe.
  const pushStore = new PushSubscriptionStore(join(options.sessionsDir, '..', 'push-subscriptions.jsonl'))
  await pushStore.load()
  const vapid = loadOrCreateVapidKeys(options.sessionsDir)
  const pushActivity = new PushActivityTracker()
  const pushDispatcher = createPushDispatcher({
    store: pushStore,
    vapid,
    shouldSuppress: () => pushActivity.hasActiveDevice(),
  })
  const pushRoutes = createPushRoutes({ store: pushStore, vapid, dispatcher: pushDispatcher, activity: pushActivity })
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost')
    if ((req.url ?? '/').split('?')[0]?.startsWith('/push/')) claimRoute(req)
    // pushRoutes returns true when it handled the request. Anything not
    // matching /push/* falls through to attachJsonRoutes and beyond.
    void pushRoutes(req, res).then((handled) => {
      if (!handled) return
      // A route handled it; nothing to do here — the response is already sent.
    }).catch((err: unknown) => {
      if (res.headersSent) return
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    })
  })

  // Per-session "last status" so we only fire waiting_for_user once per
  // transition (running → done), not on every subsequent event that carries
  // the same state.
  const lastSessionStatus = new Map<string, string>()

  const executors = createExecutorRegistry(
    io,
    { workspaceIdFor: (sid) => store.get(sid)?.workspaceId },
    options.toolTimeoutMs ?? DEFAULT_TOOL_ACK_TIMEOUT_MS,
    audit,
    options.detachGraceMs,
  )

  let restart: RestartCoordinator | undefined
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
      ...(restart ? { runtime: restart.status() } : {}),
      socketConnections: socketConnectionAuditSnapshot(io),
    }
  }

  attachJsonRoutes(http, {
    models: options.models ?? [],
    defaultModel: options.defaultModel ?? '',
    ...(options.settings ? { settings: () => ({ ...settingsWithSkills(options.settings!)(), deployment: { mode: deploymentMode, capabilities } }) } : {}),
    ...(options.addManualModel ? { addManualModel: options.addManualModel } : {}),
    ...(options.deleteManualModel ? { deleteManualModel: options.deleteManualModel } : {}),
    ...(options.addManualProvider ? { addManualProvider: options.addManualProvider } : {}),
    ...(options.deleteManualProvider ? { deleteManualProvider: options.deleteManualProvider } : {}),
    ...(options.setDefaultModel ? { setDefaultModel: options.setDefaultModel } : {}),
    ...(options.updateAgentPrompt ? { updateAgentPrompt: options.updateAgentPrompt } : {}),
    ...(options.initializeSocketAdmin ? { initializeSocketAdmin: (input: { password: string; mode?: 'development' | 'production' }) => options.initializeSocketAdmin!({ ...input, activate: activateSocketAdmin }) } : {}),
    ...(options.updateSocketAdminMode ? { updateSocketAdminMode: options.updateSocketAdminMode } : {}),
    ...(options.artifactRootDir !== undefined ? { artifactRootDir: options.artifactRootDir } : {}),
    ...(options.docsRootDir ? { docsRootDir: options.docsRootDir } : {}),
    sessionArtifacts,
    ...(options.routerHealth ? { routerHealth: options.routerHealth } : {}),
    ...(auth ? { auth } : {}),
    audit,
    capabilities,
    deploymentMode,
    metrics,
    memoStore,
    ...(options.webSearchCredentials && options.webSearchCredentialStatus && options.setWebSearchCredential && options.deleteWebSearchCredential ? {
      webSearchCredentials: {
        get: (provider: 'serper') => options.webSearchCredentials!.get(provider),
        status: options.webSearchCredentialStatus,
        set: options.setWebSearchCredential,
        delete: options.deleteWebSearchCredential,
      },
    } : {}),
    sessions: store,
    executorsSnapshot: () => executors.snapshot().map((executor) => workspaceAliases.apply(executor)),
    toolRegistry: () => (typeof options.defaultConfig === 'function' ? options.defaultConfig() : options.defaultConfig).tools,
    toolResultPersisted: async (sessionId, callId) => {
      const record = store.get(sessionId) ?? await store.load(sessionId, { recoverDangling: false }).catch(() => undefined)
      if (!record) return false
      const parsed = await readSessionLog(record.logPath)
      return parsed.events.some((entry) => entry.event.kind === 'tool_result' && entry.event.callId === callId)
    },
    restartStatus: () => restart?.status() ?? {
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      current: null,
      last: null,
    },
    requestRestart: (input) => {
      if (!restart) throw new Error('restart coordinator is not ready')
      return restart.request(input)
    },
    commitRestartActivation: (attemptId) => restart?.commitActivation(attemptId) ?? null,
    abortRestart: () => restart?.abort() ?? null,
    unitQuiescence: () => inspectUnitQuiescence({ loop, store }, messageQueues.isStable()),
    reserveCutover: async () => {
      loop.beginDrain('checkpoint')
      const sessionIds = store.list().map((record) => record.sessionId)
      await Promise.all(sessionIds.map((sessionId) => loop.waitForCheckpoint(sessionId)))
      await messageQueues.waitForStable()
      const snapshot = inspectUnitQuiescence({ loop, store }, messageQueues.isStable())
      if (!snapshot.safe) throw new Error('Unit did not reach a stable cutover boundary')
      return snapshot
    },
    releaseCutover: () => loop.endDrain(),
    enqueueUserMessage: async ({ sessionId, text }) => {
      // Persist as a queued follow-up and drain immediately. Delivered as soon
      // as any in-flight turn finishes; no live socket required.
      const operationId = ulid()
      await messageQueues.enqueue(sessionId, {
        id: operationId,
        operationId,
        text,
        mode: 'queue',
        createdAt: new Date().toISOString(),
      })
      void messageQueues.drain(sessionId)
    },
  })

  const advertisedModels = (): readonly ModelInfo[] => typeof options.models === 'function'
    ? options.models()
    : options.models ?? []
  const normalizeModelRef = (model: string): string | undefined => {
    const selected = model.trim()
    if (!selected) return undefined
    const exact = advertisedModels().find((m) => (m.ref ?? m.id) === selected)
    if (exact) return exact.ref ?? exact.id
    const byId = advertisedModels().filter((m) => m.id === selected)
    return byId.length === 1 ? byId[0]!.ref ?? byId[0]!.id : undefined
  }
  const effectiveDefaultModel = (): string | undefined => {
    const configured = typeof options.defaultModel === 'function' ? options.defaultModel() : options.defaultModel
    if (!configured) return undefined
    const fallback = configured.trim()
    return normalizeModelRef(configured) ?? (fallback.length > 0 ? fallback : undefined)
  }
  const effectiveModelForSession = (sessionId: string): string | undefined => {
    const selected = store.get(sessionId)?.preferences.selectedModel
    return (selected ? normalizeModelRef(selected) : undefined) ?? effectiveDefaultModel()
  }
  const contextWindowForModel = (model: string | undefined): ContextWindowOverride | undefined => {
    const selected = model?.trim()
    if (!selected) return undefined
    const normalized = normalizeModelRef(selected)
    if (!normalized) {
      const contextWindow = resolveModelContextWindow(selected, advertisedModels())
      return {
        model: selected,
        modelId: modelIdFromRef(selected),
        ...(contextWindow ? { contextWindow } : {}),
      }
    }
    const info = advertisedModels().find((m) => (m.ref ?? m.id) === normalized)
    if (!info) return { model: selected }
    const contextWindow = resolveModelContextWindow(normalized, advertisedModels())
    return {
      model: normalized,
      modelId: info.id,
      provider: info.providerId,
      ...(contextWindow ? { contextWindow } : {}),
    }
  }

  const socketAdminMount = (): StaticMount | undefined => activeSocketAdmin
    ? {
        path: activeSocketAdmin.path,
        ...(activeSocketAdmin.distDir ? { rootDir: activeSocketAdmin.distDir } : {}),
        ...(options.embeddedSocketAdminAssets ? { assets: options.embeddedSocketAdminAssets } : {}),
      }
    : undefined
  attachDynamicStaticMountHandler(http, socketAdminMount)

  if (options.dashboardHandler) {
    if (options.releaseAssetsDir) attachReleaseAssetsHandler(http, options.releaseAssetsDir, options.embeddedReleaseAssets)
    attachRequestHandler(http, options.dashboardHandler)
  } else if (options.staticDir) {
    if (options.releaseAssetsDir) attachReleaseAssetsHandler(http, options.releaseAssetsDir, options.embeddedReleaseAssets)
    attachStaticHandler(http, options.staticDir)
  } else if (options.embeddedStaticAssets && options.embeddedStaticAssets.length > 0) {
    if (options.releaseAssetsDir) attachReleaseAssetsHandler(http, options.releaseAssetsDir, options.embeddedReleaseAssets)
    attachEmbeddedStaticHandler(http, options.embeddedStaticAssets)
  } else if (options.releaseAssetsDir) {
    attachReleaseAssetsHandler(http, options.releaseAssetsDir, options.embeddedReleaseAssets)
  }

  const queuedMessages = new Map<string, QueuedUserMessage[]>()
  const drainingQueues = new Set<string>()
  const queueLoads = new Map<string, Promise<QueuedUserMessage[]>>()
  const queueMutations = new Map<string, Promise<void>>()

  const dashboardNs: DashboardNs = io.of('/dashboard') as unknown as DashboardNs
  const executorNs: ExecutorNs = io.of('/executor') as unknown as ExecutorNs

  let loop: LoopHandle
  const queueSnapshot = (sessionId: string): ServerMessageQueueEvent => {
    const queue = queuedMessages.get(sessionId) ?? []
    // The dock represents user-visible *queued follow-ups* only. A `steer`
    // message is a transient interrupt: it is placed at the front of the
    // internal queue purely to preserve dispatch ordering across the async
    // turn-abort, then drained on the very next tick. Surfacing it as a
    // "pending" dock item makes a steer look like it got stuck in the queue
    // (and flickers in/out within a round-trip), so exclude steer items from
    // what the dashboard renders and counts.
    const visible = queue.filter((item) => item.mode !== 'steer')
    return {
      sessionId,
      pending: visible.length,
      items: visible.map((item) => ({
        id: item.id,
        text: item.text,
        mode: item.mode,
        createdAt: item.createdAt,
        ...(item.content ? { content: item.content } : {}),
      })),
    }
  }

  const emitQueueUpdate = (sessionId: string): void => {
    dashboardNs.to(sessionRoom(sessionId)).emit('server:message_queue', queueSnapshot(sessionId))
  }

  const loadQueue = async (sessionId: string): Promise<QueuedUserMessage[]> => {
    const existing = queuedMessages.get(sessionId)
    if (existing) return existing
    let pending = queueLoads.get(sessionId)
    if (!pending) {
      pending = loadPersistedMessageQueue(store, sessionId).catch(() => [])
      queueLoads.set(sessionId, pending)
    }
    const restored = await pending
    queueLoads.delete(sessionId)
    if (restored.length > 0) queuedMessages.set(sessionId, restored)
    return queuedMessages.get(sessionId) ?? []
  }

  const persistQueue = async (sessionId: string, queue: readonly QueuedUserMessage[]): Promise<void> => {
    await persistMessageQueueSnapshot(store, sessionId, queue)
    if (queue.length === 0) queuedMessages.delete(sessionId)
    else queuedMessages.set(sessionId, [...queue])
  }

  const withQueueMutation = async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = queueMutations.get(sessionId) ?? Promise.resolve()
    let done!: () => void
    const current = new Promise<void>((resolve) => {
      done = resolve
    })
    const chain = previous.then(() => current, () => current)
    queueMutations.set(sessionId, chain)
    try {
      await previous.catch(() => {})
      return await fn()
    } finally {
      done()
      if (queueMutations.get(sessionId) === chain) queueMutations.delete(sessionId)
    }
  }

  const messageQueues: MessageQueueManager = {
    isStable() {
      return queueLoads.size === 0 && queueMutations.size === 0 && drainingQueues.size === 0
    },
    async waitForStable() {
      while (!messageQueues.isStable()) {
        await Promise.all([...queueLoads.values()].map((pending) => pending.catch(() => [])))
        await Promise.all([...queueMutations.values()].map((pending) => pending.catch(() => undefined)))
        if (drainingQueues.size > 0) await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    async hydrate(sessionId) {
      await loadQueue(sessionId)
    },
    async enqueue(sessionId, msg, priority) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        const queue = [...await loadQueue(sessionId)]
        // operationId survives ACK loss, reconnect and Host restart. A retry is
        // already accepted when it is still queued or has a durable user event.
        if (queue.some((item) => item.operationId === msg.operationId)) return
        if (await sessionHasUserOperation(store, sessionId, msg.operationId)) return
        if (priority === 'front') queue.unshift(msg)
        else queue.push(msg)
        await persistQueue(sessionId, queue)
        changed = true
      })
      if (changed) emitQueueUpdate(sessionId)
    },
    async reorder(sessionId, id, beforeId) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        const queue = [...await loadQueue(sessionId)]
        const from = queue.findIndex((item) => item.id === id)
        if (from === -1) return
        const [item] = queue.splice(from, 1)
        if (!item) return
        const to = beforeId ? queue.findIndex((candidate) => candidate.id === beforeId) : -1
        if (to === -1) queue.push(item)
        else queue.splice(to, 0, item)
        await persistQueue(sessionId, queue)
        changed = true
      })
      if (!changed) return
      emitQueueUpdate(sessionId)
    },
    async update(sessionId, id, text, content) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        const queue = [...await loadQueue(sessionId)]
        const index = queue.findIndex((item) => item.id === id)
        if (index === -1) return
        const trimmed = text.trim()
        const current = queue[index]!
        const nextContent = content ?? current.content
        const hasImages = nextContent?.some((part) => part.type === 'image') ?? false
        if (trimmed.length === 0 && !hasImages) return
        queue[index] = { ...current, text: trimmed, ...(nextContent ? { content: nextContent } : {}) }
        await persistQueue(sessionId, queue)
        changed = true
      })
      if (!changed) return
      emitQueueUpdate(sessionId)
    },
    async delete(sessionId, id) {
      let changed = false
      await withQueueMutation(sessionId, async () => {
        const queue = await loadQueue(sessionId)
        const next = queue.filter((item) => item.id !== id)
        if (next.length === queue.length) return
        await persistQueue(sessionId, next)
        changed = true
      })
      if (!changed) return
      emitQueueUpdate(sessionId)
    },
    pending(sessionId) {
      return queuedMessages.get(sessionId)?.length ?? 0
    },
    snapshot: queueSnapshot,
    async drain(sessionId) {
      if (closed || loop.isDraining() || drainingQueues.has(sessionId)) return
      drainingQueues.add(sessionId)
      try {
        while (!closed) {
          if (loop.isDraining()) return
          await loadQueue(sessionId)
          if ((queuedMessages.get(sessionId)?.length ?? 0) === 0) return
          let record = store.get(sessionId)
          if (!record) {
            try {
              record = await store.load(sessionId)
            } catch {
              return
            }
          }
          // `state.status` can briefly be `done` while dispatchOne is still
          // unwinding after an LLM/tool effect. Status alone is therefore not a
          // safe queue-drain boundary: dispatching here starts the queued turn
          // before the current serialized turn has actually ended. Wait for the
          // Loop's per-session tail to settle before re-reading state.
          if (loop.hasActiveTurn(sessionId)) {
            await loop.waitForActiveTurn(sessionId)
            if (closed) return
            record = store.get(sessionId)
            if (!record) return
          }
          if (record.state.status === 'thinking' && !loop.hasActiveLlmCall(sessionId)) {
            await loop.recoverInterruptedLlm(sessionId)
            record = store.get(sessionId)
          }
          if (!record || !isRestingStatus(record.state.status)) return
          const next = (await loadQueue(sessionId))[0]
          if (!next || closed) return
          // Dispatch first and persist the dequeue only after the durable
          // user_message commit. A crash before commit leaves the item queued;
          // a crash after commit is recognized by operationId and only removes
          // the already-dispatched item on recovery.
          const dequeueCommitted = async (): Promise<void> => {
            if (closed) return
            let changed = false
            await withQueueMutation(sessionId, async () => {
              if (closed) return
              const queue = [...await loadQueue(sessionId)]
              if (queue[0]?.id !== next.id) return
              queue.shift()
              await persistQueue(sessionId, queue)
              changed = true
            })
            if (changed && !closed) emitQueueUpdate(sessionId)
          }
          const alreadyDispatched = await sessionHasUserOperation(store, sessionId, next.operationId)
          if (!alreadyDispatched) {
            await loop.dispatch(sessionId, {
              kind: 'user_message',
              operationId: next.operationId,
              text: next.text,
              ...(next.content ? { content: next.content } : {}),
            }, { ...(next.model ? { model: next.model } : {}), onCommitted: dequeueCommitted })
          } else {
            await dequeueCommitted()
          }
        }
      } finally {
        drainingQueues.delete(sessionId)
      }
    },
  }

  async function sessionHasUserOperation(
    sessionStore: SessionStore,
    sessionId: string,
    operationId: string,
  ): Promise<boolean> {
    const record = sessionStore.get(sessionId)
    if (!record) return false
    const parsed = await readSessionLog(record.logPath)
    return parsed.events.some((entry) =>
      entry.event.kind === 'user_message' && entry.event.operationId === operationId,
    )
  }

  // Coalesce `server:sessions` broadcasts. The loop's onEvent fires once per
  // appended event, and during a tool-heavy turn that is dozens of events per
  // second — each one previously ran store.listSummaries() and pushed the full
  // session list to every dashboard, which re-rendered the sidebar and every
  // sessions-derived memo and starved the main thread (the "everything janks
  // while a tool runs" report). Session summaries barely change within a turn
  // (only lastEventAt / status), so we push a leading-edge update immediately
  // and then coalesce the rest to at most one per SESSIONS_BROADCAST_MIN_MS,
  // with a trailing flush so the final state is never missed.
  const SESSIONS_BROADCAST_MIN_MS = 600
  let sessionsBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  let sessionsBroadcastLastMs = 0
  let sessionsBroadcastPending = false
  const flushSessionsBroadcast = (): void => {
    sessionsBroadcastLastMs = Date.now()
    sessionsBroadcastPending = false
    void store.listSummaries()
      .then((sessions) => io.of('/dashboard').emit('server:sessions', { sessions }))
      .catch(() => {})
  }
  const scheduleSessionsBroadcast = (): void => {
    const now = Date.now()
    const elapsed = now - sessionsBroadcastLastMs
    if (elapsed >= SESSIONS_BROADCAST_MIN_MS && sessionsBroadcastTimer === null) {
      // Leading edge: fire immediately when we haven't broadcast recently.
      flushSessionsBroadcast()
      return
    }
    // Within the throttle window: coalesce into a single trailing broadcast.
    sessionsBroadcastPending = true
    if (sessionsBroadcastTimer === null) {
      const delay = Math.max(0, SESSIONS_BROADCAST_MIN_MS - elapsed)
      sessionsBroadcastTimer = setTimeout(() => {
        sessionsBroadcastTimer = null
        if (sessionsBroadcastPending) flushSessionsBroadcast()
      }, delay)
    }
  }

  const broadcast: LoopBroadcast = {
    onEvent(sessionId, seq, event, effects, state, llmTrace, model, extras) {
      if (event.kind === 'llm_response') {
        metrics.increment('agent_kernel_llm_calls_total', 'LLM calls', { provider: llmTrace?.provider ?? 'unknown', outcome: 'ok' })
        if (event.usage) {
          metrics.increment('agent_kernel_llm_input_tokens_total', 'LLM input tokens', { provider: llmTrace?.provider ?? 'unknown' }, event.usage.inputTokens)
          metrics.increment('agent_kernel_llm_output_tokens_total', 'LLM output tokens', { provider: llmTrace?.provider ?? 'unknown' }, event.usage.outputTokens)
        }
      } else if (event.kind === 'llm_error') {
        metrics.increment('agent_kernel_llm_calls_total', 'LLM calls', { provider: llmTrace?.provider ?? 'unknown', outcome: 'error' })
      }
      // Terminal events must never overtake buffered text on the socket. The
      // Dashboard uses them to clear its live tail and install persisted state.
      if (event.kind === 'llm_response' || event.kind === 'llm_error' || event.kind === 'cancel') {
        flushTokenDelta(sessionId)
      }
      const room = sessionRoom(sessionId)
      const slimEffects = effects.map(slimEffect)
      const hasEffectsArtifact = effects.some((effect) => effect.kind === 'call_llm')
      scheduleSessionsBroadcast()
      io.of('/dashboard').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects: slimEffects,
        ...(hasEffectsArtifact ? { hasEffectsArtifact: true } : {}),
        ...(llmTrace ? { hasLlmTraceArtifact: true } : {}),
        ...(model ? { model } : {}),
        ...(extras?.compactionMetadata ? { compactionMetadata: extras.compactionMetadata } : {}),
      })
      io.of('/dashboard').to(room).emit('state:changed', {
        sessionId,
        cursor: state.cursor,
        state,
        contextSnapshot: snapshotFromConfig(
          store.get(sessionId)?.config ?? getDefaultConfig(),
          state.messages,
          contextWindowForModel(effectiveModelForSession(sessionId)),
          effectiveModelForSession(sessionId),
        ),
      })
      io.of('/executor').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects: slimEffects,
        ...(hasEffectsArtifact ? { hasEffectsArtifact: true } : {}),
        ...(llmTrace ? { hasLlmTraceArtifact: true } : {}),
        ...(model ? { model } : {}),
        ...(extras?.compactionMetadata ? { compactionMetadata: extras.compactionMetadata } : {}),
      })
      io.of('/executor').to(room).emit('state:changed', {
        sessionId,
        cursor: state.cursor,
        state,
      })
      if (!closed && isRestingStatus(state.status) && messageQueues.pending(sessionId) > 0) {
        setTimeout(() => {
          void messageQueues.drain(sessionId)
        }, 0)
      }
      // Web Push: fire once when a session transitions from running to done —
      // but only if the queue is empty. During an autonomous turn the status
      // briefly hits `done` between steps, and a queued message re-drives the
      // session immediately after. Firing on that transient `done` produced a
      // false "the turn finished, step in" push while work was still ongoing.
      // Requiring an empty queue makes this fire only on a real turn end.
      const prev = lastSessionStatus.get(sessionId)
      lastSessionStatus.set(sessionId, state.status)
      const isSubAgentSession = store.get(sessionId)?.parentSessionId !== undefined
      if (!isSubAgentSession && prev && prev !== 'done' && state.status === 'done' && messageQueues.pending(sessionId) === 0) {
        void pushDispatcher.send({
          kind: 'waiting_for_user',
          sessionId,
          title: 'Session ready for you',
          body: 'The active turn finished. Open the dashboard to continue.',
          url: `/#/sessions/${sessionId}`,
          tag: `waiting_for_user:${sessionId}`,
        })
      }
    },
    onApprovalRequired(sessionId, eff: RequestApprovalEffect) {
      io.of('/dashboard').to(sessionRoom(sessionId)).emit('approval:required', {
        sessionId,
        callId: eff.callId,
        name: eff.name,
        input: eff.input,
      })
      if (store.get(sessionId)?.parentSessionId === undefined) {
        void pushDispatcher.send({
          kind: 'approval_required',
          sessionId,
          title: 'Approval required',
          body: `${eff.name} is waiting for your approval.`,
          url: `/#/sessions/${sessionId}`,
          tag: `approval:${sessionId}:${eff.callId}`,
        })
      }
    },
    onError(sessionId, message) {
      flushTokenDelta(sessionId)
      const payload: SessionErrorEvent = {
        sessionId,
        scope: 'llm',
        message,
      }
      io.of('/dashboard').to(sessionRoom(sessionId)).emit('session:error', payload)
      io.of('/executor').to(sessionRoom(sessionId)).emit('session:error', payload)
      if (store.get(sessionId)?.parentSessionId === undefined) {
        void pushDispatcher.send({
          kind: 'session_error',
          sessionId,
          title: 'Session error',
          // Cap the body — the raw error text can be an unbounded stack trace.
          body: message.length > 240 ? `${message.slice(0, 237)}…` : message,
          url: `/#/sessions/${sessionId}`,
          tag: `error:${sessionId}`,
        })
      }
    },
    onTokenDelta(sessionId, text) {
      if (text.length === 0) return
      const pending = tokenDeltaBatches.get(sessionId)
      if (pending) {
        pending.text += text
        return
      }
      const timer = setTimeout(() => flushTokenDelta(sessionId), TOKEN_DELTA_BATCH_MS)
      tokenDeltaBatches.set(sessionId, { text, timer })
    },
    onSubAgentStarted(payload) {
      const room = sessionRoom(payload.parentSessionId)
      io.of('/dashboard').to(room).emit('server:control_update', {
        kind: 'sub_agent_started',
        ...payload,
      })
    },
    onSubAgentFinished(payload) {
      const room = sessionRoom(payload.parentSessionId)
      io.of('/dashboard').to(room).emit('server:control_update', {
        kind: 'sub_agent_finished',
        ...payload,
      })
    },
    onCompactStatus(payload) {
      io.of('/dashboard').to(sessionRoom(payload.sessionId)).emit('server:compact_status', payload)
    },
  }

  const skills = options.skills ?? createSkillManager(store, getDefaultConfig())

  const loopDeps = {
    store,
    llm: options.llm,
    tools: executors,
    broadcast,
    models: {
      get: effectiveModelForSession,
      contextWindow: (sessionId: string) => contextWindowForModel(effectiveModelForSession(sessionId))?.contextWindow,
    },
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(options.hookRunner !== undefined ? { hookRunner: options.hookRunner } : {}),
    skills,
    ...(options.webSearchCredentials ? { webSearchCredentials: options.webSearchCredentials } : {}),
    ...(options.artifactRootDir ? { artifactRootDir: options.artifactRootDir } : {}),
  }
  loop = runHostLoop(loopDeps)
  restart = new RestartCoordinator({
    store,
    loop,
    statePath: defaultRestartStatePath(options.sessionsDir),
    emit: (event) => {
      dashboardNs.emit('server:control_update', {
        kind: 'host_restart',
        ...event,
      })
    },
    closeServer,
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
    loopDeps,
    executors,
    defaultConfig: getDefaultConfig,
    ...(auth ? { auth } : {}),
    audit,
    allowAllApprovalMode: options.allowAllApprovalMode ?? true,
    broadcastError,
    contextWindowForModel,
    effectiveDefaultModel,
    effectiveModelForSession: (record) => effectiveModelForSession(record.sessionId),
    normalizeModelRef,
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
    defaultConfig: getDefaultConfig,
    ...(auth ? { auth } : {}),
    installations: executorInstallations,
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
    dashboardNs.to(sessionRoom(sessionId)).emit('session:error', payload)
    // Executor no longer subscribes to session:error — it's UI-only.
  }

  // Planned continuation must finish before mutable traffic can race Session
  // hydration or Queue drain. Crash recovery has already happened while loading
  // records; this path consumes only a validated restart marker.
  await restart.resumeMarkedSessions()

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
    http.listen(options.port, options.listenHost, onListening)
  })
  const addr = http.address()
  const port =
    typeof addr === 'object' && addr && 'port' in addr ? addr.port : options.port

  return {
    io,
    http,
    loop,
    store,
    executorsSnapshot: () => executors.snapshot().map((executor) => workspaceAliases.apply(executor)),
    port,
    close: closeServer,
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

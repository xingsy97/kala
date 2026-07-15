#!/usr/bin/env node
/**
 * `agent-kernel-host` CLI.
 *
 * The runtime config is read from two operator-owned files:
 *
 *   `~/.claude/settings.json` — Anthropic base URL, model names, API key
 *     (either verbatim in `env` or produced by an `apiKeyHelper` shell hook).
 *   `~/.codex/config.toml`    — default model + one block per
 *     OpenAI-compatible provider (each with `base_url`, `env_key`).
 *
 * Falls back to the classic `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars
 * if neither file is present. The CLI never persists secrets — API keys stay
 * in-memory on the adapter objects; only sanitized `ModelInfo` is served over
 * HTTP (`GET /models`).
 *
 * Other env vars:
 *   HOST_PORT          — default 3000
 *   SESSIONS_DIR       — default ~/.agent-kernel/sessions
 *   HOST_AUTH_TOKEN    — optional; when set, clients must supply it in auth
 *   HOST_GITHUB_OAUTH_REQUIRED — set to 1 to require GitHub OAuth for dashboard/HTTP
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_OAUTH_CALLBACK_URL
 *   GITHUB_USERNAME_WHITELIST — optional comma-separated GitHub login allowlist
 *   HOST_AUTH_SESSION_SECRET — HMAC secret for dashboard login cookies
 *   EXECUTOR_TOKENS    — optional JSON array of {token, workspaceId?, label?}
 *   HOST_EXECUTOR_IDENTITIES — default ~/.agent-kernel/executor-identities.json
 *   HOST_AUDIT_DIR     — default ~/.agent-kernel/audit
 *   HOST_MODEL         — hard override for the default model
 *   AGENT_KERNEL_RELEASE_BASE_URL — optional executor bootstrap asset base URL
 *   AGENT_KERNEL_RELEASE_ASSETS_DIR — optional local release asset directory
 *   AGENT_KERNEL_UPDATE_REPO / AGENT_KERNEL_RELEASE_TAG — GitHub Release source
 */

import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { ManualModelInput, ModelInfo, ServerSettingsPayload } from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'

import packageJson from '../package.json' with { type: 'json' }
import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import { policyGatewayAdapter } from '../src/llm/policy-gateway.js'
import {
  createProviderHealthRegistry,
  writeFallbackArtifact,
  type ProviderHealthRegistry,
} from '../src/llm/provider-health.js'
import { routerAdapter, toFallbackArtifact, type MutableRouter } from '../src/llm/router.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
import { resolveBuiltinAgentModule } from '../src/builtin-tools.js'
import { createHookRunner } from '../src/extensions/hooks.js'
import { createRuntimeLogger } from '../src/logger.js'
import {
  knownContextWindow,
  loadHookConfigs,
  loadRuntimeConfig,
  modelInfo,
  type ProviderSpec,
  writeManualModels,
} from '../src/runtime-config.js'
import { startHostServer } from '../src/server.js'
import type { EmbeddedStaticAsset } from '../src/http/routes.js'
import { authSettings, type AuthConfig } from '../src/auth-control.js'
import { createAuditLogger } from '../src/audit-log.js'
import { ExecutorIdentityStore } from '../src/store/executor-identity.js'
import { discoverSkills } from '../src/extensions/skills.js'
import { parseSweBenchCli, runSweBenchCli } from '../src/eval/swebench-cli.js'
import { parseEnhancementCli, runEnhancementCli } from '../src/ops-cli.js'

const logger = createRuntimeLogger('agent-kernel-host')
const VERSION = packageJson.version

type BuildInfo = {
  releaseTag: string
  gitCommit: string
  builtAt: string
  artifactKind: 'source' | 'cjs' | 'native'
  dashboardMode: 'vite' | 'static' | 'embedded' | 'none'
}

function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') continue
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function hasFlag(argv: readonly string[], ...names: readonly string[]): boolean {
  return argv.some((arg) => names.includes(arg))
}

function printHelp(): void {
  process.stdout.write(`Agent RunLab Runtime

Usage:
  bundle-dashboard-with-runtime.cjs [options]
  bundle-dashboard-with-runtime.cjs eval swebench <command> [options]
  bundle-dashboard-with-runtime.cjs enhancement <area> <command> [options]

Options:
  -h, --help                 Show this help and exit.
  -v, --version              Print version and exit.
  --port <port>              HTTP/WebSocket port. Defaults to HOST_PORT or 3000.
  --print-agent-module       Print resolved agent module metadata and exit.
  --print-system-prompt      Print resolved system prompt and exit.
  --print-tool-registry      Print resolved tool registry and exit.

Common environment:
  HOST_PORT                  Port used when --port is omitted.
  SESSIONS_DIR               Session JSONL directory. Default: ~/.agent-kernel/sessions.
  AGENT_KERNEL_ARTIFACTS_DIR Artifact root. Set to 0 to disable artifact writes.
  DASHBOARD_DIR              Static dashboard directory override.
  HOST_AUTH_TOKEN            Optional shared token required by clients.
  EXECUTOR_TOKENS            Optional JSON array of executor tokens.
  HOST_MODEL                 Override the default model.
  LOG_LEVEL                  trace, debug, info, warn, error. Default: info.
  LOG_FORMAT                 pretty/human or json. Default: pretty.

Examples:
  node bundle-dashboard-with-runtime.cjs --port 3000
  HOST_PORT=3001 node bundle-dashboard-with-runtime.cjs
  LOG_FORMAT=json node bundle-dashboard-with-runtime.cjs --port 3000
  node bundle-dashboard-with-runtime.cjs eval swebench --help
  node bundle-dashboard-with-runtime.cjs enhancement --help
`)
}

function printVersion(): void {
  process.stdout.write(`Agent RunLab Runtime ${VERSION}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (hasFlag(argv, '--help', '-h')) {
    printHelp()
    return
  }
  if (hasFlag(argv, '--version', '-v')) {
    printVersion()
    return
  }

  const enhancementCommand = parseEnhancementCli(argv)
  if (await runEnhancementCli(enhancementCommand)) return

  const sweBenchCommand = parseSweBenchCli(argv)
  if (await runSweBenchCli(sweBenchCommand)) return

  // Default `AK_ALLOW_ALL_OK` to "1" so the dashboard can flip a session into
  // `allow_all` approval mode without extra env plumbing. Operators who want
  // the original guard rail back can set `AK_ALLOW_ALL_OK=0` explicitly.
  if (process.env.AK_ALLOW_ALL_OK === undefined) {
    process.env.AK_ALLOW_ALL_OK = '1'
  }
  const runtime = loadRuntimeConfig()
  const port = Number(argValue(process.argv.slice(2), '--port') ?? process.env.HOST_PORT ?? 3000)
  const sessionsDir =
    process.env.SESSIONS_DIR ?? join(homedir(), '.agent-kernel', 'sessions')
  const artifactRootDir = process.env.AGENT_KERNEL_ARTIFACTS_DIR === '0'
    ? false
    : process.env.AGENT_KERNEL_ARTIFACTS_DIR ?? join(dirname(sessionsDir), 'artifacts')
  const auth = loadAuthConfig()
  const auditDir = process.env.HOST_AUDIT_DIR ?? join(dirname(sessionsDir), 'audit')
  const audit = createAuditLogger(auditDir)
  const executorIdentityPath = process.env.HOST_EXECUTOR_IDENTITIES ?? join(dirname(sessionsDir), 'executor-identities.json')
  const executorIdentityStore = new ExecutorIdentityStore(executorIdentityPath)
  executorIdentityStore.load()
  const effectiveAuth: AuthConfig = { ...(auth ?? {}), executorIdentityStore }
  const healthRegistry = createProviderHealthRegistry()
  const registry = createModelRegistry(runtime.providers, runtime.manualModels, {
    fallbackDefault: runtime.defaultModel,
    healthRegistry,
    ...(artifactRootDir ? { artifactRootDir } : {}),
    logger,
  })
  const { llm, defaultModel } = registry

  const skills = await discoverSkills()
  const resolvedAgentModule = resolveBuiltinAgentModule({
    skills: skills.skills,
    ...(knownContextWindow(defaultModel)
      ? { contextLimit: knownContextWindow(defaultModel) }
      : {}),
  })
  if (hasFlag(argv, '--print-agent-module')) {
    process.stdout.write(`${JSON.stringify(resolvedAgentModule.metadata, null, 2)}\n`)
    return
  }
  if (hasFlag(argv, '--print-system-prompt')) {
    process.stdout.write(`${resolvedAgentModule.systemPrompt}\n`)
    return
  }
  if (hasFlag(argv, '--print-tool-registry')) {
    process.stdout.write(`${JSON.stringify(resolvedAgentModule.toolDefinitions, null, 2)}\n`)
    return
  }

  const dashboard = await createDashboardServing()
  const buildInfo = runtimeBuildInfo(dashboard)
  const hooks = loadHookConfigs()
  const hookRunner = hooks.length > 0 ? createHookRunner() : undefined
  let release = releaseSettings(port)

  const manualModelsPath = join(homedir(), '.config', 'agent-kernel', 'models.json')
  const hookSummaries = hooks.map((h) => ({
      event: h.event,
      command: h.command,
      ...(h.match !== undefined ? { match: h.match } : {}),
  }))
  const makeSettings = (): ServerSettingsPayload => ({
    providers: registry.providers.map((p) => ({
      id: p.id,
      label: p.label,
      wire: p.wire,
      source: p.source,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      models: registry.models.filter((m) => m.providerId === p.id),
    })),
    defaultModel,
    hooks: hookSummaries,
    versions: {
      host: VERSION,
      protocol: PROTOCOL_VERSION,
      build: buildInfo,
    },
    agentModule: resolvedAgentModule.metadata,
    auth: authSettings(effectiveAuth),
    paths: {
      claudeSettings: join(homedir(), '.claude', 'settings.json'),
      codexConfig: join(homedir(), '.codex', 'config.toml'),
      manualModels: manualModelsPath,
      hooksConfig: join(homedir(), '.config', 'agent-kernel', 'config.toml'),
      sessionsDir,
    },
    mcp: {
      supported: false,
      note: 'MCP runtime is not implemented yet — see docs/host/mcp.md for the planned design.',
    },
    release,
  })

  const server = await startHostServer({
    port,
    sessionsDir,
    llm,
    defaultConfig: resolvedAgentModule.config,
    models: () => registry.models,
    defaultModel,
    settings: makeSettings,
    addManualModel: (input) => {
      registry.addManual(input)
      writeManualModels(manualModelsPath, registry.manualModels)
      return makeSettings()
    },
    deleteManualModel: (input) => {
      registry.deleteManual(input.providerId, input.id)
      writeManualModels(manualModelsPath, registry.manualModels)
      return makeSettings()
    },
    auth: effectiveAuth,
    audit,
    ...(dashboard.kind === 'vite' ? { dashboardHandler: dashboard.handler } : {}),
    ...(dashboard.kind === 'static' ? { staticDir: dashboard.staticDir } : {}),
    ...(dashboard.kind === 'embedded' ? { embeddedStaticAssets: dashboard.assets } : {}),
    ...(release.source === 'local' ? { releaseAssetsDir: releaseDir() } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
    ...(hookRunner ? { hookRunner } : {}),
    skills,
    artifactRootDir,
    routerHealth: () => ({
      generatedAt: new Date().toISOString(),
      providers: healthRegistry.entries(),
      lastDecision: 'lastDecision' in llm ? (llm as MutableRouter).lastDecision() : undefined,
    }),
  })
  release = releaseSettings(server.port)

  const startupDetails = {
    port: server.port,
    sessionsDir,
    llm: llm.name,
    models: registry.models.map((m) => m.id),
    defaultModel,
    dashboard: dashboard.kind,
    ...(dashboard.kind === 'static' ? { staticDir: dashboard.staticDir } : {}),
    ...(dashboard.kind === 'embedded' ? { embeddedAssets: dashboard.assets.length } : {}),
    hooks: hooks.length,
    skills: skills.skills.length,
    artifactRootDir,
    auditDir,
    executorIdentityPath,
  }
  logger.info(`host listening on http://127.0.0.1:${server.port} (${dashboard.kind} dashboard, ${registry.models.length} models)`)
  logger.debug(startupDetails, 'host startup details')
  if (registry.models.length === 0) {
    logger.warn(
      'no models configured; check ~/.claude/settings.json and ~/.codex/config.toml',
    )
  }

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down')
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

type BuildResult = {
  llm: MutableRouter | LLMAdapter
  providers: readonly ProviderSpec[]
  models: readonly ModelInfo[]
  manualModels: readonly ManualModelInput[]
  defaultModel: string
  addManual(input: ManualModelInput): void
  deleteManual(providerId: string, id: string): void
}

function createModelRegistry(
  providers: readonly ProviderSpec[],
  initialManualModels: readonly ManualModelInput[],
  opts: {
    fallbackDefault: string
    healthRegistry?: ProviderHealthRegistry
    artifactRootDir?: string
    logger?: ReturnType<typeof createRuntimeLogger>
  },
): BuildResult {
  const byPrefix: Array<{ prefix: string; adapter: LLMAdapter }> = []
  const models: ModelInfo[] = []
  const manualModels: ManualModelInput[] = [...initialManualModels]
  let primary: LLMAdapter | undefined

  for (const p of providers) {
    const perModelAdapters = buildProviderAdapters(p)
    for (const [modelId, adapter] of perModelAdapters) {
      models.push(modelInfo(modelId, p.label, {
        providerId: p.id,
        source: manualModels.some((m) => m.providerId === p.id && m.id === modelId) ? 'manual' : p.source,
      }))
      byPrefix.push({ prefix: modelId, adapter })
      if (!primary) primary = adapter
    }
  }

  if (!primary) {
    primary = legacyEnvAdapter(models)
  }

  const routerArtifactDir = opts.artifactRootDir
  const decisionLogger = opts.logger
  const router = routerAdapter({
    defaultAdapter: primary,
    byPrefix,
    ...(opts.healthRegistry ? { healthRegistry: opts.healthRegistry } : {}),
    ...(routerArtifactDir
      ? {
          onDecision: (decision) => {
            if (decision.finalOutcome === 'success' && decision.attempts.length <= 1) return
            void writeFallbackArtifact({
              rootDir: routerArtifactDir,
              artifact: toFallbackArtifact(decision),
            }).catch((err) => {
              decisionLogger?.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'router: failed to persist fallback artifact',
              )
            })
          },
        }
      : {}),
  })
  const defaultModel = process.env.HOST_MODEL ?? opts.fallbackDefault
  return {
    llm: router,
    providers,
    models,
    manualModels,
    defaultModel,
    addManual(input) {
      const provider = providers.find((p) => p.id === input.providerId)
      if (!provider) throw new Error(`unknown provider: ${input.providerId}`)
      const id = input.id.trim()
      if (id.length === 0) throw new Error('model id is required')
      const existingModel = models.find((m) => m.providerId === provider.id && m.id === id)
      if (existingModel && existingModel.source !== 'manual') {
        throw new Error(`model already discovered from ${existingModel.source ?? 'provider config'}: ${id}`)
      }
      if (!existingModel) {
        const adapter = buildSingleAdapter(provider, id)
        router.addRoute(id, adapter)
        models.push(modelInfo(id, provider.label, {
          providerId: provider.id,
          source: 'manual',
          ...(input.label ? { label: input.label } : {}),
          ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
        }))
      }
      const existing = manualModels.findIndex((m) => m.providerId === provider.id && m.id === id)
      const normalized = {
        providerId: provider.id,
        id,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
      }
      if (existing === -1) manualModels.push(normalized)
      else manualModels[existing] = normalized
    },
    deleteManual(providerId, id) {
      const manualIndex = manualModels.findIndex((m) => m.providerId === providerId && m.id === id)
      if (manualIndex === -1) return
      manualModels.splice(manualIndex, 1)
      const modelIndex = models.findIndex((m) => m.providerId === providerId && m.id === id && m.source === 'manual')
      if (modelIndex !== -1) models.splice(modelIndex, 1)
      router.deleteRoute(id)
    },
  }
}

function buildProviderAdapters(
  provider: ProviderSpec,
): Array<[string, LLMAdapter]> {
  const out: Array<[string, LLMAdapter]> = []
  for (const model of provider.models) {
    out.push([model, buildSingleAdapter(provider, model)])
  }
  return out
}

function buildSingleAdapter(provider: ProviderSpec, model: string): LLMAdapter {
  if (provider.wire === 'anthropic') {
    return anthropicAdapter({
      apiKey: provider.apiKey,
      model,
      ...(provider.baseUrl
        ? { apiUrl: joinPath(provider.baseUrl, '/messages') }
        : {}),
    })
  }
  return openaiAdapter({
    apiKey: provider.apiKey,
    model,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  })
}

function loadAuthConfig(): AuthConfig | undefined {
  const githubRequired = process.env.HOST_GITHUB_OAUTH_REQUIRED === '1'
  const executorTokens = parseExecutorTokens(process.env.EXECUTOR_TOKENS)
  const sharedToken = process.env.HOST_AUTH_TOKEN
  const github = githubRequired
    ? {
        required: true,
        ...(process.env.GITHUB_CLIENT_ID ? { clientId: process.env.GITHUB_CLIENT_ID } : {}),
        ...(process.env.GITHUB_CLIENT_SECRET ? { clientSecret: process.env.GITHUB_CLIENT_SECRET } : {}),
        ...(process.env.GITHUB_OAUTH_CALLBACK_URL ? { callbackUrl: process.env.GITHUB_OAUTH_CALLBACK_URL } : {}),
        ...(process.env.HOST_AUTH_SESSION_SECRET ? { sessionSecret: process.env.HOST_AUTH_SESSION_SECRET } : {}),
        usernameWhitelist: (process.env.GITHUB_USERNAME_WHITELIST ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      }
    : undefined
  if (!sharedToken && !github && executorTokens.length === 0) return undefined
  return {
    ...(sharedToken ? { sharedToken } : {}),
    ...(github ? { github } : {}),
    ...(executorTokens.length > 0 ? { executorTokens } : {}),
  }
}

function parseExecutorTokens(raw: string | undefined): NonNullable<AuthConfig['executorTokens']> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error('EXECUTOR_TOKENS must be a JSON array')
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const rec = item as Record<string, unknown>
      if (typeof rec.token !== 'string' || rec.token.length === 0) return []
      return [{
        token: rec.token,
        ...(typeof rec.workspaceId === 'string' && rec.workspaceId.length > 0 ? { workspaceId: rec.workspaceId } : {}),
        ...(typeof rec.label === 'string' && rec.label.length > 0 ? { label: rec.label } : {}),
      }]
    })
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'invalid EXECUTOR_TOKENS; ignoring scoped executor tokens')
    return []
  }
}

/**
 * Path join for base URLs that may or may not already end in `/v1`. Anthropic
 * bases in the wild are inconsistent: some proxies expose `.../v1` (like the
 * newapi proxy at 127.0.0.1:33333), others expose the whole `.../v1/messages`
 * path. We normalize: strip trailing slash and any trailing `/messages`, then
 * append `/v1/messages` if the base isn't already versioned.
 */
function joinPath(base: string, tail: string): string {
  const trimmed = base.replace(/\/+$/, '').replace(/\/messages$/, '')
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${versioned}${tail.startsWith('/') ? tail : `/${tail}`}`
}

/**
 * Backwards-compatibility path: if neither `~/.claude/settings.json` nor
 * `~/.codex/config.toml` produced a working provider, fall back to the classic
 * `LLM_PROVIDER=anthropic|openai` env vars so existing container deployments
 * keep working. `AGENT_KERNEL_PROVIDER=policy-gateway` is the training-mode
 * path for SGLang-backed live rollouts.
 */
function legacyEnvAdapter(models: ModelInfo[]): LLMAdapter {
  const provider = (process.env.AGENT_KERNEL_PROVIDER ?? process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase()
  if (provider === 'policy-gateway') {
    const baseUrl = process.env.AGENT_KERNEL_POLICY_BASE_URL
    const model = process.env.AGENT_KERNEL_POLICY_MODEL ?? process.env.HOST_MODEL
    if (!baseUrl || !model) {
      fail('AGENT_KERNEL_PROVIDER=policy-gateway requires AGENT_KERNEL_POLICY_BASE_URL and AGENT_KERNEL_POLICY_MODEL')
    }
    models.push(modelInfo(model, 'policy-gateway (SGLang)', { providerId: 'policy-gateway', source: 'env' }))
    return policyGatewayAdapter({
      baseUrl,
      artifactRoot: process.env.AGENT_KERNEL_ARTIFACTS_DIR ?? join(homedir(), '.agent-kernel', 'artifacts'),
      model,
      ...(process.env.AGENT_KERNEL_POLICY_TOKENIZER ? { tokenizerPath: process.env.AGENT_KERNEL_POLICY_TOKENIZER } : {}),
      ...(process.env.AGENT_KERNEL_POLICY_ROUTE_KEY ? { routeKey: process.env.AGENT_KERNEL_POLICY_ROUTE_KEY } : {}),
      ...(process.env.AGENT_KERNEL_POLICY_WEIGHT_VERSION ? { weightVersion: process.env.AGENT_KERNEL_POLICY_WEIGHT_VERSION } : {}),
      requireLogprobs: process.env.AGENT_KERNEL_POLICY_REQUIRE_LOGPROBS === '1',
    })
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (provider === 'openai' && openaiKey) {
    const model = process.env.HOST_MODEL ?? 'gpt-4'
    models.push(modelInfo(model, 'openai (env)', { providerId: 'openai-env', source: 'env' }))
    return openaiAdapter({
      apiKey: openaiKey,
      model,
      ...(process.env.OPENAI_BASE_URL
        ? { baseUrl: process.env.OPENAI_BASE_URL }
        : {}),
    })
  }
  if (anthropicKey) {
    const model = process.env.HOST_MODEL ?? 'claude-opus-4-7'
    models.push(modelInfo(model, 'anthropic (env)', { providerId: 'anthropic-env', source: 'env' }))
    return anthropicAdapter({
      apiKey: anthropicKey,
      model,
      ...(process.env.ANTHROPIC_BASE_URL
        ? { apiUrl: joinPath(process.env.ANTHROPIC_BASE_URL, '/messages') }
        : {}),
    })
  }
  fail(
    'No LLM provider available: set ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
      'or configure ~/.claude/settings.json / ~/.codex/config.toml',
  )
}

function fail(msg: string): never {
  logger.error(msg)
  process.exit(1)
}

type DashboardServing =
  | { kind: 'vite'; handler: (req: IncomingMessage, res: ServerResponse) => void }
  | { kind: 'static'; staticDir: string }
  | { kind: 'embedded'; assets: readonly EmbeddedStaticAsset[] }
  | { kind: 'none' }

async function createDashboardServing(): Promise<DashboardServing> {
  const override = process.env.DASHBOARD_DIR
  if (override) {
    return existsSync(join(override, 'index.html'))
      ? { kind: 'static', staticDir: override }
      : { kind: 'none' }
  }

  if (isSourceDevRun()) {
    const handler = await createViteDashboardHandler().catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to start vite dashboard middleware; falling back to built dashboard',
      )
      return null
    })
    if (handler) return { kind: 'vite', handler }
  }

  const embedded = embeddedDashboardAssets()
  if (embedded.length > 0) return { kind: 'embedded', assets: embedded }

  const staticDir = resolveDashboardDir()
  return staticDir ? { kind: 'static', staticDir } : { kind: 'none' }
}

function embeddedDashboardAssets(): readonly EmbeddedStaticAsset[] {
  const globalValue = (globalThis as typeof globalThis & {
    __AGENT_KERNEL_EMBEDDED_DASHBOARD__?: unknown
  }).__AGENT_KERNEL_EMBEDDED_DASHBOARD__
  if (!Array.isArray(globalValue)) return []
  const assets: EmbeddedStaticAsset[] = []
  for (const item of globalValue) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.path !== 'string') continue
    if (typeof record.contentBase64 !== 'string') continue
    assets.push({ path: record.path, contentBase64: record.contentBase64 })
  }
  return assets
}

function runtimeBuildInfo(dashboard: DashboardServing): BuildInfo & { embeddedDashboardFiles?: number } {
  const globalValue = (globalThis as typeof globalThis & {
    __AGENT_KERNEL_BUILD_INFO__?: unknown
  }).__AGENT_KERNEL_BUILD_INFO__
  const base = parseBuildInfo(globalValue) ?? {
    releaseTag: process.env.AGENT_KERNEL_RELEASE_TAG ?? 'local',
    gitCommit: process.env.AGENT_KERNEL_GIT_COMMIT ?? 'unknown',
    builtAt: process.env.AGENT_KERNEL_BUILT_AT ?? 'unknown',
    artifactKind: 'source' as const,
    dashboardMode: dashboard.kind,
  }
  return {
    ...base,
    dashboardMode: dashboard.kind,
    ...(dashboard.kind === 'embedded' ? { embeddedDashboardFiles: dashboard.assets.length } : {}),
  }
}

function parseBuildInfo(value: unknown): BuildInfo | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const artifactKind = record.artifactKind
  const dashboardMode = record.dashboardMode
  if (artifactKind !== 'source' && artifactKind !== 'cjs' && artifactKind !== 'native') return null
  if (dashboardMode !== 'vite' && dashboardMode !== 'static' && dashboardMode !== 'embedded' && dashboardMode !== 'none') return null
  return {
    releaseTag: typeof record.releaseTag === 'string' ? record.releaseTag : 'unknown',
    gitCommit: typeof record.gitCommit === 'string' ? record.gitCommit : 'unknown',
    builtAt: typeof record.builtAt === 'string' ? record.builtAt : 'unknown',
    artifactKind,
    dashboardMode,
  }
}

async function createViteDashboardHandler(): Promise<
  (req: IncomingMessage, res: ServerResponse) => void
> {
  type ViteDevServer = {
    middlewares(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void
  }
  type ViteModule = {
    createServer(options: unknown): Promise<ViteDevServer>
  }
  const runtimeImport = Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<unknown>
  const vite = (await runtimeImport('vite')) as ViteModule
  const dashboardRoot = resolve(dirname(currentModulePath()), '..', '..', 'dashboard')
  const viteServer = await vite.createServer({
    root: dashboardRoot,
    server: {
      middlewareMode: true,
      hmr: { server: false },
    },
    appType: 'spa',
  })
  return (req, res) => {
    viteServer.middlewares(req, res, (err?: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      }
    })
  }
}

function isSourceDevRun(): boolean {
  if (process.env.AGENT_KERNEL_DASHBOARD_DEV === '0') return false
  if (process.env.AGENT_KERNEL_DASHBOARD_DEV === '1') return true
  return currentModulePath().endsWith('.ts')
}

function resolveDashboardDir(): string | undefined {
  const here = dirname(currentModulePath())
  const candidates = [
    // Monorepo layout: packages/host/bin/ → packages/dashboard/dist/
    resolve(here, '..', '..', 'dashboard', 'dist'),
    // Installed layout: node_modules/@agent-kernel/dashboard/dist
    resolve(here, '..', '..', '..', 'dashboard', 'dist'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c
  }
  return undefined
}

function currentModulePath(): string {
  return resolve(process.argv[1] ?? process.cwd())
}

function releaseSettings(port: number): NonNullable<ServerSettingsPayload['release']> {
  const explicit = process.env.AGENT_KERNEL_RELEASE_BASE_URL?.trim()
  if (explicit) {
    return { bootstrapBaseUrl: trimTrailingSlash(explicit), source: explicit.includes('github.com/') ? 'github' : 'local' }
  }
  const repo = process.env.AGENT_KERNEL_UPDATE_REPO?.trim()
  const tag = process.env.AGENT_KERNEL_RELEASE_TAG?.trim()
  if (repo) {
    const suffix = tag && tag !== 'latest' ? `releases/download/${tag}` : 'releases/latest/download'
    return { bootstrapBaseUrl: `https://github.com/${repo}/${suffix}`, source: 'github' }
  }
  return { bootstrapBaseUrl: `http://localhost:${port}/release-assets`, source: 'local' }
}

function releaseDir(): string {
  const explicit = process.env.AGENT_KERNEL_RELEASE_ASSETS_DIR?.trim()
  if (explicit) return resolve(explicit)
  const found = findReleaseDir([process.cwd(), dirname(currentModulePath())])
  return found ?? resolve(process.cwd(), 'release')
}

function findReleaseDir(starts: readonly string[]): string | undefined {
  for (const start of starts) {
    let dir = resolve(start)
    for (;;) {
      const candidate = join(dir, 'release')
      if (existsSync(join(candidate, 'run.sh'))) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

main().catch((err) => {
  logger.error({ err }, 'fatal error')
  if (err instanceof Error) {
    console.error(err.message)
  }
  process.exit(1)
})

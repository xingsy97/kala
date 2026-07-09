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
 *   HOST_MODEL         — hard override for the default model
 */

import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { ManualModelInput, ModelInfo, ServerSettingsPayload } from '@agent-kernel/shared'

import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import {
  createProviderHealthRegistry,
  writeFallbackArtifact,
  type ProviderHealthRegistry,
} from '../src/llm/provider-health.js'
import { routerAdapter, toFallbackArtifact, type MutableRouter } from '../src/llm/router.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
import { createBuiltinTools } from '../src/builtin-tools.js'
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
import { discoverSkills } from '../src/extensions/skills.js'
import { parseSweBenchCli, runSweBenchCli } from '../src/eval/swebench-cli.js'
import { parseEnhancementCli, runEnhancementCli } from '../src/ops-cli.js'

const logger = createRuntimeLogger('agent-kernel-host')

function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') continue
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
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
  const healthRegistry = createProviderHealthRegistry()
  const registry = createModelRegistry(runtime.providers, runtime.manualModels, {
    fallbackDefault: runtime.defaultModel,
    healthRegistry,
    ...(artifactRootDir ? { artifactRootDir } : {}),
    logger,
  })
  const { llm, defaultModel } = registry

  const dashboard = await createDashboardServing()
  const hooks = loadHookConfigs()
  const hookRunner = hooks.length > 0 ? createHookRunner() : undefined
  const skills = await discoverSkills()

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
  })

  const server = await startHostServer({
    port,
    sessionsDir,
    llm,
    defaultConfig: {
      tools: [...createBuiltinTools(skills.skills)],
      systemPrompt: 'You are a coding agent running via agent-kernel.',
      ...(knownContextWindow(defaultModel)
        ? { contextLimit: knownContextWindow(defaultModel) }
        : {}),
    },
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
    ...(process.env.HOST_AUTH_TOKEN
      ? { authToken: process.env.HOST_AUTH_TOKEN }
      : {}),
    ...(dashboard.kind === 'vite' ? { dashboardHandler: dashboard.handler } : {}),
    ...(dashboard.kind === 'static' ? { staticDir: dashboard.staticDir } : {}),
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

  logger.info(
    {
      port: server.port,
      sessionsDir,
      llm: llm.name,
      models: registry.models.map((m) => m.id),
      defaultModel,
      dashboard: dashboard.kind,
      ...(dashboard.kind === 'static' ? { staticDir: dashboard.staticDir } : {}),
      hooks: hooks.length,
      skills: skills.skills.length,
      artifactRootDir,
    },
    'host listening',
  )
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
 * keep working.
 */
function legacyEnvAdapter(models: ModelInfo[]): LLMAdapter {
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase()
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

  const staticDir = resolveDashboardDir()
  return staticDir ? { kind: 'static', staticDir } : { kind: 'none' }
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

main().catch((err) => {
  logger.error({ err }, 'fatal error')
  process.exit(1)
})

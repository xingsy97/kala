#!/usr/bin/env node
/**
 * `agent-kernel-host` CLI.
 *
 * The runtime config is read from two operator-owned files:
 *
 *   `~/.claude/settings.json`  -  Anthropic base URL, model names, API key
 *     (either verbatim in `env` or produced by an `apiKeyHelper` shell hook).
 *   `~/.codex/config.toml`     -  default model + one block per
 *     OpenAI-compatible provider (each with `base_url`, `env_key`).
 *
 * Falls back to the classic `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars
 * if neither file is present. The CLI never persists secrets  -  API keys stay
 * in-memory on the adapter objects; only sanitized `ModelInfo` is served over
 * HTTP (`GET /models`).
 *
 * Other env vars:
 *   HOST_PORT           -  default 3000
 *   SESSIONS_DIR        -  default ~/.agent-kernel/sessions
 *   HOST_AUTH_TOKEN     -  optional; when set, clients must supply it in auth
 *   HOST_MODEL          -  hard override for the default model
 */

import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { ManualModelInput, ModelInfo, ServerSettingsPayload } from '@agent-kernel/shared'

import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import { routerAdapter, type MutableRouter } from '../src/llm/router.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
import { createBuiltinTools } from '../src/builtin-tools.js'
import { createHookRunner } from '../src/hooks.js'
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
import { discoverSkills } from '../src/skills.js'

const logger = createRuntimeLogger('agent-kernel-host')

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig()
  const registry = createModelRegistry(runtime.providers, runtime.manualModels, {
    fallbackDefault: runtime.defaultModel,
  })
  const { llm, defaultModel } = registry

  const port = Number(process.env.HOST_PORT ?? 3000)
  const sessionsDir =
    process.env.SESSIONS_DIR ?? join(homedir(), '.agent-kernel', 'sessions')
  const staticDir = resolveDashboardDir()
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
      note: 'MCP runtime is not implemented yet  -  see docs/mcp.md for the planned design.',
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
    ...(staticDir ? { staticDir } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
    ...(hookRunner ? { hookRunner } : {}),
    skills,
  })

  logger.info(
    {
      port: server.port,
      sessionsDir,
      llm: llm.name,
      models: registry.models.map((m) => m.id),
      defaultModel,
      ...(staticDir ? { staticDir } : {}),
      hooks: hooks.length,
      skills: skills.skills.length,
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
  opts: { fallbackDefault: string },
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

  const router = routerAdapter({ defaultAdapter: primary, byPrefix })
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

function resolveDashboardDir(): string | undefined {
  const override = process.env.DASHBOARD_DIR
  if (override) {
    return existsSync(join(override, 'index.html')) ? override : undefined
  }
  const here = dirname(currentModulePath())
  const candidates = [
    // Monorepo layout: packages/host/bin/  -  packages/dashboard/dist/
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

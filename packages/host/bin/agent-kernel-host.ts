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
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { ModelInfo } from '@agent-kernel/shared'

import { anthropicAdapter } from '../src/llm/anthropic.js'
import { openaiAdapter } from '../src/llm/openai.js'
import { routerAdapter } from '../src/llm/router.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
import { builtinTools } from '../src/builtin-tools.js'
import { loadRuntimeConfig, type ProviderSpec } from '../src/runtime-config.js'
import { startHostServer } from '../src/server.js'

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig()
  const { llm, models, defaultModel } = buildAdapters(runtime.providers, {
    fallbackDefault: runtime.defaultModel,
  })

  const port = Number(process.env.HOST_PORT ?? 3000)
  const sessionsDir =
    process.env.SESSIONS_DIR ?? join(homedir(), '.agent-kernel', 'sessions')
  const staticDir = resolveDashboardDir()

  const server = await startHostServer({
    port,
    sessionsDir,
    llm,
    defaultConfig: {
      tools: [...builtinTools],
      systemPrompt: 'You are a coding agent running via agent-kernel.',
    },
    models,
    defaultModel,
    ...(process.env.HOST_AUTH_TOKEN
      ? { authToken: process.env.HOST_AUTH_TOKEN }
      : {}),
    ...(staticDir ? { staticDir } : {}),
  })

  console.log(`agent-kernel-host listening on port ${server.port}`)
  console.log(`sessions dir: ${sessionsDir}`)
  console.log(`llm: ${llm.name}`)
  console.log(
    `models: ${models.length === 0 ? '(none — check ~/.claude/settings.json and ~/.codex/config.toml)' : models.map((m) => m.id).join(', ')}`,
  )
  if (defaultModel) console.log(`default model: ${defaultModel}`)
  if (staticDir) console.log(`serving dashboard from ${staticDir}`)

  const shutdown = async (): Promise<void> => {
    console.log('shutting down...')
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

type BuildResult = {
  llm: LLMAdapter
  models: readonly ModelInfo[]
  defaultModel: string
}

function buildAdapters(
  providers: readonly ProviderSpec[],
  opts: { fallbackDefault: string },
): BuildResult {
  const byPrefix: Array<{ prefix: string; adapter: LLMAdapter }> = []
  const models: ModelInfo[] = []
  let primary: LLMAdapter | undefined

  for (const p of providers) {
    const perModelAdapters = buildProviderAdapters(p)
    for (const [modelId, adapter] of perModelAdapters) {
      models.push({ id: modelId, label: modelId, provider: p.label })
      byPrefix.push({ prefix: modelId, adapter })
      if (!primary) primary = adapter
    }
  }

  if (!primary) {
    primary = legacyEnvAdapter(models)
  }

  const llm = routerAdapter({ defaultAdapter: primary, byPrefix })
  const defaultModel = process.env.HOST_MODEL ?? opts.fallbackDefault
  return { llm, models, defaultModel }
}

function buildProviderAdapters(
  provider: ProviderSpec,
): Array<[string, LLMAdapter]> {
  const out: Array<[string, LLMAdapter]> = []
  for (const model of provider.models) {
    if (provider.wire === 'anthropic') {
      out.push([
        model,
        anthropicAdapter({
          apiKey: provider.apiKey,
          model,
          ...(provider.baseUrl
            ? { apiUrl: joinPath(provider.baseUrl, '/messages') }
            : {}),
        }),
      ])
    } else {
      out.push([
        model,
        openaiAdapter({
          apiKey: provider.apiKey,
          model,
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        }),
      ])
    }
  }
  return out
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
    models.push({ id: model, label: model, provider: 'openai (env)' })
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
    models.push({ id: model, label: model, provider: 'anthropic (env)' })
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
  console.error(msg)
  process.exit(1)
}

function resolveDashboardDir(): string | undefined {
  const override = process.env.DASHBOARD_DIR
  if (override) {
    return existsSync(join(override, 'index.html')) ? override : undefined
  }
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
  console.error(err)
  process.exit(1)
})

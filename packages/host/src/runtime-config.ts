/**
 * Runtime config loader.
 *
 * Reads two local files, both belonging to the operator, and produces the
 * providers + models the host should advertise:
 *
 *   `~/.claude/settings.json` — Anthropic base URL, API key (via `apiKeyHelper`
 *     shell hook), primary + small model names.
 *   `~/.codex/config.toml`    — default model + a table of OpenAI-compatible
 *     providers (`[model_providers.<name>]` blocks each carrying `base_url`,
 *     `env_key`, `wire_api`).
 *
 * We accept partial config: either file missing is fine, we just skip that
 * side. The output is what the host CLI needs to build adapters, plus a
 * sanitized `ModelInfo[]` for the dashboard's picker. **No secrets ever
 * appear in the output** — API keys are held in-memory on the returned
 * provider objects, but the `models` list is safe to serialize over HTTP.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import type { ModelInfo } from '@agent-kernel/shared'

export type ProviderSpec = {
  id: string
  label: string
  wire: 'anthropic' | 'openai'
  baseUrl?: string
  apiKey: string
  models: readonly string[]
}

export type RuntimeConfig = {
  providers: readonly ProviderSpec[]
  models: readonly ModelInfo[]
  defaultModel: string
}

export type LoadRuntimeConfigOptions = {
  claudeSettingsPath?: string
  codexConfigPath?: string
}

export function loadRuntimeConfig(
  opts: LoadRuntimeConfigOptions = {},
): RuntimeConfig {
  const home = homedir()
  const claudePath =
    opts.claudeSettingsPath ?? join(home, '.claude', 'settings.json')
  const codexPath =
    opts.codexConfigPath ?? join(home, '.codex', 'config.toml')

  const providers: ProviderSpec[] = []
  const claude = loadClaudeSettings(claudePath)
  if (claude) providers.push(claude)
  const codex = loadCodexProviders(codexPath)
  providers.push(...codex.providers)

  const models: ModelInfo[] = providers.flatMap((p) =>
    p.models.map((m) => modelInfo(m, p.label)),
  )

  const defaultModel =
    codex.defaultModel ?? claude?.models[0] ?? models[0]?.id ?? ''

  return { providers, models, defaultModel }
}

export function modelInfo(model: string, provider: string): ModelInfo {
  const contextWindow = knownContextWindow(model)
  return {
    id: model,
    label: model,
    provider,
    ...(contextWindow ? { contextWindow } : {}),
  }
}

export function knownContextWindow(model: string): number | undefined {
  const normalized = model.toLowerCase()
  if (normalized.includes('claude-opus-4.7-1m')) return 1_000_000
  if (normalized.includes('gpt-5.5')) return 400_000
  return undefined
}

// ============================================================================
// Claude settings
// ============================================================================

type ClaudeSettings = {
  apiKeyHelper?: string
  env?: {
    ANTHROPIC_API_KEY?: string
    ANTHROPIC_AUTH_TOKEN?: string
    ANTHROPIC_BASE_URL?: string
    ANTHROPIC_MODEL?: string
    ANTHROPIC_SMALL_FAST_MODEL?: string
  }
}

function loadClaudeSettings(path: string): ProviderSpec | undefined {
  const raw = tryReadFile(path)
  if (raw === undefined) return undefined
  let parsed: ClaudeSettings
  try {
    parsed = JSON.parse(raw) as ClaudeSettings
  } catch {
    return undefined
  }
  const env = parsed.env ?? {}
  const apiKey =
    process.env.ANTHROPIC_API_KEY ??
    env.ANTHROPIC_API_KEY ??
    env.ANTHROPIC_AUTH_TOKEN ??
    (parsed.apiKeyHelper ? runApiKeyHelper(parsed.apiKeyHelper) : undefined)
  if (!apiKey) return undefined
  const primary = env.ANTHROPIC_MODEL
  const models: string[] = []
  if (primary) models.push(primary)
  if (models.length === 0) return undefined
  return {
    id: 'anthropic',
    label: 'Anthropic',
    wire: 'anthropic',
    ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
    apiKey,
    models,
  }
}

function runApiKeyHelper(cmd: string): string | undefined {
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

// ============================================================================
// Codex config.toml
// ============================================================================

type CodexParsed = {
  defaultModel?: string
  providers: readonly ProviderSpec[]
}

function loadCodexProviders(path: string): CodexParsed {
  const raw = tryReadFile(path)
  if (raw === undefined) return { providers: [] }
  const parsed = parseCodexToml(raw)
  const providers: ProviderSpec[] = []
  const defaultModel = parsed.model
  for (const p of parsed.providers) {
    const apiKey = p.envKey ? process.env[p.envKey] : undefined
    if (!apiKey) continue
    // Codex config declares providers but not per-provider model lists.
    // The user names one default model at the top; attach it to the
    // provider that owns the current default. Other providers become
    // available as endpoints even though the picker won't list them
    // until an explicit model → provider mapping is provided.
    const models: string[] = []
    if (defaultModel && p.id === parsed.defaultProviderId) {
      models.push(defaultModel)
    }
    providers.push({
      id: p.id,
      label: p.name ?? p.id,
      wire: 'openai',
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      apiKey,
      models,
    })
  }
  return {
    ...(defaultModel ? { defaultModel } : {}),
    providers,
  }
}

type CodexProviderBlock = {
  id: string
  name?: string
  baseUrl?: string
  envKey?: string
  wireApi?: string
}

type CodexTomlSubset = {
  model?: string
  defaultProviderId?: string
  providers: CodexProviderBlock[]
}

/**
 * Minimal TOML reader for the shape codex writes. Handles top-level
 * `key = "value"` and `[model_providers.<id>]` blocks with string fields.
 * Deliberately ignores everything else — the codex config file has many
 * unrelated sections we shouldn't parse or reject.
 */
export function parseCodexToml(text: string): CodexTomlSubset {
  const lines = text.split('\n')
  let currentBlock: CodexProviderBlock | undefined
  let inTopLevel = true
  const providers: CodexProviderBlock[] = []
  const top: Record<string, string> = {}

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim()
    if (line.length === 0) continue
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) {
      const path = header[1]!
      const providerMatch = path.match(/^model_providers\.(.+)$/)
      if (providerMatch) {
        currentBlock = { id: providerMatch[1]! }
        providers.push(currentBlock)
        inTopLevel = false
      } else {
        currentBlock = undefined
        inTopLevel = false
      }
      continue
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.+)$/)
    if (!kv) continue
    const key = kv[1]!
    const value = parseTomlValue(kv[2]!)
    if (value === undefined) continue
    if (inTopLevel) {
      top[key] = value
      continue
    }
    if (!currentBlock) continue
    if (key === 'name') currentBlock.name = value
    else if (key === 'base_url') currentBlock.baseUrl = value
    else if (key === 'env_key') currentBlock.envKey = value
    else if (key === 'wire_api') currentBlock.wireApi = value
  }

  const model = top.model
  const defaultProviderId = top.model_provider
  return {
    ...(model ? { model } : {}),
    ...(defaultProviderId ? { defaultProviderId } : {}),
    providers,
  }
}

function stripComment(line: string): string {
  // Comments start with `#` when not inside a string. We only need to handle
  // simple cases: string literals are `"..."` on one line, so scan and drop
  // the tail at the first `#` not inside quotes.
  let inString = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '"') inString = !inString
    else if (c === '#' && !inString) return line.slice(0, i)
  }
  return line
}

function parseTomlValue(raw: string): string | undefined {
  const s = raw.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"')
  }
  return undefined
}

function tryReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

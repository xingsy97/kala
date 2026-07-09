#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const portfolioRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const envPath = path.join(portfolioRoot, '.env.local')
const secretsPath = path.join(os.homedir(), '.secrets')
const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json')
const claudeConfigPath = path.join(os.homedir(), '.claude', 'config.json')
const claudeSecretsEnvPath = path.join(os.homedir(), '.claude', 'secrets.env')
const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')
const shellProfilePaths = ['.bashrc', '.bash_profile', '.profile', '.zshrc'].map((file) => path.join(os.homedir(), file))
const webSearchSkillEnvPath = path.join(os.homedir(), '.codex', 'skills', 'web-search', '.env')

const defaultModels = {
  ANTHROPIC_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5-20251001',
  BENCHMARK_REQUIRED_ANTHROPIC_MODELS: 'claude-sonnet-4-6,claude-opus-4-6',
}

async function main() {
  const existing = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}
  const secrets = existsSync(secretsPath) ? parseEnv(readFileSync(secretsPath, 'utf8')) : {}
  const claudeSecretsEnv = existsSync(claudeSecretsEnvPath) ? parseEnv(readFileSync(claudeSecretsEnvPath, 'utf8')) : {}
  const shellProfiles = readShellProfiles()
  const webSearchSkillEnv = existsSync(webSearchSkillEnvPath) ? parseEnv(readFileSync(webSearchSkillEnvPath, 'utf8')) : {}
  const claude = readClaudeSettings()
  const claudeConfig = readJson(claudeConfigPath)
  const codexProviders = readCodexProviders(codexConfigPath)
  const helperKey = runApiKeyHelper(claude?.apiKeyHelper)

  const keyCandidates = [
    ['Claude apiKeyHelper', helperKey],
    ['Claude settings env', claude?.env?.ANTHROPIC_API_KEY || claude?.env?.ANTHROPIC_AUTH_TOKEN],
    ['Claude config primaryApiKey', claudeConfig?.primaryApiKey],
    ['TK_API_KEY from ~/.secrets', secrets.TK_API_KEY],
    ['TK_API_KEY from ~/.claude/secrets.env', claudeSecretsEnv.TK_API_KEY],
    ['TK_API_KEY from shell profile', shellProfiles.TK_API_KEY],
    ['ANTHROPIC_API_KEY from shell profile', shellProfiles.ANTHROPIC_API_KEY],
    ['ANTHROPIC_AUTH_TOKEN from shell profile', shellProfiles.ANTHROPIC_AUTH_TOKEN],
    ['ANTHROPIC_API_KEY from ~/.claude/secrets.env', claudeSecretsEnv.ANTHROPIC_API_KEY],
    ['ANTHROPIC_AUTH_TOKEN from ~/.claude/secrets.env', claudeSecretsEnv.ANTHROPIC_AUTH_TOKEN],
    ['existing benchmark env file', existing.ANTHROPIC_API_KEY],
  ].filter(([, value]) => Boolean(value))

  const [keySource, apiKey] = keyCandidates[0] ?? []
  if (!apiKey) throw new Error('No Anthropic API key found in ~/.secrets, ~/.claude/secrets.env, shell profiles, Claude apiKeyHelper, Claude config, existing .env.local, or Claude settings env.')

  const requiredModels = (existing.BENCHMARK_REQUIRED_ANTHROPIC_MODELS || defaultModels.BENCHMARK_REQUIRED_ANTHROPIC_MODELS)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
  const baseUrlCandidates = [
    ['Claude settings env', claude?.env?.ANTHROPIC_BASE_URL],
    ...codexProviders.map((provider) => [`Codex provider ${provider.id}`, provider.baseUrl]),
    ['existing benchmark env file', existing.ANTHROPIC_BASE_URL],
    ['TK_BASE_URL from ~/.secrets', secrets.TK_BASE_URL],
    ['TK_API_BASE_URL from ~/.secrets', secrets.TK_API_BASE_URL],
    ['TK_BASE_URL from ~/.claude/secrets.env', claudeSecretsEnv.TK_BASE_URL],
    ['TK_API_BASE_URL from ~/.claude/secrets.env', claudeSecretsEnv.TK_API_BASE_URL],
    ['TK_BASE_URL from shell profile', shellProfiles.TK_BASE_URL],
    ['TK_API_BASE_URL from shell profile', shellProfiles.TK_API_BASE_URL],
    ['ANTHROPIC_BASE_URL from shell profile', shellProfiles.ANTHROPIC_BASE_URL],
    ['ANTHROPIC_BASE_URL from ~/.claude/secrets.env', claudeSecretsEnv.ANTHROPIC_BASE_URL],
  ].filter(([, value]) => Boolean(value))

  const selectedBaseUrl = await selectReachableBaseUrl(baseUrlCandidates, apiKey, requiredModels)
  const [baseUrlSource, baseUrl] = selectedBaseUrl ?? []
  if (!baseUrl) throw new Error('No ANTHROPIC_BASE_URL found in existing benchmark env file, ~/.secrets, ~/.claude/secrets.env, shell profiles, or ~/.claude/settings.json.')

  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: existing.ANTHROPIC_MODEL || shellProfiles.ANTHROPIC_MODEL || claude?.env?.ANTHROPIC_MODEL || defaultModels.ANTHROPIC_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: existing.ANTHROPIC_SMALL_FAST_MODEL || shellProfiles.ANTHROPIC_SMALL_FAST_MODEL || claude?.env?.ANTHROPIC_SMALL_FAST_MODEL || defaultModels.ANTHROPIC_SMALL_FAST_MODEL,
    BENCHMARK_REQUIRED_ANTHROPIC_MODELS: requiredModels.join(','),
    SERPER_API_KEY: firstValue([
      ['existing benchmark env file', existing.SERPER_API_KEY],
      ['SERPER_API_KEY from ~/.secrets', secrets.SERPER_API_KEY],
      ['SERPER_API_KEY from ~/.claude/secrets.env', claudeSecretsEnv.SERPER_API_KEY],
      ['SERPER_API_KEY from shell profile', shellProfiles.SERPER_API_KEY],
      ['SERPER_API_KEY from web-search skill env', webSearchSkillEnv.SERPER_API_KEY],
    ]),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: existing.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || '1',
    CLAUDE_CODE_ATTRIBUTION_HEADER: existing.CLAUDE_CODE_ATTRIBUTION_HEADER || '0',
  }

  mkdirSync(portfolioRoot, { recursive: true })
  writeFileSync(envPath, renderEnv(env), { mode: 0o600 })
  chmodSync(envPath, 0o600)

  console.log('benchmark env synced')
  console.log(`- path: ${rel(envPath)}`)
  console.log(`- base_url: ${redactUrl(env.ANTHROPIC_BASE_URL)}`)
  console.log(`- base_url_source: ${baseUrlSource}`)
  console.log(`- key_source: ${keySource}`)
  console.log(`- key_sha12: ${shortSha(env.ANTHROPIC_API_KEY)}`)
  console.log(`- model: ${env.ANTHROPIC_MODEL}`)
  console.log(`- small_fast_model: ${env.ANTHROPIC_SMALL_FAST_MODEL}`)
  console.log(`- required_models: ${env.BENCHMARK_REQUIRED_ANTHROPIC_MODELS}`)
  console.log(`- serper_api_key: ${env.SERPER_API_KEY ? `present sha12:${shortSha(env.SERPER_API_KEY)}` : 'missing'}`)
}

async function selectReachableBaseUrl(candidates, apiKey, requiredModels) {
  const deduped = []
  const seen = new Set()
  for (const [source, rawBaseUrl] of candidates) {
    const normalized = normalizeBaseUrl(rawBaseUrl)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push([source, normalized])
  }
  if (deduped.length === 0) return null

  const attempts = []
  for (const [source, baseUrl] of deduped) {
    const probe = await probeModels(baseUrl, apiKey)
    attempts.push({ source, baseUrl, probe })
    if (probe.status !== 'ok') continue
    const listed = new Set(probe.models)
    if (requiredModels.every((model) => listed.has(model))) {
      return [`${source} (models probe passed)`, baseUrl]
    }
  }

  const reachable = attempts.find((attempt) => attempt.probe.status === 'ok')
  if (reachable) return [`${reachable.source} (models probe reachable, required models incomplete)`, reachable.baseUrl]

  const first = deduped[0]
  console.warn('warning: no candidate Anthropic endpoint passed /models probing; leaving the first configured candidate for diagnosis')
  for (const attempt of attempts) {
    console.warn(`- ${attempt.source}: ${redactUrl(attempt.baseUrl)} ${attempt.probe.status}${attempt.probe.error ? ` (${attempt.probe.error})` : ''}`)
  }
  return first
}

async function probeModels(baseUrl, apiKey) {
  const url = joinAnthropicPath(baseUrl, '/models')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) return { status: `http_${res.status}`, models: [], error: summarizeText(text) }
    const json = JSON.parse(text)
    return { status: 'ok', models: extractModelIds(json) }
  } catch (error) {
    return { status: 'fetch_error', models: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

function extractModelIds(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  return Array.from(new Set(rows.map((row) => typeof row === 'string' ? row : row?.id).filter((id) => typeof id === 'string'))).sort()
}

function joinAnthropicPath(base, tail) {
  const trimmed = String(base).replace(/\/+$/, '').replace(/\/messages$/, '')
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${versioned}${tail.startsWith('/') ? tail : `/${tail}`}`
}

function normalizeBaseUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(String(raw).trim())
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function summarizeText(text) {
  return String(text).replace(/\s+/g, ' ').slice(0, 160)
}

function renderEnv(env) {
  return [
    '# Local benchmark credentials. Do not commit.',
    '# Generated by scripts/eval/benchmarks/core/sync-benchmark-env.mjs.',
    '# Benchmark runners load this file by default and let it override ambient ANTHROPIC_* values.',
    `ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}`,
    `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}`,
    `ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL}`,
    `ANTHROPIC_SMALL_FAST_MODEL=${env.ANTHROPIC_SMALL_FAST_MODEL}`,
    `BENCHMARK_REQUIRED_ANTHROPIC_MODELS=${env.BENCHMARK_REQUIRED_ANTHROPIC_MODELS}`,
    ...(env.SERPER_API_KEY ? [`SERPER_API_KEY=${env.SERPER_API_KEY}`] : []),
    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=${env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC}`,
    `CLAUDE_CODE_ATTRIBUTION_HEADER=${env.CLAUDE_CODE_ATTRIBUTION_HEADER}`,
    '',
  ].join('\n')
}

function firstValue(candidates) {
  return candidates.find(([, value]) => Boolean(value))?.[1] || ''
}

function parseEnv(raw) {
  const out = {}
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function readClaudeSettings() {
  return readJson(claudeSettingsPath)
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function readShellProfiles() {
  const merged = {}
  for (const profilePath of shellProfilePaths) {
    if (!existsSync(profilePath)) continue
    Object.assign(merged, parseEnv(readFileSync(profilePath, 'utf8')))
  }
  return merged
}

function readCodexProviders(filePath) {
  if (!existsSync(filePath)) return []
  const providers = []
  let current = null
  for (const rawLine of readFileSync(filePath, 'utf8').split('\n')) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue
    const header = line.match(/^\[model_providers\.([^\]]+)\]$/)
    if (header) {
      current = { id: header[1] }
      providers.push(current)
      continue
    }
    if (!current) continue
    const kv = line.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.+)$/)
    if (!kv) continue
    const key = kv[1]
    const value = parseTomlString(kv[2])
    if (value === undefined) continue
    if (key === 'base_url') current.baseUrl = value
    else if (key === 'env_key') current.envKey = value
    else if (key === 'wire_api') current.wireApi = value
  }
  return providers.filter((provider) => provider.baseUrl)
}

function stripTomlComment(line) {
  let inString = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inString = !inString
    else if (c === '#' && !inString) return line.slice(0, i)
  }
  return line
}

function parseTomlString(raw) {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  return undefined
}

function runApiKeyHelper(command) {
  if (!command) return ''
  try {
    return execFileSync('/bin/sh', ['-lc', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
  } catch {
    return ''
  }
}

function redactUrl(raw) {
  try {
    const url = new URL(raw)
    return `${url.protocol}//host-${shortSha(url.host)}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return '<invalid-url>'
  }
}

function shortSha(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

function rel(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

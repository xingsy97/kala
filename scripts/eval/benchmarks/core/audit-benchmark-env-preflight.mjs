#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const legacy-runnerRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const envPath = path.join(legacy-runnerRoot, '.env.local')
const resultsRoot = path.join(legacy-runnerRoot, 'results')
const fallbackRequiredModels = ['claude-sonnet-4-6', 'claude-opus-4-6']

async function main() {
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}
  const claudeSettings = readClaudeSettings()
  const helperKey = runApiKeyHelper(claudeSettings?.apiKeyHelper)
  const mode = existsSync(envPath) ? (statSync(envPath).mode & 0o777).toString(8) : null
  const baseUrl = env.ANTHROPIC_BASE_URL || ''
  const requiredModels = requiredModelsFromEnv(env)
  const modelEndpoint = baseUrl ? joinAnthropicPath(baseUrl, '/models') : ''
  const modelProbe = await probeModels(modelEndpoint, env.ANTHROPIC_API_KEY)
  const searchProbe = await probeSerper(env.SERPER_API_KEY)
  const presentModels = new Set(modelProbe.models)
  const missingRequiredModels = requiredModels.filter((model) => !presentModels.has(model))
  const checks = {
    env_file_exists: existsSync(envPath),
    env_file_gitignored: gitCheckIgnored(envPath),
    env_file_permissions_safe: mode === '600',
    anthropic_api_key_present: Boolean(env.ANTHROPIC_API_KEY),
    anthropic_api_key_matches_claude_helper: Boolean(helperKey && env.ANTHROPIC_API_KEY && shortSha(helperKey) === shortSha(env.ANTHROPIC_API_KEY)),
    anthropic_base_url_present: Boolean(baseUrl),
    anthropic_base_url_matches_claude_settings: Boolean(baseUrl && claudeSettings?.env?.ANTHROPIC_BASE_URL === baseUrl),
    anthropic_model_present: Boolean(env.ANTHROPIC_MODEL),
    anthropic_small_fast_model_present: Boolean(env.ANTHROPIC_SMALL_FAST_MODEL),
    serper_api_key_present: Boolean(env.SERPER_API_KEY),
    models_endpoint_reachable: modelProbe.status === 'ok',
    required_models_present: modelProbe.status === 'ok' && missingRequiredModels.length === 0,
  }
  const status = computeStatus(checks, modelProbe)
  const report = {
    schema_version: 1,
    generated_by: 'scripts/eval/benchmarks/core/audit-benchmark-env-preflight.mjs',
    generated_at: new Date().toISOString(),
    status,
    purpose: 'No-inference preflight gate for benchmark runs. This script only probes the Anthropic-compatible models endpoint and must pass before paid benchmark runs start.',
    env_file: {
      path: rel(envPath),
      exists: checks.env_file_exists,
      mode,
      gitignored: checks.env_file_gitignored,
    },
    credentials: {
      anthropic_api_key_present: checks.anthropic_api_key_present,
      claude_api_key_helper_present: Boolean(claudeSettings?.apiKeyHelper),
      anthropic_api_key_matches_claude_helper: checks.anthropic_api_key_matches_claude_helper,
    },
    endpoint: {
      base_url_source: env.ANTHROPIC_BASE_URL ? 'env-file' : 'missing',
      base_url_redacted: redactUrl(baseUrl),
      model_endpoint_redacted: redactUrl(modelEndpoint),
      matches_claude_settings: checks.anthropic_base_url_matches_claude_settings,
      claude_settings_match_required: false,
      probe_status: modelProbe.status,
      http_status: modelProbe.httpStatus,
      error: modelProbe.error,
    },
    models: {
      configured_primary: env.ANTHROPIC_MODEL || null,
      configured_small_fast: env.ANTHROPIC_SMALL_FAST_MODEL || null,
      required: requiredModels,
      present_required: requiredModels.filter((model) => presentModels.has(model)),
      missing_required: missingRequiredModels,
      listed_count: modelProbe.models.length,
      listed_ids: modelProbe.models,
    },
    web_search: {
      serper_api_key_present: checks.serper_api_key_present,
      probe_status: searchProbe.status,
      http_status: searchProbe.httpStatus,
      organic_count: searchProbe.organicCount,
      error: searchProbe.error,
    },
    checks,
    next_gate: nextGate(status, modelProbe, missingRequiredModels),
  }
  await mkdir(resultsRoot, { recursive: true })
  await writeFile(path.join(resultsRoot, 'benchmark-env-preflight.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(resultsRoot, 'benchmark-env-preflight.md'), renderMarkdown(report))
  console.log(`benchmark env preflight ${status}`)
  if (status === 'missing_env_file' || status === 'missing_required_secret' || status === 'unsafe_permissions') process.exitCode = 1
}

function requiredModelsFromEnv(env) {
  if (env.BENCHMARK_REQUIRED_ANTHROPIC_MODELS) {
    return env.BENCHMARK_REQUIRED_ANTHROPIC_MODELS.split(',').map((model) => model.trim()).filter(Boolean)
  }
  return Array.from(new Set([env.ANTHROPIC_MODEL, ...fallbackRequiredModels].filter(Boolean)))
}

function computeStatus(checks, modelProbe) {
  if (!checks.env_file_exists) return 'missing_env_file'
  if (!checks.env_file_permissions_safe) return 'unsafe_permissions'
  if (!checks.anthropic_api_key_present || !checks.anthropic_base_url_present) return 'missing_required_secret'
  if (modelProbe.status !== 'ok') return 'endpoint_unreachable'
  if (!checks.required_models_present) return 'missing_required_model'
  return 'pass'
}

function nextGate(status, modelProbe, missingRequiredModels) {
  if (status === 'pass') return 'The Anthropic-compatible endpoint is reachable and lists the required Sonnet and Opus models; paid benchmark runs may proceed only with their own cost gates.'
  if (status === 'endpoint_unreachable') return `Do not start paid runs. Fix or start the configured Anthropic-compatible endpoint first. Probe status: ${modelProbe.error || 'unreachable'}.`
  if (status === 'missing_required_model') return `Do not start controlled comparison runs until the endpoint lists: ${missingRequiredModels.join(', ')}.`
  if (status === 'unsafe_permissions') return 'Run chmod 600 experiments/evals/2026-07-agent-benchmark-comparison/.env.local before continuing.'
  return 'Populate experiments/evals/2026-07-agent-benchmark-comparison/.env.local with ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY before continuing.'
}

async function probeModels(url, apiKey) {
  if (!url || !apiKey) return { status: 'skipped', models: [], error: 'missing endpoint or key' }
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
    if (!res.ok) return { status: 'http_error', httpStatus: res.status, models: [], error: summarizeText(text) }
    const json = JSON.parse(text)
    return { status: 'ok', httpStatus: res.status, models: extractModelIds(json), error: null }
  } catch (error) {
    return { status: 'fetch_error', models: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function probeSerper(apiKey) {
  if (!apiKey) return { status: 'skipped', organicCount: 0, error: 'missing SERPER_API_KEY' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ q: 'BrowseComp benchmark', num: 1 }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) return { status: 'http_error', httpStatus: res.status, organicCount: 0, error: summarizeText(text) }
    const json = JSON.parse(text)
    const organic = Array.isArray(json?.organic) ? json.organic : []
    return { status: 'ok', httpStatus: res.status, organicCount: organic.length, error: null }
  } catch (error) {
    return { status: 'fetch_error', organicCount: 0, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

function extractModelIds(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  return Array.from(new Set(rows.map((row) => typeof row === 'string' ? row : row?.id).filter((id) => typeof id === 'string'))).sort()
}

function parseEnv(raw) {
  const out = {}
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function readClaudeSettings() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return null
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return null
  }
}

function runApiKeyHelper(command) {
  if (!command) return ''
  try {
    return execFileSync('/bin/sh', ['-lc', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
  } catch {
    return ''
  }
}

function gitCheckIgnored(filePath) {
  try {
    execFileSync('git', ['check-ignore', '-q', filePath], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function joinAnthropicPath(base, tail) {
  const trimmed = base.replace(/\/+$/, '').replace(/\/messages$/, '')
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${versioned}${tail.startsWith('/') ? tail : `/${tail}`}`
}

function redactUrl(raw) {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const hostHash = shortSha(url.host)
    return `${url.protocol}//host-${hostHash}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return '<invalid-url>'
  }
}

function shortSha(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

function summarizeText(text) {
  return text.replace(/\s+/g, ' ').slice(0, 300)
}

function rel(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/')
}

function renderMarkdown(report) {
  const lines = [
    '# Benchmark Environment Preflight',
    '',
    `Status: \`${report.status}\``,
    '',
    'This audit does not make model inference calls. It only verifies local configuration and probes the Anthropic-compatible models endpoint.',
    '',
    '## Local Env File',
    '',
    `- Path: \`${report.env_file.path}\``,
    `- Exists: ${yesNo(report.env_file.exists)}`,
    `- Mode: \`${report.env_file.mode ?? 'missing'}\``,
    `- Gitignored: ${yesNo(report.env_file.gitignored)}`,
    '',
    '## Credential Source',
    '',
    `- Env file API key present: ${yesNo(report.credentials.anthropic_api_key_present)}`,
    `- Claude apiKeyHelper present: ${yesNo(report.credentials.claude_api_key_helper_present)}`,
    `- Env file key matches Claude helper: ${yesNo(report.credentials.anthropic_api_key_matches_claude_helper)}`,
    '',
    '## Endpoint',
    '',
    `- Base URL source: \`${report.endpoint.base_url_source}\``,
    `- Base URL redacted: \`${report.endpoint.base_url_redacted ?? 'missing'}\``,
    `- Models endpoint redacted: \`${report.endpoint.model_endpoint_redacted ?? 'missing'}\``,
    `- Matches Claude settings: ${yesNo(report.endpoint.matches_claude_settings)} (not required; benchmark env file is the controlled source)`,
    `- Probe status: \`${report.endpoint.probe_status}\``,
    `- HTTP status: \`${report.endpoint.http_status ?? 'n/a'}\``,
    report.endpoint.error ? `- Error: ${report.endpoint.error}` : '- Error: none',
    '',
    '## Required Models',
    '',
    `- Configured primary: \`${report.models.configured_primary ?? 'missing'}\``,
    `- Configured small-fast: \`${report.models.configured_small_fast ?? 'missing'}\``,
    `- Required: ${report.models.required.map((model) => `\`${model}\``).join(', ')}`,
    `- Present required: ${report.models.present_required.length ? report.models.present_required.map((model) => `\`${model}\``).join(', ') : 'none'}`,
    `- Missing required: ${report.models.missing_required.length ? report.models.missing_required.map((model) => `\`${model}\``).join(', ') : 'none'}`,
    `- Listed model count: ${report.models.listed_count}`,
    '',
    '## Web Search',
    '',
    `- Serper API key present: ${yesNo(report.web_search.serper_api_key_present)}`,
    `- Serper probe status: \`${report.web_search.probe_status}\``,
    `- Serper HTTP status: \`${report.web_search.http_status ?? 'n/a'}\``,
    `- Serper organic count: ${report.web_search.organic_count}`,
    report.web_search.error ? `- Serper error: ${report.web_search.error}` : '- Serper error: none',
    '',
    '## Next Gate',
    '',
    report.next_gate,
    '',
  ]
  return lines.join('\n')
}

function yesNo(value) {
  return value ? 'yes' : 'no'
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

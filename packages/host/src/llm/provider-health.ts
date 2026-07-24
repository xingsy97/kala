/**
 * Provider health registry and error taxonomy.
 *
 * Provides low-cardinality error labels so router/fallback logic can make
 * consistent decisions without inspecting raw provider errors, and so the
 * artifact store can hold a stable record of what happened.
 *
 * The registry is process-local. Its state is not durable, but the router
 * decision artifacts written after each call preserve the observable outcome
 * for later inspection.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ProviderErrorLabel =
  | 'retryable'
  | 'rate_limited'
  | 'auth_error'
  | 'schema_error'
  | 'context_length_exceeded'
  | 'model_not_found'
  | 'non_retryable'
  | 'unknown'

export type ProviderCallOutcome = {
  provider: string
  model?: string
  adapterName?: string
  ok: boolean
  label?: ProviderErrorLabel
  durationMs?: number
  timestamp: string
}

export type ProviderHealthEntry = {
  provider: string
  totalCalls: number
  successCount: number
  errorCount: number
  errorLabels: Record<ProviderErrorLabel, number>
  lastCallAt?: string
  lastErrorAt?: string
  lastErrorLabel?: ProviderErrorLabel
  consecutiveErrors: number
  circuitOpenUntil?: string
}

export type ProviderHealthRegistry = {
  record(outcome: ProviderCallOutcome): void
  entry(provider: string): ProviderHealthEntry | undefined
  entries(): readonly ProviderHealthEntry[]
  isProviderHealthy(provider: string, now?: number): boolean
  clear(): void
}

export type ProviderHealthRegistryOptions = {
  /** Break the circuit after this many consecutive errors. Default 3. */
  circuitBreakerThreshold?: number
  /** How long to keep the circuit open once tripped, in ms. Default 30_000. */
  circuitBreakerCooldownMs?: number
}

const DEFAULT_CIRCUIT_THRESHOLD = 3
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000

export function createProviderHealthRegistry(
  options: ProviderHealthRegistryOptions = {},
): ProviderHealthRegistry {
  const threshold = options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_THRESHOLD
  const cooldownMs = options.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS
  const entries = new Map<string, ProviderHealthEntry>()

  function ensure(provider: string): ProviderHealthEntry {
    let entry = entries.get(provider)
    if (!entry) {
      entry = {
        provider,
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        errorLabels: emptyLabels(),
        consecutiveErrors: 0,
      }
      entries.set(provider, entry)
    }
    return entry
  }

  return {
    record(outcome: ProviderCallOutcome): void {
      const entry = ensure(outcome.provider)
      entry.totalCalls += 1
      entry.lastCallAt = outcome.timestamp
      if (outcome.ok) {
        entry.successCount += 1
        entry.consecutiveErrors = 0
        return
      }
      const label = outcome.label ?? 'unknown'
      entry.errorCount += 1
      entry.errorLabels[label] = (entry.errorLabels[label] ?? 0) + 1
      entry.lastErrorAt = outcome.timestamp
      entry.lastErrorLabel = label
      if (label === 'auth_error' || label === 'schema_error' || label === 'model_not_found' || label === 'context_length_exceeded' || label === 'non_retryable') {
        entry.consecutiveErrors += 1
        if (entry.consecutiveErrors >= threshold) {
          entry.circuitOpenUntil = new Date(Date.now() + cooldownMs).toISOString()
        }
      } else if (label === 'rate_limited' || label === 'retryable') {
        entry.consecutiveErrors += 1
        if (entry.consecutiveErrors >= threshold) {
          entry.circuitOpenUntil = new Date(Date.now() + Math.min(cooldownMs, 10_000)).toISOString()
        }
      } else {
        entry.consecutiveErrors += 1
      }
    },
    entry(provider): ProviderHealthEntry | undefined {
      const found = entries.get(provider)
      if (!found) return undefined
      return { ...found, errorLabels: { ...found.errorLabels } }
    },
    entries(): readonly ProviderHealthEntry[] {
      return [...entries.values()].map((entry) => ({ ...entry, errorLabels: { ...entry.errorLabels } }))
    },
    isProviderHealthy(provider: string, now = Date.now()): boolean {
      const entry = entries.get(provider)
      if (!entry) return true
      if (!entry.circuitOpenUntil) return true
      if (Date.parse(entry.circuitOpenUntil) <= now) {
        entry.circuitOpenUntil = undefined
        entry.consecutiveErrors = 0
        return true
      }
      return false
    },
    clear(): void {
      entries.clear()
    },
  }
}

function emptyLabels(): Record<ProviderErrorLabel, number> {
  return {
    retryable: 0,
    rate_limited: 0,
    auth_error: 0,
    schema_error: 0,
    context_length_exceeded: 0,
    model_not_found: 0,
    non_retryable: 0,
    unknown: 0,
  }
}

/**
 * Classify a raw provider error into a low-cardinality label.
 *
 * Heuristics are intentionally simple: real adapters may set `error.label`
 * directly to short-circuit this; otherwise we look at HTTP status codes,
 * common error name strings, and finally the message text.
 */
export function classifyProviderError(err: unknown): ProviderErrorLabel {
  if (err === null || err === undefined) return 'unknown'
  if (typeof err === 'object' && 'label' in err && typeof (err as { label: unknown }).label === 'string') {
    const explicit = (err as { label: string }).label
    if (isProviderErrorLabel(explicit)) return explicit
  }
  const status = extractStatusCode(err)
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'auth_error'
    if (status === 404) return 'model_not_found'
    if (status === 408) return 'retryable'
    if (status === 409) return 'retryable'
    if (status === 413) return 'context_length_exceeded'
    if (status === 429) return 'rate_limited'
    if (status === 422 || status === 400) return 'schema_error'
    if (status >= 500) return 'retryable'
  }
  const message = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').toLowerCase()
  if (message.includes('rate limit') || message.includes('rate_limit')) return 'rate_limited'
  if (message.includes('unauthorized') || message.includes('invalid api key') || message.includes('forbidden')) return 'auth_error'
  if (message.includes('context length') || message.includes('token limit') || message.includes('prompt is too long')) return 'context_length_exceeded'
  if (message.includes('model not found') || message.includes('unknown model')) return 'model_not_found'
  if (message.includes('invalid request') || message.includes('validation') || message.includes('bad request')) return 'schema_error'
  if (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('aborted') ||
    message.includes('econnreset') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('socket')
  ) return 'retryable'
  return 'unknown'
}

function isProviderErrorLabel(value: string): value is ProviderErrorLabel {
  return (
    value === 'retryable' ||
    value === 'rate_limited' ||
    value === 'auth_error' ||
    value === 'schema_error' ||
    value === 'context_length_exceeded' ||
    value === 'model_not_found' ||
    value === 'non_retryable' ||
    value === 'unknown'
  )
}

function extractStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const candidate = err as { status?: unknown; statusCode?: unknown; code?: unknown }
  const raw = candidate.status ?? candidate.statusCode
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  if (typeof candidate.code === 'string') {
    const parsed = Number(candidate.code)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return undefined
}

export function isRetryable(label: ProviderErrorLabel): boolean {
  return label === 'retryable' || label === 'rate_limited'
}

export function isFallbackWorthy(label: ProviderErrorLabel): boolean {
  return (
    label === 'rate_limited' ||
    label === 'retryable' ||
    label === 'auth_error' ||
    label === 'model_not_found' ||
    label === 'context_length_exceeded' ||
    label === 'non_retryable'
  )
}

export type ProviderFallbackAttempt = {
  provider: string
  adapterName?: string
  model?: string
  requestedModelRef?: string
  routedModelId?: string
  label?: ProviderErrorLabel
  durationMs?: number
  retryCount: number
}

export type ProviderFallbackArtifact = {
  schemaVersion: 1
  sessionId?: string
  eventSeq?: number
  timestamp: string
  attempts: readonly ProviderFallbackAttempt[]
  finalOutcome: 'success' | 'exhausted' | 'unretryable'
  selectedProvider?: string
  selectedAdapter?: string
  selectedModel?: string
  requestedModelRef?: string
  routedModelId?: string
}

export async function writeFallbackArtifact(input: {
  rootDir: string
  sessionId?: string
  eventSeq?: number
  artifact: ProviderFallbackArtifact
}): Promise<string> {
  const subdir = input.sessionId ? join('router-decisions', input.sessionId) : 'router-decisions'
  const dir = join(input.rootDir, subdir)
  await mkdir(dir, { recursive: true })
  const stamp = input.eventSeq !== undefined
    ? `${String(input.eventSeq).padStart(6, '0')}.fallbacks.json`
    : `${new Date().toISOString().replace(/[:.]/g, '-')}.fallbacks.json`
  const target = join(dir, stamp)
  await writeFile(target, `${JSON.stringify(input.artifact, null, 2)}\n`, 'utf8')
  return target
}

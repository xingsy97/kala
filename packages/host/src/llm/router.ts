/**
 * Multi-provider router. When the CLI is started with several providers, we
 * build one adapter per (provider, model) and pick between them per call.
 * Matching prefers an exact `model` hit; otherwise it falls back to prefix
 * match; otherwise it uses the configured default. Exact-first ordering
 * matters when two entries share a stem (e.g. `gpt-5.5` and `gpt-5.5-mini`).
 *
 * When a provider health registry is attached, unhealthy adapters are
 * skipped; if a call fails with a fallback-worthy error label, the router
 * transparently retries against subsequent candidates.
 */

import {
  classifyProviderError,
  isFallbackWorthy,
  isRetryable,
  type ProviderErrorLabel,
  type ProviderFallbackArtifact,
  type ProviderFallbackAttempt,
  type ProviderHealthRegistry,
} from './provider-health.js'
import type { LLMAdapter, LLMCallParams, LLMResponse } from './adapter.js'

export type RouterOptions = {
  readonly defaultAdapter: LLMAdapter
  readonly byPrefix: ReadonlyArray<{ prefix: string; adapter: LLMAdapter }>
  readonly healthRegistry?: ProviderHealthRegistry
  readonly providerName?: (adapter: LLMAdapter) => string
  readonly maxFallbacks?: number
  readonly onDecision?: (decision: RouterDecision) => void
}

export type RouterDecision = {
  attempts: readonly ProviderFallbackAttempt[]
  finalOutcome: 'success' | 'exhausted' | 'unretryable'
  selectedProvider?: string
  selectedAdapter?: string
  selectedModel?: string
}

export type MutableRouter = LLMAdapter & {
  addRoute(prefix: string, adapter: LLMAdapter): void
  deleteRoute(prefix: string): void
  lastDecision(): RouterDecision | undefined
}

const DEFAULT_MAX_FALLBACKS = 2

export function routerAdapter(opts: RouterOptions): MutableRouter {
  const byPrefix = [...opts.byPrefix]
  const maxFallbacks = opts.maxFallbacks ?? DEFAULT_MAX_FALLBACKS
  const nameOf = opts.providerName ?? providerNameFromAdapter
  let lastDecision: RouterDecision | undefined
  return {
    name: `router(${[
      opts.defaultAdapter.name,
      ...byPrefix.map((p) => `${p.prefix}=${p.adapter.name}`),
    ].join(',')})`,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const candidates = candidateOrder({ defaultAdapter: opts.defaultAdapter, byPrefix }, params.model, opts.healthRegistry, nameOf)
      const attempts: ProviderFallbackAttempt[] = []
      const limit = Math.min(candidates.length, 1 + maxFallbacks)
      let lastError: unknown
      for (let i = 0; i < limit; i++) {
        const target = candidates[i]!
        const started = Date.now()
        try {
          const response = await target.call(params)
          const attempt: ProviderFallbackAttempt = {
            provider: nameOf(target),
            adapterName: target.name,
            ...(params.model ? { model: params.model } : {}),
            durationMs: Date.now() - started,
            retryCount: i,
          }
          attempts.push(attempt)
          opts.healthRegistry?.record({
            provider: attempt.provider,
            ...(params.model ? { model: params.model } : {}),
            adapterName: target.name,
            ok: true,
            durationMs: attempt.durationMs,
            timestamp: new Date().toISOString(),
          })
          lastDecision = {
            attempts,
            finalOutcome: 'success',
            selectedProvider: attempt.provider,
            selectedAdapter: target.name,
            ...(params.model ? { selectedModel: params.model } : {}),
          }
          opts.onDecision?.(lastDecision)
          return response
        } catch (err) {
          const label = classifyProviderError(err)
          const attempt: ProviderFallbackAttempt = {
            provider: nameOf(target),
            adapterName: target.name,
            ...(params.model ? { model: params.model } : {}),
            label,
            durationMs: Date.now() - started,
            retryCount: i,
          }
          attempts.push(attempt)
          opts.healthRegistry?.record({
            provider: attempt.provider,
            ...(params.model ? { model: params.model } : {}),
            adapterName: target.name,
            ok: false,
            label,
            durationMs: attempt.durationMs,
            timestamp: new Date().toISOString(),
          })
          lastError = err
          if (!shouldTryNext(label, i, limit - 1)) {
            lastDecision = { attempts, finalOutcome: 'unretryable' }
            opts.onDecision?.(lastDecision)
            throw err
          }
        }
      }
      lastDecision = { attempts, finalOutcome: 'exhausted' }
      opts.onDecision?.(lastDecision)
      if (lastError instanceof Error) throw lastError
      throw new Error('router: all candidates failed')
    },
    addRoute(prefix, adapter) {
      const existing = byPrefix.findIndex((p) => p.prefix === prefix)
      if (existing === -1) byPrefix.push({ prefix, adapter })
      else byPrefix[existing] = { prefix, adapter }
    },
    deleteRoute(prefix) {
      const index = byPrefix.findIndex((p) => p.prefix === prefix)
      if (index !== -1) byPrefix.splice(index, 1)
    },
    lastDecision() {
      return lastDecision
    },
  }
}

function shouldTryNext(label: ProviderErrorLabel, currentIndex: number, lastIndex: number): boolean {
  if (currentIndex >= lastIndex) return false
  if (label === 'auth_error') return false
  return isFallbackWorthy(label) || isRetryable(label)
}

function candidateOrder(
  opts: { defaultAdapter: LLMAdapter; byPrefix: ReadonlyArray<{ prefix: string; adapter: LLMAdapter }> },
  model: string | undefined,
  health: ProviderHealthRegistry | undefined,
  nameOf: (adapter: LLMAdapter) => string,
): readonly LLMAdapter[] {
  const primary = resolvePrimary(opts, model)
  const seen = new Set<string>()
  const ordered: LLMAdapter[] = []
  const push = (adapter: LLMAdapter): void => {
    const key = `${nameOf(adapter)}::${adapter.name}`
    if (seen.has(key)) return
    seen.add(key)
    ordered.push(adapter)
  }
  push(primary)
  for (const { adapter } of opts.byPrefix) push(adapter)
  push(opts.defaultAdapter)
  if (!health) return ordered
  const healthy = ordered.filter((adapter) => health.isProviderHealthy(nameOf(adapter)))
  return healthy.length > 0 ? healthy : ordered
}

function resolvePrimary(opts: { defaultAdapter: LLMAdapter; byPrefix: ReadonlyArray<{ prefix: string; adapter: LLMAdapter }> }, model: string | undefined): LLMAdapter {
  if (!model) return opts.defaultAdapter
  const exact = opts.byPrefix.find((p) => p.prefix === model)
  if (exact) return exact.adapter
  const prefix = opts.byPrefix.find((p) => model.startsWith(p.prefix))
  return prefix?.adapter ?? opts.defaultAdapter
}

function providerNameFromAdapter(adapter: LLMAdapter): string {
  const lower = adapter.name.toLowerCase()
  if (lower.includes('anthropic')) return 'anthropic'
  if (lower.includes('openai')) return 'openai'
  if (lower.includes('router(')) return 'router'
  return adapter.name
}

export function toFallbackArtifact(
  decision: RouterDecision,
  meta: { sessionId?: string; eventSeq?: number } = {},
): ProviderFallbackArtifact {
  return {
    schemaVersion: 1,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(meta.eventSeq !== undefined ? { eventSeq: meta.eventSeq } : {}),
    timestamp: new Date().toISOString(),
    attempts: decision.attempts,
    finalOutcome: decision.finalOutcome,
    ...(decision.selectedProvider ? { selectedProvider: decision.selectedProvider } : {}),
    ...(decision.selectedAdapter ? { selectedAdapter: decision.selectedAdapter } : {}),
    ...(decision.selectedModel ? { selectedModel: decision.selectedModel } : {}),
  }
}

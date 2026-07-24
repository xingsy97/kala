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
  readonly byPrefix: ReadonlyArray<RouteEntry>
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
  requestedModelRef?: string
  routedModelId?: string
}

export type MutableRouter = LLMAdapter & {
  addRoute(prefix: string, adapter: LLMAdapter, routedModel?: string): void
  deleteRoute(prefix: string): void
  lastDecision(): RouterDecision | undefined
}

export type RouteEntry = {
  prefix: string
  adapter: LLMAdapter
  /** Model id to send to the provider after this route matches. */
  routedModel?: string
}

type RouteTarget = {
  adapter: LLMAdapter
  routedModel?: string
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
        const routedParams = routeParams(params, target.routedModel)
        const started = Date.now()
        try {
          const response = await target.adapter.call(routedParams)
          const attempt: ProviderFallbackAttempt = {
            provider: nameOf(target.adapter),
            adapterName: target.adapter.name,
            ...(params.model ? { model: params.model } : {}),
            ...(params.model ? { requestedModelRef: params.model } : {}),
            ...(routedParams.model ? { routedModelId: routedParams.model } : {}),
            durationMs: Date.now() - started,
            retryCount: i,
          }
          attempts.push(attempt)
          opts.healthRegistry?.record({
            provider: attempt.provider,
            ...(params.model ? { model: params.model } : {}),
            adapterName: target.adapter.name,
            ok: true,
            durationMs: attempt.durationMs,
            timestamp: new Date().toISOString(),
          })
          lastDecision = {
            attempts,
            finalOutcome: 'success',
            selectedProvider: attempt.provider,
            selectedAdapter: target.adapter.name,
            ...(params.model ? { selectedModel: params.model } : {}),
            ...(params.model ? { requestedModelRef: params.model } : {}),
            ...(routedParams.model ? { routedModelId: routedParams.model } : {}),
          }
          opts.onDecision?.(lastDecision)
          return response
        } catch (err) {
          const label = classifyProviderError(err)
          const attempt: ProviderFallbackAttempt = {
            provider: nameOf(target.adapter),
            adapterName: target.adapter.name,
            ...(params.model ? { model: params.model } : {}),
            ...(params.model ? { requestedModelRef: params.model } : {}),
            ...(routedParams.model ? { routedModelId: routedParams.model } : {}),
            label,
            durationMs: Date.now() - started,
            retryCount: i,
          }
          attempts.push(attempt)
          opts.healthRegistry?.record({
            provider: attempt.provider,
            ...(params.model ? { model: params.model } : {}),
            adapterName: target.adapter.name,
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
    addRoute(prefix, adapter, routedModel) {
      const existing = byPrefix.findIndex((p) => p.prefix === prefix)
      const route = { prefix, adapter, ...(routedModel ? { routedModel } : {}) }
      if (existing === -1) byPrefix.push(route)
      else byPrefix[existing] = route
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
  opts: { defaultAdapter: LLMAdapter; byPrefix: ReadonlyArray<RouteEntry> },
  model: string | undefined,
  health: ProviderHealthRegistry | undefined,
  nameOf: (adapter: LLMAdapter) => string,
): readonly RouteTarget[] {
  const primary = resolvePrimary(opts, model)
  const seen = new Set<string>()
  const ordered: RouteTarget[] = []
  const push = (target: RouteTarget): void => {
    const key = `${nameOf(target.adapter)}::${target.adapter.name}::${target.routedModel ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    ordered.push(target)
  }
  push(primary)
  for (const route of opts.byPrefix) push({ adapter: route.adapter, ...(route.routedModel ? { routedModel: route.routedModel } : {}) })
  push({ adapter: opts.defaultAdapter })
  if (!health) return ordered
  const healthy = ordered.filter((target) => health.isProviderHealthy(nameOf(target.adapter)))
  return healthy.length > 0 ? healthy : ordered
}

function resolvePrimary(opts: { defaultAdapter: LLMAdapter; byPrefix: ReadonlyArray<RouteEntry> }, model: string | undefined): RouteTarget {
  if (!model) return { adapter: opts.defaultAdapter }
  const exact = opts.byPrefix.find((p) => p.prefix === model)
  if (exact) return { adapter: exact.adapter, ...(exact.routedModel ? { routedModel: exact.routedModel } : {}) }
  const prefix = opts.byPrefix.find((p) => model.startsWith(p.prefix))
  return prefix ? { adapter: prefix.adapter, ...(prefix.routedModel ? { routedModel: prefix.routedModel } : {}) } : { adapter: opts.defaultAdapter }
}

function routeParams(params: LLMCallParams, routedModel: string | undefined): LLMCallParams {
  if (!routedModel || params.model === routedModel) return params
  return { ...params, model: routedModel }
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
    ...(decision.requestedModelRef ? { requestedModelRef: decision.requestedModelRef } : {}),
    ...(decision.routedModelId ? { routedModelId: decision.routedModelId } : {}),
  }
}

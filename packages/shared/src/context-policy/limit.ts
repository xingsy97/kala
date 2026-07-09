import type { ContextUsageSnapshot } from '../context-usage/types.js'

export type ContextLimitPolicy = {
  unknownModelFallbackTokens?: number
  reserveOutputTokens?: number
}

export type ResolvedContextLimit = {
  tokens: number | null
  source: 'snapshot' | 'policy_fallback' | 'unknown'
}

export function resolveContextLimit(snapshot: ContextUsageSnapshot, policy: ContextLimitPolicy = {}): ResolvedContextLimit {
  const rawLimit = positiveInt(snapshot.contextWindow.tokens ?? undefined)
  const rawSource: ResolvedContextLimit['source'] = rawLimit !== undefined ? 'snapshot' : 'unknown'
  const fallback = positiveInt(policy.unknownModelFallbackTokens)
  const limit = rawLimit ?? fallback
  const source: ResolvedContextLimit['source'] = rawLimit !== undefined ? rawSource : fallback !== undefined ? 'policy_fallback' : 'unknown'
  if (limit === undefined) return { tokens: null, source }
  const reserve = positiveInt(policy.reserveOutputTokens) ?? 0
  return { tokens: Math.max(1, limit - reserve), source }
}

function positiveInt(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const int = Math.floor(value)
  return int > 0 ? int : undefined
}


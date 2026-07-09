import type { ContextUsageSnapshot } from '../context-usage/types.js'
import { resolveContextLimit, type ContextLimitPolicy } from './limit.js'

export type ContextPressureLevel = 'unknown' | 'low' | 'medium' | 'high' | 'critical'

export type ContextPressurePolicy = {
  mediumRatio: number
  highRatio: number
  criticalRatio: number
}

export type ContextPressureEvaluation = {
  level: ContextPressureLevel
  ratio: number | null
  usedTokens: number
  limitTokens: number | null
  limitSource: 'snapshot' | 'policy_fallback' | 'unknown'
}

export const DEFAULT_CONTEXT_PRESSURE_POLICY: ContextPressurePolicy = {
  mediumRatio: 0.6,
  highRatio: 0.8,
  criticalRatio: 0.92,
}

export function evaluateContextPressure(
  snapshot: ContextUsageSnapshot | null | undefined,
  limitPolicy: ContextLimitPolicy = {},
  pressurePolicy: ContextPressurePolicy = DEFAULT_CONTEXT_PRESSURE_POLICY,
): ContextPressureEvaluation {
  const usedTokens = Math.max(0, Math.floor(snapshot?.usage.inputTokens ?? 0))
  if (!snapshot) return { level: 'unknown', ratio: null, usedTokens, limitTokens: null, limitSource: 'unknown' }
  const limit = resolveContextLimit(snapshot, limitPolicy)
  if (!limit.tokens) return { level: 'unknown', ratio: null, usedTokens, limitTokens: null, limitSource: limit.source }
  const ratio = usedTokens / limit.tokens
  if (ratio >= pressurePolicy.criticalRatio) return { level: 'critical', ratio, usedTokens, limitTokens: limit.tokens, limitSource: limit.source }
  if (ratio >= pressurePolicy.highRatio) return { level: 'high', ratio, usedTokens, limitTokens: limit.tokens, limitSource: limit.source }
  if (ratio >= pressurePolicy.mediumRatio) return { level: 'medium', ratio, usedTokens, limitTokens: limit.tokens, limitSource: limit.source }
  return { level: 'low', ratio, usedTokens, limitTokens: limit.tokens, limitSource: limit.source }
}


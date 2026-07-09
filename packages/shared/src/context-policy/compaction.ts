import type { ContextUsageSnapshot } from '../context-usage/types.js'
import type { ContextLimitPolicy } from './limit.js'
import { evaluateContextPressure } from './pressure.js'

export type ContextCompactionPolicy = {
  triggerRatio: number
  minInputTokens?: number
}

export type ContextCompactionDecision = {
  shouldCompact: boolean
  reason: 'ratio_exceeded' | 'below_threshold' | 'unknown_limit' | 'insufficient_usage'
  ratio: number | null
  usedTokens: number
  limitTokens: number | null
}

export const DEFAULT_CONTEXT_COMPACTION_POLICY: ContextCompactionPolicy = {
  triggerRatio: 0.92,
}

export function shouldCompactContext(
  snapshot: ContextUsageSnapshot | null | undefined,
  limitPolicy: ContextLimitPolicy = {},
  compactionPolicy: ContextCompactionPolicy = DEFAULT_CONTEXT_COMPACTION_POLICY,
): ContextCompactionDecision {
  const evaluation = evaluateContextPressure(snapshot, limitPolicy, {
    mediumRatio: compactionPolicy.triggerRatio,
    highRatio: compactionPolicy.triggerRatio,
    criticalRatio: compactionPolicy.triggerRatio,
  })
  const minInputTokens = compactionPolicy.minInputTokens ?? 0
  if (evaluation.usedTokens < minInputTokens) {
    return { shouldCompact: false, reason: 'insufficient_usage', ratio: evaluation.ratio, usedTokens: evaluation.usedTokens, limitTokens: evaluation.limitTokens }
  }
  if (evaluation.ratio === null || evaluation.limitTokens === null) {
    return { shouldCompact: false, reason: 'unknown_limit', ratio: null, usedTokens: evaluation.usedTokens, limitTokens: null }
  }
  if (evaluation.ratio >= compactionPolicy.triggerRatio) {
    return { shouldCompact: true, reason: 'ratio_exceeded', ratio: evaluation.ratio, usedTokens: evaluation.usedTokens, limitTokens: evaluation.limitTokens }
  }
  return { shouldCompact: false, reason: 'below_threshold', ratio: evaluation.ratio, usedTokens: evaluation.usedTokens, limitTokens: evaluation.limitTokens }
}


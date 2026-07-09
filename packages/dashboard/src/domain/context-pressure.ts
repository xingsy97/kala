import type { AgentConfig } from '@agent-kernel/kernel'
import type { ContextUsageSnapshot } from '@agent-kernel/shared/context-usage'
import {
  evaluateContextPressure,
  type ContextPressureEvaluation,
  type ContextPressureLevel,
} from '@agent-kernel/shared/context-policy'

export type DashboardContextPressure = ContextPressureEvaluation & {
  percent: number | null
  tone: 'ok' | 'warn' | 'error' | 'neutral'
  sourceLabel: ContextUsageSnapshot['contextWindow']['source'] | 'model_registry' | 'manual_config' | 'unknown'
}

export function evaluateDashboardContextPressure(input: {
  snapshot: ContextUsageSnapshot | null | undefined
  config?: Pick<AgentConfig, 'contextLimit' | 'softThreshold' | 'hardThreshold'> | null
  fallbackModelContextWindow?: number | null
}): DashboardContextPressure {
  const fallbackTokens = input.fallbackModelContextWindow ?? input.config?.contextLimit
  const evaluation = evaluateContextPressure(
    input.snapshot,
    fallbackTokens ? { unknownModelFallbackTokens: fallbackTokens } : {},
    {
      mediumRatio: 0.6,
      highRatio: input.config?.softThreshold ?? 0.75,
      criticalRatio: input.config?.hardThreshold ?? 0.92,
    },
  )
  return {
    ...evaluation,
    percent: evaluation.ratio !== null ? Math.round(evaluation.ratio * 100) : null,
    tone: toneForContextPressure(evaluation.level),
    sourceLabel: input.snapshot?.contextWindow.source ?? (input.fallbackModelContextWindow ? 'model_registry' : input.config?.contextLimit ? 'manual_config' : 'unknown'),
  }
}

export function contextPressureLabel(pressure: Pick<DashboardContextPressure, 'level' | 'percent'>): string {
  return pressure.percent === null ? pressure.level : `${pressure.level} · ${pressure.percent}%`
}

export function toneForContextPressure(level: ContextPressureLevel): DashboardContextPressure['tone'] {
  if (level === 'unknown') return 'neutral'
  if (level === 'critical') return 'error'
  if (level === 'high' || level === 'medium') return 'warn'
  return 'ok'
}

import { describe, expect, it } from 'vitest'

import type { ContextUsageSnapshot } from '@agent-kernel/shared/context-usage'

import { contextPressureLabel, evaluateDashboardContextPressure, toneForContextPressure } from './context-pressure.js'

function snapshot(inputTokens: number, contextWindow: number | null = 1_000): ContextUsageSnapshot {
  return {
    model: { ref: 'test-model' },
    contextWindow: { tokens: contextWindow, source: contextWindow ? 'model_registry' : 'unknown' },
    usage: { inputTokens, totalTokens: inputTokens },
    breakdown: { system: 0, transcript: inputTokens, tools: 0, memory: 0, attachments: 0, pendingUserInput: 0 },
    estimator: {
      total: { kind: 'heuristic', confidence: 'rough' },
      breakdown: { kind: 'heuristic', confidence: 'rough' },
      version: 'test',
    },
    updatedAt: 0,
  }
}

describe('dashboard context pressure policy', () => {
  it('uses app thresholds and returns display percent/tone', () => {
    const pressure = evaluateDashboardContextPressure({
      snapshot: snapshot(820),
      config: { softThreshold: 0.8, hardThreshold: 0.92 },
    })

    expect(pressure.level).toBe('high')
    expect(pressure.percent).toBe(82)
    expect(pressure.tone).toBe('warn')
    expect(contextPressureLabel(pressure)).toBe('high · 82%')
  })

  it('uses fallback limits without mutating snapshot semantics', () => {
    const pressure = evaluateDashboardContextPressure({
      snapshot: snapshot(500, null),
      fallbackModelContextWindow: 1_000,
    })

    expect(pressure.limitTokens).toBe(1_000)
    expect(pressure.limitSource).toBe('policy_fallback')
    expect(pressure.sourceLabel).toBe('unknown')
  })

  it('maps pressure levels to dashboard tones', () => {
    expect(toneForContextPressure('unknown')).toBe('neutral')
    expect(toneForContextPressure('low')).toBe('ok')
    expect(toneForContextPressure('medium')).toBe('warn')
    expect(toneForContextPressure('high')).toBe('warn')
    expect(toneForContextPressure('critical')).toBe('error')
  })
})

/**
 * Session profile: per-run aggregated latency, cost, and usage. Derived from
 * the event log plus an optional pricing table. The reducer stays free of
 * pricing concepts.
 */

import type { AgentConfig } from '@agent-kernel/kernel'

import type { EventEntry, HeaderEntry } from './log.js'
import { compactRecord } from './trace-spans.js'

export type PricingTable = {
  version: string
  currency: 'USD'
  models: Record<string, {
    inputPerMillion?: number
    outputPerMillion?: number
    cacheReadPerMillion?: number
    cacheCreationPerMillion?: number
  }>
}

export type SessionProfile = {
  sessionId: string
  eventCount: number
  llmCalls: number
  toolCalls: number
  toolErrors: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  estimatedCostUsd?: number
  costStatus: 'estimated' | 'unknown'
  models: readonly string[]
  missingUsageCalls: number
  llmTraceMissingCalls: number
  llmLatencyCalls: number
  averageLlmDurationMs?: number
  p95LlmDurationMs?: number
  averageTimeToFirstChunkMs?: number
  p95TimeToFirstChunkMs?: number
  wallTimeMs?: number
  firstEventAt?: string
  lastEventAt?: string
}

export const DEFAULT_PRICING_TABLE: PricingTable = {
  version: '2026-07-default-placeholder',
  currency: 'USD',
  models: {},
}

export function createSessionProfile(input: {
  header: HeaderEntry
  events: readonly EventEntry[]
  pricing?: PricingTable
}): SessionProfile {
  const pricing = input.pricing ?? DEFAULT_PRICING_TABLE
  const models = new Set<string>()
  let llmCalls = 0
  let toolCalls = 0
  let toolErrors = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let missingUsageCalls = 0
  let llmTraceMissingCalls = 0
  let estimatedCostUsd = 0
  let unknownCost = false
  const llmDurations: number[] = []
  const ttfts: number[] = []
  for (const entry of input.events) {
    for (const effect of entry.effects) {
      if (effect.kind === 'call_tool') toolCalls += 1
    }
    if (entry.event.kind === 'tool_result' && entry.event.ok === false) toolErrors += 1
    if (entry.event.kind !== 'llm_response' && entry.event.kind !== 'llm_error') continue
    llmCalls += 1
    if (entry.model) models.add(entry.model)
    else if (entry.llmTrace?.model) models.add(entry.llmTrace.model)
    if (!entry.llmTrace) llmTraceMissingCalls += 1
    const metrics = entry.llmTrace?.response?.metrics
    if (typeof metrics?.durationMs === 'number' && Number.isFinite(metrics.durationMs)) {
      llmDurations.push(metrics.durationMs)
    }
    if (typeof metrics?.timeToFirstChunkMs === 'number' && Number.isFinite(metrics.timeToFirstChunkMs)) {
      ttfts.push(metrics.timeToFirstChunkMs)
    }
    if (!entry.usage) {
      missingUsageCalls += 1
      unknownCost = true
      continue
    }
    totalInputTokens += entry.usage.inputTokens
    totalOutputTokens += entry.usage.outputTokens
    totalCacheReadTokens += entry.usage.cacheReadTokens
    totalCacheCreationTokens += entry.usage.cacheCreationTokens
    const model = entry.model ?? entry.llmTrace?.model
    const price = model ? pricing.models[model] : undefined
    if (!price) {
      unknownCost = true
      continue
    }
    estimatedCostUsd += priceForTokens(entry.usage.inputTokens, price.inputPerMillion)
    estimatedCostUsd += priceForTokens(entry.usage.outputTokens, price.outputPerMillion)
    estimatedCostUsd += priceForTokens(entry.usage.cacheReadTokens, price.cacheReadPerMillion)
    estimatedCostUsd += priceForTokens(entry.usage.cacheCreationTokens, price.cacheCreationPerMillion)
  }
  const firstEventAt = input.events[0]?.ts
  const lastEventAt = input.events[input.events.length - 1]?.ts
  const wallTimeMs = firstEventAt && lastEventAt
    ? Math.max(0, Date.parse(lastEventAt) - Date.parse(firstEventAt))
    : undefined
  return {
    sessionId: input.header.sessionId,
    eventCount: input.events.length,
    llmCalls,
    toolCalls,
    toolErrors,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    ...(unknownCost ? {} : { estimatedCostUsd: roundCost(estimatedCostUsd) }),
    costStatus: unknownCost ? 'unknown' : 'estimated',
    models: [...models].sort(),
    missingUsageCalls,
    llmTraceMissingCalls,
    llmLatencyCalls: llmDurations.length,
    ...(llmDurations.length > 0 ? {
      averageLlmDurationMs: average(llmDurations),
      p95LlmDurationMs: percentile(llmDurations, 0.95),
    } : {}),
    ...(ttfts.length > 0 ? {
      averageTimeToFirstChunkMs: average(ttfts),
      p95TimeToFirstChunkMs: percentile(ttfts, 0.95),
    } : {}),
    ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
    ...(firstEventAt ? { firstEventAt } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
  }
}

function average(values: readonly number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length))
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return Math.round(sorted[index]!)
}

function priceForTokens(tokens: number, perMillion: number | undefined): number {
  return perMillion === undefined ? 0 : (tokens / 1_000_000) * perMillion
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function describeAgentConfig(config: AgentConfig): Record<string, unknown> {
  return compactRecord({
    toolCount: config.tools.length,
    toolNames: config.tools.map((tool) => tool.name),
    contextLimit: config.contextLimit,
    softThreshold: config.softThreshold,
    hardThreshold: config.hardThreshold,
    maxAgentDepth: config.maxAgentDepth,
    maxAgentFanOut: config.maxAgentFanOut,
    thinkingBudget: config.thinkingBudget,
  })
}

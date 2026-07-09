import type { AgentConfig, Message } from '@agent-kernel/kernel'
import { estimateMessageTokens } from '@agent-kernel/kernel'

import type { SessionRecord } from '../store/session.js'

export type ContextPressureLevel = 'none' | 'soft' | 'hard'

export type ContextSnapshot = {
  estimatedMessageTokens: number
  estimatedToolSchemaTokens: number
  estimatedTotalInputTokens: number
  reserveTokens: number
  effectiveLimit?: number
  contextWindow?: number
  contextTokens?: number
  contextWindowSource?: 'model' | 'session-config' | 'unknown'
  contextWindowModel?: string
  pressureLevel: ContextPressureLevel
  reasonCodes: string[]
}

export type ContextWindowOverride = {
  model?: string
  contextWindow?: number
  contextTokens?: number
}

const DEFAULT_SOFT_THRESHOLD = 0.75
const DEFAULT_HARD_THRESHOLD = 0.92
const DEFAULT_RESERVE_TOKENS = 4_000

export function contextSnapshot(
  record: SessionRecord,
  messages: readonly Message[] = record.state.messages,
  override?: ContextWindowOverride,
): ContextSnapshot {
  return snapshotFromConfig(record.config, messages, override)
}

export function snapshotFromConfig(
  config: AgentConfig,
  messages: readonly Message[],
  override?: ContextWindowOverride,
): ContextSnapshot {
  const estimatedMessageTokens = estimateMessageTokens(messages)
  const estimatedToolSchemaTokens = estimateToolSchemaTokens(config.tools)
  const contextWindow = positiveInt(override?.contextWindow)
  const contextTokens = positiveInt(override?.contextTokens)
  const configLimit = positiveInt(config.contextLimit)
  const effectiveLimit = contextTokens ?? contextWindow ?? configLimit
  const contextWindowSource = contextWindow
    ? 'model'
    : configLimit
      ? 'session-config'
      : 'unknown'
  const reserveTokens = effectiveLimit ? Math.min(DEFAULT_RESERVE_TOKENS, Math.floor(effectiveLimit * 0.1)) : DEFAULT_RESERVE_TOKENS
  const estimatedTotalInputTokens = estimatedMessageTokens + estimatedToolSchemaTokens + reserveTokens
  const reasonCodes: string[] = []
  if (!effectiveLimit) reasonCodes.push('context_limit_unknown')
  const pressureLevel = effectiveLimit
    ? derivePressure(estimatedTotalInputTokens, effectiveLimit, config.softThreshold, config.hardThreshold)
    : 'none'
  if (pressureLevel !== 'none') reasonCodes.push(`pressure_${pressureLevel}`)
  return {
    estimatedMessageTokens,
    estimatedToolSchemaTokens,
    estimatedTotalInputTokens,
    reserveTokens,
    ...(effectiveLimit !== undefined ? { effectiveLimit } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    contextWindowSource,
    ...(override?.model ? { contextWindowModel: override.model } : {}),
    pressureLevel,
    reasonCodes,
  }
}

export function shouldAutoCompact(record: SessionRecord, override?: ContextWindowOverride): boolean {
  return contextSnapshot(record, record.state.messages, override).pressureLevel === 'hard'
}

function positiveInt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const int = Math.floor(value)
  return int > 0 ? int : undefined
}

function derivePressure(
  total: number,
  limit: number,
  softThreshold = DEFAULT_SOFT_THRESHOLD,
  hardThreshold = DEFAULT_HARD_THRESHOLD,
): ContextPressureLevel {
  if (total >= limit * hardThreshold) return 'hard'
  if (total >= limit * softThreshold) return 'soft'
  return 'none'
}

function estimateToolSchemaTokens(tools: AgentConfig['tools']): number {
  if (tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / 4)
}

import type { AgentConfig, Message } from '@agent-kernel/kernel'
import type { ContextUsageSnapshot } from '@agent-kernel/shared/context-usage'
import { shouldCompactContext } from '@agent-kernel/shared/context-policy'
import { estimateMessageTokens, estimateToolSchemaTokens } from '@agent-kernel/shared/token-estimation'

import type { SessionRecord } from '../store/session.js'

export type ContextWindowOverride = {
  /** Canonical model ref, e.g. `provider-id:model-id`. */
  model?: string
  /** Provider-native model id, without the provider prefix. */
  modelId?: string
  provider?: string
  contextWindow?: number
  contextTokens?: number
}

const ESTIMATOR_VERSION = 'heuristic-v1'
const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384

export function contextSnapshot(
  record: SessionRecord,
  messages: readonly Message[] = record.state.messages,
  override?: ContextWindowOverride,
): ContextUsageSnapshot {
  return snapshotFromConfig(record.config, messages, override, record.preferences?.selectedModel)
}

export function snapshotFromConfig(
  config: AgentConfig,
  messages: readonly Message[],
  override?: ContextWindowOverride,
  selectedModel?: string,
): ContextUsageSnapshot {
  const transcriptTokens = estimateMessageTokens(messages)
  const toolTokens = estimateToolSchemaTokens(config.tools)
  const reserveTokens = reserveForContext(override?.contextTokens ?? override?.contextWindow ?? config.contextLimit)
  const inputTokens = transcriptTokens + toolTokens + reserveTokens
  const contextWindow = contextWindowFrom(config, override)
  const modelRef = selectedModel ?? override?.model ?? 'unknown'
  return {
    model: {
      ref: modelRef,
      ...(override?.provider ? { provider: override.provider } : {}),
      ...(override?.modelId ?? override?.model ? { id: override?.modelId ?? override?.model } : {}),
    },
    contextWindow,
    usage: {
      inputTokens,
      totalTokens: inputTokens,
    },
    breakdown: {
      system: reserveTokens,
      transcript: transcriptTokens,
      tools: toolTokens,
      memory: 0,
      attachments: 0,
      pendingUserInput: 0,
    },
    estimator: {
      total: { kind: 'heuristic', confidence: 'rough' },
      breakdown: { kind: 'heuristic', confidence: 'rough' },
      version: ESTIMATOR_VERSION,
    },
    updatedAt: Date.now(),
  }
}

export function shouldAutoCompact(record: SessionRecord, override?: ContextWindowOverride): boolean {
  const snapshot = contextSnapshot(record, record.state.messages, override)
  return shouldCompactContext(snapshot, {}, { triggerRatio: record.config.hardThreshold ?? 0.92 }).shouldCompact
}

function contextWindowFrom(config: AgentConfig, override?: ContextWindowOverride): ContextUsageSnapshot['contextWindow'] {
  const userWindow = positiveInt(override?.contextTokens)
  if (userWindow !== undefined) return { tokens: userWindow, source: 'manual_config' }
  const modelWindow = positiveInt(override?.contextWindow)
  if (modelWindow !== undefined) return { tokens: modelWindow, source: 'model_registry' }
  const configLimit = positiveInt(config.contextLimit)
  if (configLimit !== undefined) return { tokens: configLimit, source: 'manual_config' }
  return { tokens: null, source: 'unknown' }
}

function reserveForContext(limit: number | undefined): number {
  const positive = positiveInt(limit)
  if (!positive) return DEFAULT_COMPACTION_RESERVE_TOKENS
  return Math.min(DEFAULT_COMPACTION_RESERVE_TOKENS, Math.floor(positive * 0.1))
}

function positiveInt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const int = Math.floor(value)
  return int > 0 ? int : undefined
}

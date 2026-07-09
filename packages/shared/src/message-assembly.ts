/**
 * Message assembly artifact: a per-turn breakdown of what actually gets sent
 * to the model. The dashboard uses this to explain "why is my context so
 * big?" without having to re-derive it from the raw ledger.
 */

import type { Message, ToolSchema } from '@agent-kernel/kernel'

import type { ArtifactRef } from './artifact-store.js'
import { estimateMessageTokens, estimateStringTokens, estimateToolSchemaTokens } from './token-estimation.js'

export type MessageAssemblyStage = {
  name: string
  inputMessages: number
  outputMessages: number
  estimatedTokens?: number
  droppedItems?: number
  reasonCodes: readonly string[]
  artifactRefs: readonly ArtifactRef[]
}

export type MessageAssemblyPartName =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'tools'
  | 'images'
  | 'thinking'
  | 'memory'

export type MessageAssemblyBudgetPartitionName =
  | 'fixed_instructions'
  | 'tool_schemas'
  | 'active_turn'
  | 'recent_tail'
  | 'retrieved_memory'
  | 'output_reserve'
  | 'compaction_reserve'

export type MessageAssemblyBudgetPartition = {
  name: MessageAssemblyBudgetPartitionName
  estimatedTokens: number
  budgetTokens?: number
  utilization?: number
  overBudget?: boolean
  reasonCodes: readonly string[]
}

export type MessageAssemblyBudget = {
  contextLimit?: number
  outputReserveTokens: number
  compactionReserveTokens: number
  totalEstimatedTokens: number
  availableTokens?: number
  utilization?: number
  overBudget: boolean
  reasonCodes: readonly string[]
  partitions: readonly MessageAssemblyBudgetPartition[]
}

export type MessageAssemblyArtifact = {
  sessionId: string
  eventSeq?: number
  provider?: string
  model?: string
  messageCount: number
  toolCount: number
  estimatedTokens: number
  parts: Array<{
    name: MessageAssemblyPartName
    messages: number
    chars: number
    estimatedTokens: number
  }>
  stages: readonly MessageAssemblyStage[]
  budget?: MessageAssemblyBudget
}

export type MessageAssemblyBudgetInput = {
  contextLimit?: number
  outputReserveTokens?: number
  compactionReserveTokens?: number
}

const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384
const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384

export function createMessageAssemblyArtifact(input: {
  sessionId: string
  eventSeq?: number
  provider?: string
  model?: string
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  stages?: readonly MessageAssemblyStage[]
  budget?: MessageAssemblyBudgetInput
}): MessageAssemblyArtifact {
  const buckets = new Map<MessageAssemblyPartName, { messages: number; chars: number; estimatedTokens: number }>()
  const memoryCallIds = new Set<string>()
  for (const message of input.messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call' && content.name === 'memory') memoryCallIds.add(content.callId)
    }
  }
  for (const message of input.messages) {
    const existing = buckets.get(message.role) ?? { messages: 0, chars: 0, estimatedTokens: 0 }
    existing.messages += 1
    existing.chars += estimateMessageChars([message])
    existing.estimatedTokens += estimateMessageTokens([message])
    buckets.set(message.role, existing)
    for (const content of message.content) {
      const key = content.type === 'image' ? 'images' : content.type === 'thinking' ? 'thinking' : undefined
      if (!key) continue
      const bucket = buckets.get(key) ?? { messages: 0, chars: 0, estimatedTokens: 0 }
      const chars = estimateContentChars(content)
      bucket.chars += chars
      bucket.estimatedTokens += estimateContentTokens(content)
      buckets.set(key, bucket)
    }
    const memoryChars = estimateMemoryContributionChars(message, memoryCallIds)
    if (memoryChars > 0) {
      const bucket = buckets.get('memory') ?? { messages: 0, chars: 0, estimatedTokens: 0 }
      bucket.messages += 1
      bucket.chars += memoryChars
      bucket.estimatedTokens += estimateMemoryContributionTokens(message, memoryCallIds)
      buckets.set('memory', bucket)
    }
  }
  const toolSchemaChars = JSON.stringify(input.tools).length
  buckets.set('tools', { messages: 0, chars: toolSchemaChars, estimatedTokens: estimateToolSchemaTokens(input.tools) })
  const parts = [...buckets.entries()]
    .filter(([, value]) => value.messages > 0 || value.chars > 0)
    .map(([name, value]) => ({
      name,
      messages: value.messages,
      chars: value.chars,
      estimatedTokens: value.estimatedTokens,
    }))
  const estimatedTokens = estimateMessageTokens(input.messages) + estimateToolSchemaTokens(input.tools)
  const budget = createBudget({
    messages: input.messages,
    tools: input.tools,
    memoryCallIds,
    input: input.budget,
    totalEstimatedInputTokens: estimatedTokens,
  })
  return {
    sessionId: input.sessionId,
    ...(input.eventSeq !== undefined ? { eventSeq: input.eventSeq } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    messageCount: input.messages.length,
    toolCount: input.tools.length,
    estimatedTokens,
    parts,
    stages: input.stages ?? [],
    ...(budget ? { budget } : {}),
  }
}

function createBudget(args: {
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  memoryCallIds: ReadonlySet<string>
  input: MessageAssemblyBudgetInput | undefined
  totalEstimatedInputTokens: number
}): MessageAssemblyBudget | undefined {
  if (!args.input && args.messages.length === 0 && args.tools.length === 0) return undefined
  const outputReserveTokens = args.input?.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS
  const compactionReserveTokens = args.input?.compactionReserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS
  const contextLimit = args.input?.contextLimit
  const partitions = createBudgetPartitions({
    messages: args.messages,
    tools: args.tools,
    memoryCallIds: args.memoryCallIds,
    outputReserveTokens,
    compactionReserveTokens,
    contextLimit,
  })
  const totalPartitionTokens = partitions.reduce((sum, p) => sum + p.estimatedTokens, 0)
  const availableTokens = contextLimit !== undefined
    ? Math.max(0, contextLimit - outputReserveTokens - compactionReserveTokens)
    : undefined
  const utilization = availableTokens !== undefined && availableTokens > 0
    ? args.totalEstimatedInputTokens / availableTokens
    : availableTokens === 0 && args.totalEstimatedInputTokens > 0
      ? Infinity
      : undefined
  const overBudget = utilization !== undefined && utilization > 1
  const reasonCodes: string[] = []
  if (contextLimit === undefined) reasonCodes.push('context_limit_unknown')
  if (overBudget) reasonCodes.push('over_budget')
  if (utilization !== undefined && !overBudget && utilization > 0.85) reasonCodes.push('near_budget')
  if (partitions.some((p) => p.name === 'active_turn' && p.estimatedTokens === 0)) reasonCodes.push('active_turn_missing')
  if (partitions.some((p) => p.name === 'retrieved_memory' && p.estimatedTokens > 0)) reasonCodes.push('memory_present')
  return {
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    outputReserveTokens,
    compactionReserveTokens,
    totalEstimatedTokens: totalPartitionTokens,
    ...(availableTokens !== undefined ? { availableTokens } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    overBudget,
    reasonCodes,
    partitions,
  }
}

function createBudgetPartitions(args: {
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  memoryCallIds: ReadonlySet<string>
  outputReserveTokens: number
  compactionReserveTokens: number
  contextLimit?: number
}): readonly MessageAssemblyBudgetPartition[] {
  const systemMessages = args.messages.filter((m) => m.role === 'system')
  const nonSystem = args.messages.filter((m) => m.role !== 'system')
  const activeTurnStart = findActiveTurnStart(nonSystem)
  const activeTurn = activeTurnStart >= 0 ? nonSystem.slice(activeTurnStart) : []
  const recentTail = activeTurnStart >= 0 ? nonSystem.slice(0, activeTurnStart) : nonSystem
  const memoryTokens = estimateMemoryTokensFromMessages(args.messages, args.memoryCallIds)
  const fixedInstructionTokens = estimateMessageTokens(systemMessages)
  const toolSchemaTokens = estimateToolSchemaTokens(args.tools)
  const activeTurnTokens = estimateMessageTokens(activeTurn)
  const recentTailTokens = Math.max(0, estimateMessageTokens(recentTail) - memoryTokens)
  return [
    partition('fixed_instructions', fixedInstructionTokens, args.contextLimit, systemMessages.length > 0 ? ['system_prompt_present'] : ['system_prompt_absent']),
    partition('tool_schemas', toolSchemaTokens, args.contextLimit, args.tools.length > 0 ? ['tool_registry_present'] : ['tool_registry_empty']),
    partition('active_turn', activeTurnTokens, args.contextLimit, activeTurnTokens > 0 ? ['active_turn_present'] : ['active_turn_missing']),
    partition('recent_tail', recentTailTokens, args.contextLimit, recentTailTokens > 0 ? ['recent_tail_present'] : ['recent_tail_empty']),
    partition('retrieved_memory', memoryTokens, args.contextLimit, memoryTokens > 0 ? ['memory_tool_context_present'] : ['memory_tool_context_absent']),
    partition('output_reserve', args.outputReserveTokens, args.contextLimit, ['reserved_for_model_output']),
    partition('compaction_reserve', args.compactionReserveTokens, args.contextLimit, ['reserved_for_compaction']),
  ]
}

function partition(
  name: MessageAssemblyBudgetPartitionName,
  estimatedTokens: number,
  contextLimit: number | undefined,
  baseReasons: readonly string[],
): MessageAssemblyBudgetPartition {
  const budgetTokens = contextLimit !== undefined ? contextLimit : undefined
  const utilization = budgetTokens !== undefined && budgetTokens > 0 ? estimatedTokens / budgetTokens : undefined
  const overBudget = utilization !== undefined && utilization > 1
  return {
    name,
    estimatedTokens,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    ...(overBudget ? { overBudget: true } : {}),
    reasonCodes: overBudget ? [...baseReasons, 'partition_over_budget'] : baseReasons,
  }
}

function findActiveTurnStart(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return i
  }
  return -1
}

function estimateMemoryTokensFromMessages(
  messages: readonly Message[],
  memoryCallIds: ReadonlySet<string>,
): number {
  let tokens = 0
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call' && content.name === 'memory') tokens += estimateContentTokens(content)
      if (content.type === 'tool_result' && memoryCallIds.has(content.callId)) tokens += estimateContentTokens(content)
    }
  }
  return tokens
}

function estimateMemoryContributionChars(message: Message, memoryCallIds: ReadonlySet<string>): number {
  let chars = 0
  for (const content of message.content) {
    if (content.type === 'tool_call' && content.name === 'memory') chars += estimateContentChars(content)
    if (content.type === 'tool_result' && memoryCallIds.has(content.callId)) chars += estimateContentChars(content)
  }
  return chars
}

function estimateMemoryContributionTokens(message: Message, memoryCallIds: ReadonlySet<string>): number {
  let tokens = 0
  for (const content of message.content) {
    if (content.type === 'tool_call' && content.name === 'memory') tokens += estimateContentTokens(content)
    if (content.type === 'tool_result' && memoryCallIds.has(content.callId)) tokens += estimateContentTokens(content)
  }
  return tokens
}

function estimateMessageChars(messages: readonly Message[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.role.length + 8
    for (const content of message.content) chars += estimateContentChars(content)
  }
  return chars
}

function estimateContentChars(content: Message['content'][number]): number {
  if (content.type === 'text' || content.type === 'thinking') return content.text.length
  if (content.type === 'tool_call') return content.name.length + content.callId.length + JSON.stringify(content.input).length
  if (content.type === 'tool_result') return content.callId.length + content.content.length + 16
  return content.source.kind === 'file_ref'
    ? content.source.path.length + 64
    : Math.round(content.source.data.length / 4)
}

function estimateContentTokens(content: Message['content'][number]): number {
  if (content.type === 'text' || content.type === 'thinking') return estimateStringTokens(content.text) + 4
  if (content.type === 'tool_call') {
    return estimateStringTokens(content.name) + estimateStringTokens(content.callId) + estimateStringTokens(JSON.stringify(content.input)) + 16
  }
  if (content.type === 'tool_result') return estimateStringTokens(content.callId) + estimateStringTokens(content.content) + 16
  if (content.source.kind === 'file_ref') return estimateStringTokens(content.source.path) + 32
  return Math.ceil(content.source.data.length / 3) + 32
}

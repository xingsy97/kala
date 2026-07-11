import type {
  AgentEvent,
  CallLlmEffect,
  Message,
} from '@agent-kernel/kernel'
import type { LLMTrace } from '@agent-kernel/shared'

import type { TimelineEntry } from '../../session.js'

export type ContextProportionKind = 'system' | 'user' | 'assistant' | 'tool' | 'tools' | 'attachments' | 'other'

export type ContextProportion = {
  kind: ContextProportionKind
  label: string
  bytes: number
  percent: number
  displayPercent: string
  color: string
}

export type LlmCall = {
  id: string
  source: 'turn' | 'compact'
  requestSeq: number
  responseSeq?: number
  effect: CallLlmEffect
  response?: Extract<AgentEvent, { kind: 'llm_response' }>
  error?: Extract<AgentEvent, { kind: 'llm_error' }>
  compact?: Extract<AgentEvent, { kind: 'compact_replaced' }>
  trace?: LLMTrace
  model?: string
}

export function buildLlmCalls(timeline: readonly TimelineEntry[]): readonly LlmCall[] {
  const calls: LlmCall[] = []
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i]!
    if (entry.event.kind === 'compact_replaced' && entry.event.request) {
      calls.push({
        id: `compact-llm-${entry.seq}`,
        source: 'compact',
        requestSeq: entry.seq,
        responseSeq: entry.seq,
        effect: {
          kind: 'call_llm',
          messages: entry.event.request.messages,
          tools: entry.event.request.tools ?? [],
        },
        compact: entry.event,
        ...(entry.llmTrace ? { trace: entry.llmTrace } : {}),
        ...(entry.model ?? entry.event.request.model ? { model: entry.model ?? entry.event.request.model } : {}),
      })
    }
    for (const effect of entry.effects) {
      if (effect.kind !== 'call_llm') continue
      const call: LlmCall = {
        id: `llm-${entry.seq}-${calls.length}`,
        source: 'turn',
        requestSeq: entry.seq,
        effect,
      }
      for (let j = i + 1; j < timeline.length; j++) {
        const candidate = timeline[j]!
        if (candidate.event.kind === 'llm_response') {
          call.responseSeq = candidate.seq
          call.response = candidate.event
          if (candidate.llmTrace) call.trace = candidate.llmTrace
          if (candidate.model) call.model = candidate.model
          break
        }
        if (candidate.event.kind === 'llm_error') {
          call.responseSeq = candidate.seq
          call.error = candidate.event
          if (candidate.llmTrace) call.trace = candidate.llmTrace
          if (candidate.model) call.model = candidate.model
          break
        }
      }
      calls.push(call)
    }
  }
  return calls
}

export function latestTurnLlmCall(timeline: readonly TimelineEntry[]): LlmCall | null {
  return buildLlmCalls(timeline).filter((call) => call.source === 'turn').at(-1) ?? null
}

export function contextProportions(call: LlmCall): readonly ContextProportion[] {
  const systemBytes = serializedSize(systemContextFromCall(call))
  const messageBytes = new Map<ContextProportionKind, number>()
  for (const message of call.effect.messages) {
    const kind = messageContextKind(message)
    messageBytes.set(kind, (messageBytes.get(kind) ?? 0) + serializedSize(message))
  }
  const toolBytes = serializedSize(call.effect.tools)
  const userBytes = messageBytes.get('user') ?? 0
  const assistantBytes = messageBytes.get('assistant') ?? 0
  const toolMessageBytes = messageBytes.get('tool') ?? 0
  const attachmentBytes = messageBytes.get('attachments') ?? 0
  const otherBytes = messageBytes.get('other') ?? 0
  const total = Math.max(1, systemBytes + userBytes + assistantBytes + toolMessageBytes + attachmentBytes + otherBytes + toolBytes)
  const percentOf = (bytes: number): number => {
    if (bytes <= 0) return 0
    return Math.max(1, Math.round((bytes / total) * 100))
  }
  const displayPercentOf = (bytes: number): string => {
    if (bytes <= 0) return '0%'
    const exact = (bytes / total) * 100
    return exact < 1 ? '<1%' : `${Math.round(exact)}%`
  }
  return [
    { kind: 'system', label: 'System', bytes: systemBytes, percent: percentOf(systemBytes), displayPercent: displayPercentOf(systemBytes), color: 'bg-amber-500' },
    { kind: 'user', label: 'User', bytes: userBytes, percent: percentOf(userBytes), displayPercent: displayPercentOf(userBytes), color: 'bg-sky-500' },
    { kind: 'assistant', label: 'Assistant', bytes: assistantBytes, percent: percentOf(assistantBytes), displayPercent: displayPercentOf(assistantBytes), color: 'bg-violet-500' },
    { kind: 'tool', label: 'Tool results', bytes: toolMessageBytes, percent: percentOf(toolMessageBytes), displayPercent: displayPercentOf(toolMessageBytes), color: 'bg-emerald-500' },
    { kind: 'tools', label: 'Tool registry', bytes: toolBytes, percent: percentOf(toolBytes), displayPercent: displayPercentOf(toolBytes), color: 'bg-teal-500' },
    { kind: 'attachments', label: 'Attachments', bytes: attachmentBytes, percent: percentOf(attachmentBytes), displayPercent: displayPercentOf(attachmentBytes), color: 'bg-fuchsia-500' },
    { kind: 'other', label: 'Other', bytes: otherBytes, percent: percentOf(otherBytes), displayPercent: displayPercentOf(otherBytes), color: 'bg-slate-500' },
  ]
}

export function contextBreakdownForSessionInfo(call: LlmCall | null): {
  systemInstructions: string
  toolDefinitions: string
  messages: string
  toolResults: string
} {
  if (!call) {
    return { systemInstructions: '—', toolDefinitions: '—', messages: '—', toolResults: '—' }
  }
  const byKind = new Map(contextProportions(call).map((item) => [item.kind, item]))
  const messageItems = ['user', 'assistant', 'attachments', 'other'] as const
  const messageBytes = messageItems.reduce((sum, kind) => sum + (byKind.get(kind)?.bytes ?? 0), 0)
  const totalBytes = contextProportions(call).reduce((sum, item) => sum + item.bytes, 0)
  const displayPercentOf = (bytes: number): string => {
    if (bytes <= 0 || totalBytes <= 0) return '0%'
    const exact = (bytes / totalBytes) * 100
    return exact < 1 ? '<1%' : `${Math.round(exact)}%`
  }
  return {
    systemInstructions: byKind.get('system')?.displayPercent ?? '0%',
    toolDefinitions: byKind.get('tools')?.displayPercent ?? '0%',
    messages: displayPercentOf(messageBytes),
    toolResults: byKind.get('tool')?.displayPercent ?? '0%',
  }
}

export function messageContextKind(message: Message): ContextProportionKind {
  if (message.content.some((block) => block.type === 'image')) return 'attachments'
  if (message.role === 'system') return 'system'
  if (message.role === 'user') return 'user'
  if (message.role === 'assistant') return 'assistant'
  if (message.role === 'tool') return 'tool'
  return 'other'
}

function systemContextFromCall(call: LlmCall): unknown {
  if (call.trace && providerBodyHasKey(call.trace.request.body, 'system')) {
    return (call.trace.request.body as Record<string, unknown>).system
  }
  return call.effect.messages.filter((message) => message.role === 'system')
}

function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

export function providerBodyHasKey(body: unknown, key: string): boolean {
  return typeof body === 'object' && body !== null && key in body
}

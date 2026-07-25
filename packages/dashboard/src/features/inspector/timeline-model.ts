import type { AgentEvent, Effect, Message, MessageContent, CallLlmEffect } from '@agent-kernel/kernel'

import type { ServerLogArtifactPayload } from '@agent-kernel/shared'
import type { TimelineEntry } from '../../session.js'
import type { StateFlowStep } from '../../state-flow.js'
import { compactCardSummary, compactNameCounts, summarizeTextForCard } from './presentation.js'
import { TRACE_CATEGORY_ORDER, type PriorCallLlm, type ToolCallLifecycle, type TraceCategory } from './trace-types.js'

/** Pure timeline/event analysis + content summaries for the inspector. */

export function inboundOf(event: AgentEvent): { source: string; tone: string } {
  switch (event.kind) {
    case 'user_message':
    case 'user_approve':
    case 'approval_mode_changed':
    case 'cwd_changed':
      return { source: 'user', tone: 'text-sky-600 dark:text-sky-300' }
    case 'llm_response':
      return { source: 'llm', tone: 'text-violet-600 dark:text-violet-300' }
    case 'llm_error':
      return { source: 'llm', tone: 'text-rose-600 dark:text-rose-300' }
    case 'user_reject':
      return { source: 'user', tone: 'text-rose-600 dark:text-rose-300' }
    case 'tool_result':
      return { source: 'executor', tone: event.ok ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300' }
    case 'cancel':
    case 'clear':
      return { source: 'user', tone: 'text-amber-600 dark:text-amber-300' }
    case 'messages_replaced':
      return { source: 'host', tone: 'text-amber-600 dark:text-amber-300' }
  }
}

export function effectTarget(e: Effect): { target: string; tone: string } {
  switch (e.kind) {
    case 'call_llm':
      return { target: 'llm', tone: 'text-violet-600 dark:text-violet-300' }
    case 'call_tool':
      return { target: 'executor', tone: 'text-emerald-600 dark:text-emerald-300' }
    case 'request_approval':
      return { target: 'user', tone: 'text-amber-600 dark:text-amber-300' }
    case 'finish':
      return { target: 'done', tone: 'text-muted-foreground' }
    case 'emit_error':
      return { target: 'error', tone: 'text-rose-600 dark:text-rose-300' }
  }
}

export function eventCategories(entry: TimelineEntry): Set<TraceCategory> {
  const categories = new Set<TraceCategory>()
  switch (entry.event.kind) {
    case 'user_message':
      categories.add('user')
      break
    case 'user_approve':
    case 'user_reject':
      categories.add('user')
      categories.add('approval')
      break
    case 'approval_mode_changed':
      categories.add('user')
      categories.add('approval')
      break
    case 'cwd_changed':
    case 'cancel':
    case 'clear':
      categories.add('user')
      break
    case 'llm_response':
    case 'llm_error':
      categories.add('llm')
      break
    case 'tool_result':
      categories.add('tool')
      break
    case 'messages_replaced':
      categories.add('system')
      break
  }
  for (const eff of entry.effects) {
    if (eff.kind === 'call_llm') categories.add('llm')
    else if (eff.kind === 'call_tool') categories.add('tool')
    else if (eff.kind === 'request_approval') categories.add('approval')
    else if (eff.kind === 'finish' || eff.kind === 'emit_error') categories.add('system')
  }
  return categories
}

export function summarizeContent(content: readonly MessageContent[]): string {
  if (content.length === 0) return 'empty message'
  return content.map((c) => {
    if (c.type === 'text') return c.text.slice(0, 120)
    if (c.type === 'tool_call') return `tool_call ${c.name}`
    if (c.type === 'tool_result') return `tool_result ${c.ok ? 'ok' : 'error'} ${c.content.slice(0, 80)}`
    if (c.type === 'image') return `image ${c.source.kind}`
    if (c.type === 'thinking') return 'thinking block'
    return 'content'
  }).join(' · ')
}

export function summarizeContentForCard(content: readonly MessageContent[]): string {
  if (content.length === 0) return 'empty message'
  const textChars = content
    .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
    .reduce((sum, c) => sum + c.text.replace(/\s+/g, ' ').trim().length, 0)
  const toolCalls = content.filter((c): c is Extract<MessageContent, { type: 'tool_call' }> => c.type === 'tool_call')
  const toolResults = content.filter((c): c is Extract<MessageContent, { type: 'tool_result' }> => c.type === 'tool_result')
  const images = content.filter((c) => c.type === 'image').length
  const thinking = content.filter((c) => c.type === 'thinking').length

  const parts: string[] = []
  if (textChars > 0) parts.push(`text ${textChars} chars`)
  if (toolCalls.length > 0) parts.push(`tool calls ${toolCalls.length}: ${compactNameCounts(toolCalls.map((c) => c.name), 2)}`)
  if (toolResults.length > 0) {
    const ok = toolResults.filter((c) => c.ok).length
    const err = toolResults.length - ok
    parts.push(`tool results ${toolResults.length}${err > 0 ? ` (${err} error)` : ''}`)
  }
  if (images > 0) parts.push(`images ${images}`)
  if (thinking > 0) parts.push(`thinking ${thinking}`)
  return compactCardSummary(parts.join(' · ') || `${content.length} content blocks`)
}

export function roleCounts(messages: readonly Message[]): string {
  const counts = new Map<Message['role'], number>()
  for (const message of messages) counts.set(message.role, (counts.get(message.role) ?? 0) + 1)
  return [...counts.entries()].map(([role, count]) => `${role} ${count}`).join(', ') || 'none'
}

export function toolInputSummary(input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? `path ${input.path}` : null
  const cmd = typeof input.cmd === 'string' ? `cmd ${input.cmd}` : null
  const query = typeof input.query === 'string' ? `query ${input.query}` : null
  return path ?? cmd ?? query ?? JSON.stringify(input).slice(0, 140)
}

export function primaryCategory(entry: TimelineEntry): TraceCategory {
  const cats = eventCategories(entry)
  return TRACE_CATEGORY_ORDER.find((cat) => cats.has(cat)) ?? 'system'
}

export function buildToolCalls(timeline: readonly TimelineEntry[]): readonly ToolCallLifecycle[] {
  const byId = new Map<string, ToolCallLifecycle>()
  const ensure = (callId: string, name: string, input: Record<string, unknown>): ToolCallLifecycle => {
    const existing = byId.get(callId)
    if (existing) return existing
    const next: ToolCallLifecycle = { callId, name, input }
    byId.set(callId, next)
    return next
  }
  for (const entry of timeline) {
    for (const effect of entry.effects) {
      if (effect.kind === 'request_approval') {
        const call = ensure(effect.callId, effect.name, effect.input)
        call.requestedSeq = entry.seq
      } else if (effect.kind === 'call_tool') {
        const call = ensure(effect.callId, effect.name, effect.input)
        call.dispatchedSeq = entry.seq
      }
    }
    if (entry.event.kind === 'llm_response') {
      for (const content of entry.event.message.content) {
        if (content.type === 'tool_call') {
          const call = ensure(content.callId, content.name, content.input)
          call.requestedSeq ??= entry.seq
        }
      }
    } else if (entry.event.kind === 'user_approve') {
      const call = byId.get(entry.event.callId)
      if (call) call.approvedSeq = entry.seq
    } else if (entry.event.kind === 'user_reject') {
      const call = byId.get(entry.event.callId)
      if (call) call.rejectedSeq = entry.seq
    } else if (entry.event.kind === 'tool_result') {
      const call = byId.get(entry.event.callId) ?? ensure(entry.event.callId, 'unknown', {})
      call.resultSeq = entry.seq
      call.result = entry.event
    }
  }
  return [...byId.values()].sort((a, b) => (a.requestedSeq ?? a.dispatchedSeq ?? 0) - (b.requestedSeq ?? b.dispatchedSeq ?? 0))
}

export function findPriorCallLlm(timeline: readonly TimelineEntry[], i: number): PriorCallLlm | null {
  if (timeline[i]?.event.kind !== 'llm_response') return null
  for (let j = i - 1; j >= 0; j--) {
    const entry = timeline[j]!
    const eff = entry.effects.find((e): e is CallLlmEffect => e.kind === 'call_llm')
    if (eff) return { seq: entry.seq, effect: eff }
  }
  return null
}

export function messageIndexFor(timeline: readonly TimelineEntry[], currentIndex: number, messagesCount: number): number | null {
  const t = timeline[currentIndex]
  if (!t) return null
  const producesMessage = t.event.kind === 'user_message' || t.event.kind === 'llm_response' || t.event.kind === 'tool_result'
  if (!producesMessage) return null
  let seen = -1
  for (let i = 0; i <= currentIndex; i++) {
    const ev = timeline[i]!.event
    if (ev.kind === 'user_message' || ev.kind === 'llm_response' || ev.kind === 'tool_result') seen += 1
  }
  if (seen < 0 || seen >= messagesCount) return null
  return seen
}

export function entryMatchesFilter(
  entry: TimelineEntry,
  filter: ReadonlySet<TraceCategory>,
): boolean {
  if (filter.size === 0) return true
  for (const cat of eventCategories(entry)) {
    if (filter.has(cat)) return true
  }
  return false
}

export function eventSummary(event: AgentEvent, priorCallLlm: PriorCallLlm | null): string {
  switch (event.kind) {
    case 'user_message':
      return event.text ? summarizeTextForCard(event.text) : summarizeContentForCard(event.content ?? [])
    case 'llm_response':
      return `${summarizeContentForCard(event.message.content)}${priorCallLlm ? ` · response to call_llm #${priorCallLlm.seq}` : ''}`
    case 'tool_result':
      return `${event.ok ? 'ok' : 'error'} · ${event.content.length} chars`
    case 'user_approve':
      return `approved ${event.callId}`
    case 'user_reject':
      return `rejected ${event.callId}${event.reason ? ` · ${event.reason}` : ''}`
    case 'llm_error':
      return event.error
    case 'messages_replaced':
      return event.reason === 'compaction'
        ? `compaction · ${event.replaceRange.start} → ${event.replaceRange.end} · ${event.replacementMessages.length} replacement message(s)`
        : `messages replaced · ${event.reason}`
    case 'approval_mode_changed':
      return `approval mode ${event.mode}`
    case 'cwd_changed':
      return event.cwd
    case 'cancel':
      return 'cancel requested'
    case 'clear':
      return 'session context cleared'
  }
}

export function teachingText(entry: TimelineEntry, flow?: StateFlowStep): string {
  const inbound = inboundOf(entry.event)
  const effects = entry.effects.length > 0
    ? entry.effects.map((effect) => `${effect.kind} -> ${effectTarget(effect).target}`).join(', ')
    : 'no external effects'
  const transition = flow ? `${flow.from} -> ${flow.to}` : 'state transition not classified'
  return `${inbound.source} sends ${entry.event.kind}; state machine moves ${transition}; output actions: ${effects}.`
}


export function mergeArtifactEntry(
  current: readonly TimelineEntry[],
  base: TimelineEntry,
  payload: ServerLogArtifactPayload,
): readonly TimelineEntry[] {
  const hydrated = hydrateTimelineEntry(base, payload)
  const without = current.filter((entry) => entry.seq !== hydrated.seq)
  return [...without, hydrated].sort((a, b) => a.seq - b.seq)
}

export function mergeTimelineArtifacts(
  timeline: readonly TimelineEntry[],
  artifacts: readonly TimelineEntry[],
): readonly TimelineEntry[] {
  if (artifacts.length === 0) return timeline
  const bySeq = new Map(artifacts.map((entry) => [entry.seq, entry]))
  return timeline.map((entry) => {
    const hydrated = bySeq.get(entry.seq)
    if (!hydrated) return entry
    return {
      ...entry,
      effects: hydrated.effects,
      ...(hydrated.llmTrace ? { llmTrace: hydrated.llmTrace } : {}),
      hasEffectsArtifact: false,
      hasLlmTraceArtifact: hydrated.llmTrace ? false : entry.hasLlmTraceArtifact,
    }
  })
}

export function hydrateTimelineEntry(entry: TimelineEntry, payload: ServerLogArtifactPayload): TimelineEntry {
  return {
    ...entry,
    ...(payload.effects ? { effects: payload.effects } : {}),
    ...(payload.llmTrace ? { llmTrace: payload.llmTrace } : {}),
    hasEffectsArtifact: payload.effects ? false : entry.hasEffectsArtifact,
    hasLlmTraceArtifact: payload.llmTrace ? false : entry.hasLlmTraceArtifact,
  }
}


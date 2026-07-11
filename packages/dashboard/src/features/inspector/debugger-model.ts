import {
  createInitialState,
  foldWithTrace,
  type AgentConfig,
  type AgentEvent,
  type Message,
  type MessageContent,
  type AgentState,
  type Effect,
} from '@agent-kernel/kernel'

import type { TimelineEntry } from '../../session.js'

export type ReplaySnapshot = {
  seq: number
  index: number
  event: AgentEvent
  before: AgentState
  after: AgentState
  effects: readonly Effect[]
}

export type StateDiff = {
  path: string
  before: string
  after: string
  kind: 'added' | 'removed' | 'changed'
}

export type StateDiffSummaryItem = {
  label: string
  value: string
  detail?: string
  tone?: 'neutral' | 'added' | 'removed' | 'changed'
}

export type StateDiffSummaryGroup = {
  id: 'state' | 'messages' | 'usage' | 'other'
  title: string
  items: readonly StateDiffSummaryItem[]
}

export type TraceQuery = {
  text: readonly string[]
  kind?: string
  effect?: string
  seq?: number
  source?: string
}

export type RunHealthItem = {
  id: string
  label: string
  value: string
  tone: 'ok' | 'warn' | 'error' | 'neutral'
}

export function buildReplaySnapshots(
  timeline: readonly TimelineEntry[],
  state: AgentState | null,
  config?: AgentConfig | null,
): readonly ReplaySnapshot[] {
  if (timeline.length === 0) return []
  const initial = createInitialState({
    sessionId: state?.sessionId ?? 'dashboard-replay',
    ...(config?.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
  })
  const replayConfig: AgentConfig = config ?? { tools: [] }
  const beforeStates: AgentState[] = [initial]
  const folded = foldWithTrace(initial, timeline.map((entry) => entry.event), replayConfig)
  return folded.trace.map((trace, index) => {
    const before = beforeStates[index]!
    beforeStates.push(trace.state)
    const entry = timeline[index]!
    return {
      seq: entry.seq,
      index,
      event: entry.event,
      before,
      after: trace.state,
      effects: trace.effects,
    }
  })
}

export function diffStates(before: unknown, after: unknown, limit = 16): readonly StateDiff[] {
  const out: StateDiff[] = []
  walkDiff(before, after, '', out, limit)
  return out
}

export function summarizeStateDiff(before: AgentState, after: AgentState, rawDiff: readonly StateDiff[]): readonly StateDiffSummaryGroup[] {
  const stateItems: StateDiffSummaryItem[] = []
  if (before.status !== after.status) stateItems.push({ label: 'status', value: `${before.status} -> ${after.status}`, tone: 'changed' })
  if (before.cursor !== after.cursor) stateItems.push({ label: 'cursor', value: formatNumberChange(before.cursor, after.cursor), tone: 'changed' })
  if (before.contextPressureLevel !== after.contextPressureLevel) stateItems.push({ label: 'context', value: `${before.contextPressureLevel} -> ${after.contextPressureLevel}`, tone: 'changed' })
  if (before.approvalMode !== after.approvalMode) stateItems.push({ label: 'approval', value: `${before.approvalMode} -> ${after.approvalMode}`, tone: 'changed' })
  if (before.cwd !== after.cwd) stateItems.push({ label: 'cwd', value: `${before.cwd ?? 'unset'} -> ${after.cwd ?? 'unset'}`, tone: 'changed' })
  if (before.error !== after.error) stateItems.push({ label: 'error', value: `${before.error ?? 'none'} -> ${after.error ?? 'none'}`, tone: after.error ? 'added' : 'removed' })

  const messageItems = summarizeMessageChanges(before.messages, after.messages)
  const usageItems = summarizeUsageChanges(before.usage, after.usage)
  const knownPaths = new Set([
    'status',
    'cursor',
    'contextPressureLevel',
    'approvalMode',
    'cwd',
    'error',
    'messages.length',
    'usage.inputTokens',
    'usage.outputTokens',
    'usage.cacheCreationTokens',
    'usage.cacheReadTokens',
  ])
  const otherItems = rawDiff
    .filter((item) => !knownPaths.has(item.path) && !item.path.startsWith('messages.') && !item.path.startsWith('usage.'))
    .slice(0, 4)
    .map((item) => ({ label: item.path, value: `${item.before} -> ${item.after}`, tone: item.kind }))

  return [
    { id: 'state' as const, title: 'State', items: stateItems },
    { id: 'messages' as const, title: 'Messages', items: messageItems },
    { id: 'usage' as const, title: 'Usage', items: usageItems },
    { id: 'other' as const, title: 'Other', items: otherItems },
  ].filter((group) => group.items.length > 0)
}

function walkDiff(before: unknown, after: unknown, path: string, out: StateDiff[], limit: number): void {
  if (out.length >= limit) return
  if (Object.is(before, after)) return

  if (!isObjectLike(before) || !isObjectLike(after)) {
    out.push({
      path: path || '$',
      before: formatDebugValue(before),
      after: formatDebugValue(after),
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
    })
    return
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    const beforeArr = Array.isArray(before) ? before : []
    const afterArr = Array.isArray(after) ? after : []
    if (beforeArr.length !== afterArr.length) {
      out.push({
        path: path ? `${path}.length` : 'length',
        before: String(beforeArr.length),
        after: String(afterArr.length),
        kind: 'changed',
      })
    }
    const max = Math.max(beforeArr.length, afterArr.length)
    for (let i = 0; i < max && out.length < limit; i++) {
      walkDiff(beforeArr[i], afterArr[i], path ? `${path}.${i}` : String(i), out, limit)
    }
    return
  }

  const beforeObj = before as Record<string, unknown>
  const afterObj = after as Record<string, unknown>
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])
  for (const key of [...keys].sort()) {
    walkDiff(beforeObj[key], afterObj[key], path ? `${path}.${key}` : key, out, limit)
    if (out.length >= limit) return
  }
}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === 'object'
}

export function parseTraceQuery(input: string): TraceQuery {
  const query: { text: string[]; kind?: string; effect?: string; seq?: number; source?: string } = { text: [] }
  for (const raw of input.trim().split(/\s+/).filter(Boolean)) {
    const [key, ...rest] = raw.split(':')
    const value = rest.join(':')
    if (!value) {
      query.text.push(raw.toLowerCase())
      continue
    }
    if (key === 'kind') query.kind = value.toLowerCase()
    else if (key === 'effect') query.effect = value.toLowerCase()
    else if (key === 'seq') {
      const seq = Number(value)
      if (Number.isFinite(seq)) query.seq = seq
    } else if (key === 'source') query.source = value.toLowerCase()
    else if (key === 'text') query.text.push(value.toLowerCase())
    else query.text.push(raw.toLowerCase())
  }
  return query
}

export function traceEntryMatchesQuery(entry: TimelineEntry, query: TraceQuery, source: string, summary: string): boolean {
  if (query.seq !== undefined && entry.seq !== query.seq) return false
  if (query.kind && !entry.event.kind.toLowerCase().includes(query.kind)) return false
  if (query.source && !source.toLowerCase().includes(query.source)) return false
  if (query.effect !== undefined && !entry.effects.some((effect) => effect.kind.toLowerCase().includes(query.effect!))) return false
  if (query.text.length > 0) {
    const haystack = `${entry.seq} ${entry.event.kind} ${source} ${summary} ${entry.effects.map((e) => e.kind).join(' ')} ${safeJson(entry.event)}`.toLowerCase()
    return query.text.every((token) => haystack.includes(token))
  }
  return true
}

export function buildRunHealth(
  state: AgentState | null,
  config: AgentConfig | null | undefined,
  timeline: readonly TimelineEntry[],
): readonly RunHealthItem[] {
  const missingTrace = timeline.filter((entry) => entry.event.kind === 'llm_response' && !entry.llmTrace).length
  const failedTools = timeline.filter((entry) => entry.event.kind === 'tool_result' && entry.event.ok === false).length
  const llmErrors = timeline.filter((entry) => entry.event.kind === 'llm_error').length
  const pending = state?.pendingCalls.filter((call) => call.status === 'awaiting_approval').length ?? 0
  const pressure = contextPressure(state, config)
  return [
    {
      id: 'status',
      label: 'Run status',
      value: state?.status ?? 'no state',
      tone: state?.status === 'error' ? 'error' : state?.status === 'awaiting_approval' ? 'warn' : 'neutral',
    },
    {
      id: 'context',
      label: 'Context pressure',
      value: pressure.label,
      tone: pressure.tone,
    },
    {
      id: 'pending',
      label: 'Pending approvals',
      value: String(pending),
      tone: pending > 0 ? 'warn' : 'ok',
    },
    {
      id: 'llm-errors',
      label: 'LLM errors',
      value: String(llmErrors),
      tone: llmErrors > 0 ? 'error' : 'ok',
    },
    {
      id: 'tool-errors',
      label: 'Failed tools',
      value: String(failedTools),
      tone: failedTools > 0 ? 'error' : 'ok',
    },
    {
      id: 'missing-trace',
      label: 'Missing HTTP traces',
      value: String(missingTrace),
      tone: missingTrace > 0 ? 'warn' : 'ok',
    },
  ]
}

function contextPressure(state: AgentState | null, config: AgentConfig | null | undefined): { label: string; tone: RunHealthItem['tone'] } {
  if (!state || !config?.contextLimit) return { label: state?.contextPressureLevel ?? 'not configured', tone: 'neutral' }
  const percent = Math.round((state.usage.inputTokens / config.contextLimit) * 100)
  const level = state.contextPressureLevel ?? 'none'
  return {
    label: `${level}  -  ${percent}%`,
    tone: level === 'hard' ? 'error' : level === 'soft' ? 'warn' : 'ok',
  }
}

export function firstDivergence(a: readonly TimelineEntry[], b: readonly TimelineEntry[]): number {
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (!a[i] || !b[i]) return i
    if (a[i]!.event.kind !== b[i]!.event.kind || safeJson(a[i]!.event) !== safeJson(b[i]!.event)) return i
  }
  return -1
}

export function formatDebugValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length} items]`
  if (typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).length} keys}`
  return String(value)
}

function summarizeMessageChanges(before: readonly Message[], after: readonly Message[]): readonly StateDiffSummaryItem[] {
  if (before === after) return []
  const shared = Math.min(before.length, after.length)
  let firstChanged = -1
  for (let i = 0; i < shared; i++) {
    if (!messagesEqual(before[i]!, after[i]!)) {
      firstChanged = i
      break
    }
  }
  const prefixUnchanged = firstChanged === -1
  if (before.length === after.length) {
    if (prefixUnchanged) return []
    return [{ label: 'message log', value: `${before.length} messages updated`, detail: `first changed #${firstChanged + 1}`, tone: 'changed' }]
  }
  if (after.length > before.length && prefixUnchanged) {
    return after.slice(before.length).map((message, index) => ({
      label: `+ ${message.role} message #${before.length + index + 1}`,
      value: summarizeMessageContent(message),
      tone: 'added' as const,
    }))
  }
  if (before.length > after.length && prefixUnchanged) return before.slice(after.length).map((message, index) => ({
    label: `- ${message.role} message #${after.length + index + 1}`,
    value: summarizeMessageContent(message),
    tone: 'removed' as const,
  }))
  return [{
    label: 'message log',
    value: `${before.length} -> ${after.length} messages`,
    detail: firstChanged >= 0 ? `first changed #${firstChanged + 1}` : undefined,
    tone: 'changed',
  }]
}

function messagesEqual(a: Message, b: Message): boolean {
  return a.role === b.role && JSON.stringify(a.content) === JSON.stringify(b.content)
}

function summarizeMessageContent(message: Message): string {
  const counts = new Map<string, number>()
  for (const part of message.content) counts.set(contentLabel(part), (counts.get(contentLabel(part)) ?? 0) + 1)
  if (counts.size === 0) return 'empty content'
  return [...counts].map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`).join(' / ')
}

function contentLabel(part: MessageContent): string {
  if (part.type === 'tool_call') return 'tool call'
  if (part.type === 'tool_result') return 'tool result'
  if (part.type === 'thinking') return 'thinking block'
  if (part.type === 'image') return 'image'
  return 'text block'
}

function summarizeUsageChanges(before: AgentState['usage'], after: AgentState['usage']): readonly StateDiffSummaryItem[] {
  const fields: readonly [keyof AgentState['usage'], string][] = [
    ['inputTokens', 'input'],
    ['outputTokens', 'output'],
    ['cacheCreationTokens', 'cache write'],
    ['cacheReadTokens', 'cache read'],
  ]
  return fields.flatMap(([key, label]) => {
    const beforeValue = before[key] ?? 0
    const afterValue = after[key] ?? 0
    if (beforeValue === afterValue) return []
    return [{ label, value: formatNumberChange(beforeValue, afterValue), tone: 'changed' as const }]
  })
}

function formatNumberChange(before: number, after: number): string {
  const delta = after - before
  const sign = delta > 0 ? '+' : ''
  return `${formatInteger(before)} -> ${formatInteger(after)} (${sign}${formatInteger(delta)})`
}

function formatInteger(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : String(value)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

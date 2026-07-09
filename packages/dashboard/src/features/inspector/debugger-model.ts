import {
  createInitialState,
  foldWithTrace,
  type AgentConfig,
  type AgentEvent,
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
    label: `${level} · ${percent}%`,
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

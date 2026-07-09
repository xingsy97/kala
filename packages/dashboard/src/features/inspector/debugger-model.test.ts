import { describe, expect, it } from 'vitest'

import { createInitialState, type AgentState } from '@agent-kernel/kernel'
import type { TimelineEntry } from '../../session.js'
import {
  buildReplaySnapshots,
  buildRunHealth,
  diffStates,
  firstDivergence,
  parseTraceQuery,
  summarizeStateDiff,
  traceEntryMatchesQuery,
} from './debugger-model.js'

const state: AgentState = {
  ...createInitialState({ sessionId: 's1' }),
  cwd: '/tmp',
  usage: { inputTokens: 80, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 },
  contextPressureLevel: 'soft',
}

const timeline: TimelineEntry[] = [
  {
    seq: 1,
    ts: '2026-07-07T00:00:00Z',
    event: { kind: 'cwd_changed', cwd: '/tmp' },
    effects: [],
  },
  {
    seq: 2,
    ts: '2026-07-07T00:00:01Z',
    event: { kind: 'user_message', text: 'pwd' },
    effects: [{ kind: 'call_llm', messages: [], tools: [] }],
  },
  {
    seq: 3,
    ts: '2026-07-07T00:00:02Z',
    event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'I will run pwd.' }] } },
    effects: [{ kind: 'call_tool', callId: 'c1', name: 'exec', input: { cmd: 'pwd' }, cwd: '/tmp' }],
  },
  {
    seq: 4,
    ts: '2026-07-07T00:00:03Z',
    event: { kind: 'tool_result', callId: 'c1', ok: false, content: 'wrong cwd' },
    effects: [{ kind: 'emit_error', error: 'wrong cwd' }],
  },
]

describe('debugger model helpers', () => {
  it('builds replay snapshots from the reducer timeline', () => {
    const snapshots = buildReplaySnapshots(timeline, state, { tools: [], contextLimit: 100 })

    expect(snapshots).toHaveLength(4)
    expect(snapshots[0]?.before.cwd).toBeUndefined()
    expect(snapshots[0]?.after.cwd).toBe('/tmp')
    expect(snapshots[1]?.after.messages).toHaveLength(1)
  })

  it('summarizes nested state diffs', () => {
    const diff = diffStates(
      { status: 'idle', messages: [{ role: 'user' }], usage: { inputTokens: 1 } },
      { status: 'thinking', messages: [{ role: 'user' }, { role: 'assistant' }], usage: { inputTokens: 2 } },
    )

    expect(diff.map((d) => d.path)).toContain('messages.length')
    expect(diff.map((d) => d.path)).toContain('status')
    expect(diff.map((d) => d.path)).toContain('usage.inputTokens')
  })

  it('builds semantic state diff summaries for debugger display', () => {
    const before: AgentState = {
      ...state,
      status: 'thinking',
      cursor: 111,
      messages: Array.from({ length: 63 }, () => ({ role: 'user' as const, content: [{ type: 'text' as const, text: 'previous' }] })),
      usage: { inputTokens: 444534, outputTokens: 343304, cacheCreationTokens: 0, cacheReadTokens: 0 },
    }
    const after: AgentState = {
      ...before,
      status: 'done',
      cursor: 112,
      messages: [...before.messages, { role: 'assistant', content: [{ type: 'tool_call', callId: 'c1', name: 'exec', input: {} }, { type: 'text', text: 'ok' }] }],
      usage: { inputTokens: 502715, outputTokens: 374410, cacheCreationTokens: 0, cacheReadTokens: 0 },
    }

    const raw = diffStates(before, after, 16)
    const summary = summarizeStateDiff(before, after, raw)

    expect(summary.find((group) => group.id === 'messages')?.items[0]?.label).toBe('+ assistant message #64')
    expect(summary.find((group) => group.id === 'messages')?.items[0]?.value).toBe('1 tool call / 1 text block')
    expect(summary.find((group) => group.id === 'usage')?.items.map((item) => item.value)).toContain('444,534 -> 502,715 (+58,181)')
    expect(summary.find((group) => group.id === 'state')?.items.map((item) => item.label)).toContain('status')
  })

  it('parses and matches scoped trace queries', () => {
    const query = parseTraceQuery('kind:llm_response effect:call_tool source:llm pwd')

    expect(query.kind).toBe('llm_response')
    expect(traceEntryMatchesQuery(timeline[2]!, query, 'llm', 'I will run pwd.')).toBe(true)
    expect(traceEntryMatchesQuery(timeline[1]!, query, 'user', 'pwd')).toBe(false)
  })

  it('builds run health without cost data', () => {
    const health = buildRunHealth(state, { tools: [], contextLimit: 100 }, timeline)

    expect(health.find((item) => item.id === 'context')?.value).toBe('soft · 80%')
    expect(health.find((item) => item.id === 'tool-errors')?.tone).toBe('error')
    expect(health.find((item) => item.id === 'missing-trace')?.tone).toBe('warn')
    expect(health.map((item) => item.label).join(' ')).not.toMatch(/cost|money/i)
  })

  it('finds the first fork divergence', () => {
    expect(firstDivergence(timeline.slice(0, 2), timeline.slice(0, 2))).toBe(-1)
    expect(firstDivergence(timeline.slice(0, 2), timeline.slice(0, 3))).toBe(2)
    expect(firstDivergence(timeline, [{ ...timeline[0]!, event: { kind: 'clear' } }])).toBe(0)
  })
})

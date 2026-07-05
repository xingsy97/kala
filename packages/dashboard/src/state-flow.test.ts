import { describe, expect, it } from 'vitest'

import type { TimelineEntry } from './session.js'
import { stateFlow } from './state-flow.js'

describe('stateFlow', () => {
  it('derives reducer status transitions from event effects', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-05T00:00:00Z',
        event: { kind: 'user_message', text: 'hi' },
        effects: [{ kind: 'call_llm', messages: [], tools: [] }],
      },
      {
        seq: 2,
        ts: '2026-07-05T00:00:01Z',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_call', callId: 'c1', name: 'read', input: {} },
            ],
          },
        },
        effects: [{ kind: 'call_tool', callId: 'c1', name: 'read', input: {} }],
      },
      {
        seq: 3,
        ts: '2026-07-05T00:00:02Z',
        event: { kind: 'tool_result', callId: 'c1', ok: true, content: 'ok' },
        effects: [{ kind: 'call_llm', messages: [], tools: [] }],
      },
      {
        seq: 4,
        ts: '2026-07-05T00:00:03Z',
        event: {
          kind: 'llm_response',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        },
        effects: [{ kind: 'finish' }],
      },
    ]

    expect(stateFlow(timeline).map((s) => [s.from, s.to])).toEqual([
      ['idle', 'thinking'],
      ['thinking', 'executing_tools'],
      ['executing_tools', 'thinking'],
      ['thinking', 'done'],
    ])
  })
})

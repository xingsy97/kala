import { describe, expect, it } from 'vitest'

import type { Message } from '@agent-kernel/kernel'

import type { TimelineEntry } from './session.js'
import { visibleMessages, visibleTranscript } from './transcript.js'

const system: Message = {
  role: 'system',
  content: [{ type: 'text', text: 'sys' }],
}

describe('visibleMessages', () => {
  it('keeps event-log transcript visible after compacted state messages shrink', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-05T00:00:00.000Z',
        event: { kind: 'user_message', text: 'hello' },
        effects: [],
      },
      {
        seq: 2,
        ts: '2026-07-05T00:00:01.000Z',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
          },
        },
        effects: [],
      },
      {
        seq: 3,
        ts: '2026-07-05T00:00:02.000Z',
        event: {
          kind: 'compact_replaced',
          summary: 'hello -> hi',
          replacedCount: 2,
          tokensBefore: 100,
          tokensAfter: 8,
        },
        effects: [],
      },
    ]

    const visible = visibleMessages(
      [system, { role: 'system', content: [{ type: 'text', text: 'hello -> hi' }] }],
      timeline,
      '',
    )

    expect(visible.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(visible[0]?.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(visible[1]?.content[0]).toEqual({ type: 'text', text: 'hi' })
    const transcript = visibleTranscript(
      [system, { role: 'system', content: [{ type: 'text', text: 'hello -> hi' }] }],
      timeline,
      '',
    )
    expect(transcript[2]).toMatchObject({
      kind: 'compact_boundary',
      seq: 3,
      trigger: 'unknown',
      tokensBefore: 100,
      tokensAfter: 8,
    })
  })

  it('appends an assistant draft while token deltas are streaming', () => {
    const visible = visibleMessages(
      [system],
      [
        {
          seq: 1,
          ts: '2026-07-05T00:00:00.000Z',
          event: { kind: 'user_message', text: 'stream' },
          effects: [],
        },
      ],
      'partial answer',
    )

    expect(visible.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(visible[1]?.content[0]).toEqual({ type: 'text', text: 'partial answer' })
  })

  it('uses timeline messages even before the first assistant response lands', () => {
    const visible = visibleMessages(
      [system],
      [
        {
          seq: 1,
          ts: '2026-07-05T00:00:00.000Z',
          event: { kind: 'user_message', text: 'first turn' },
          effects: [],
        },
      ],
      '',
    )

    expect(visible.map((m) => m.role)).toEqual(['user'])
    expect(visible[0]?.content[0]).toEqual({ type: 'text', text: 'first turn' })
  })

  it('emits nothing when the only state message is the system prompt (no timeline, no stream)', () => {
    const visible = visibleMessages([system], [], '')
    expect(visible).toEqual([])
    const transcript = visibleTranscript([system], [], '')
    expect(transcript).toEqual([])
  })

  it('drops system messages from the tail-fallback dump', () => {
    const user: Message = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    const visible = visibleMessages([system, user], [], '')
    expect(visible.map((m) => m.role)).toEqual(['user'])
  })
})

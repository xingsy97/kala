import { describe, expect, it } from 'vitest'

import type { Message } from '@agent-kernel/kernel'

import type { TimelineEntry } from './session.js'
import { reconcilePendingUserMessages, visibleMessages, visibleTranscript } from './transcript.js'

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
          kind: 'messages_replaced',
          reason: 'compaction',
          replaceRange: { start: 1, end: 3 },
          replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'hello -> hi' }] }],
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
      tokensBefore: null,
      tokensAfter: null,
    })
  })

  it('honours compactionMetadata attached to the timeline entry (live path)', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-05T00:00:00.000Z',
        event: { kind: 'user_message', text: 'hello' },
        effects: [],
      },
      {
        seq: 2,
        ts: '2026-07-05T00:00:02.000Z',
        event: {
          kind: 'messages_replaced',
          reason: 'compaction',
          replaceRange: { start: 1, end: 5 },
          replacementMessages: [{ role: 'system', content: [{ type: 'text', text: 'summary' }] }],
        },
        effects: [],
        compactionMetadata: {
          trigger: 'auto',
          tokensBefore: 12400,
          tokensAfter: 3800,
          replacedCount: 4,
          attemptId: 'cmp_01',
        },
      },
    ]
    const transcript = visibleTranscript(
      [system, { role: 'system', content: [{ type: 'text', text: 'summary' }] }],
      timeline,
      '',
    )
    const boundary = transcript.find((item) => item.kind === 'compact_boundary')
    expect(boundary).toMatchObject({
      trigger: 'auto',
      tokensBefore: 12400,
      tokensAfter: 3800,
      replacedCount: 4,
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

    const transcript = visibleTranscript([system], [], 'partial answer')
    expect(transcript[0]).toMatchObject({
      kind: 'message',
      streaming: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
    })
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

  it('keeps fork baseline messages before child timeline events', () => {
    const stateMessages: Message[] = [
      system,
      { role: 'user', content: [{ type: 'text', text: 'first parent turn' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first parent answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'edited child prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'child answer' }] },
    ]
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-07-06T00:00:00.000Z', event: { kind: 'user_message', text: 'edited child prompt' }, effects: [] },
      {
        seq: 2,
        ts: '2026-07-06T00:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'child answer' }] } },
        effects: [],
      },
    ]

    const visible = visibleMessages(stateMessages, timeline, '', { includeStatePrefix: true })

    expect(visible.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'first parent turn' },
      { type: 'text', text: 'first parent answer' },
      { type: 'text', text: 'edited child prompt' },
      { type: 'text', text: 'child answer' },
    ])
  })

  it('emits nothing when the only state message is the system prompt (no timeline, no stream)', () => {
    const visible = visibleMessages([system], [], '')
    expect(visible).toEqual([])
    const transcript = visibleTranscript([system], [], '')
    expect(transcript).toEqual([])
  })

  it('appends local sending messages but leaves server queued messages in the composer dock', () => {
    const transcript = visibleTranscript(
      [system],
      [],
      '',
      [
        {
          id: 'local-1',
          text: 'sent but not acked',
          mode: 'steer',
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
      [
        {
          id: 'queue-1',
          text: 'run next',
          mode: 'queue',
          createdAt: '2026-07-06T00:00:01.000Z',
        },
      ],
    )

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: 'pending_user_message',
        id: 'local-1',
        status: 'sending',
        text: 'sent but not acked',
      }),
    ])
  })

  it('drops system messages from the tail-fallback dump', () => {
    const user: Message = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    const visible = visibleMessages([system, user], [], '')
    expect(visible.map((m) => m.role)).toEqual(['user'])
  })

  it('reconciles local pending messages with timeline and queue acknowledgements', () => {
    const pending = [
      { id: 'local-1', text: 'sent', mode: 'steer' as const, createdAt: '2026-07-06T00:00:00.000Z', afterSeq: 0 },
      { id: 'local-2', text: 'queued', mode: 'queue' as const, createdAt: '2026-07-06T00:00:01.000Z', afterSeq: 0 },
    ]
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-07-06T00:00:02.000Z', event: { kind: 'user_message', text: 'sent' }, effects: [] },
    ]

    const next = reconcilePendingUserMessages(
      pending,
      timeline,
      [{ id: 'queue-1', text: 'queued', mode: 'queue', createdAt: '2026-07-06T00:00:03.000Z' }],
      'thinking',
      '',
    )

    expect(next).toEqual([])
  })

  it('drops stale steer pending messages after the later LLM turn has completed', () => {
    const pending = [
      { id: 'local-1', text: 'Schema-first or types-first', mode: 'steer' as const, createdAt: '2026-07-06T00:00:00.000Z', afterSeq: 10 },
      { id: 'queue-1', text: 'keep queued local preview', mode: 'queue' as const, createdAt: '2026-07-06T00:00:00.000Z', afterSeq: 10 },
    ]
    const timeline: TimelineEntry[] = [
      {
        seq: 11,
        ts: '2026-07-06T00:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        effects: [],
      },
    ]

    const next = reconcilePendingUserMessages(pending, timeline, [], 'done', '')

    expect(next).toEqual([pending[1]])
  })

  it('keeps local pending messages while the turn is still active or streaming', () => {
    const pending = [{ id: 'local-1', text: 'still sending', mode: 'steer' as const, createdAt: '2026-07-06T00:00:00.000Z', afterSeq: 10 }]
    const timeline: TimelineEntry[] = [
      {
        seq: 11,
        ts: '2026-07-06T00:00:01.000Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        effects: [],
      },
    ]

    expect(reconcilePendingUserMessages(pending, timeline, [], 'thinking', '')).toEqual(pending)
    expect(reconcilePendingUserMessages(pending, timeline, [], 'done', 'partial')).toEqual(pending)
  })
})

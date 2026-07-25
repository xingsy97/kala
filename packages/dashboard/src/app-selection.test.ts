import { describe, expect, it } from 'vitest'

import type { SessionSummary } from '@agent-kernel/shared'

import { nextSessionSelection, reconcileOptimisticQueuedMessages, removedSessionIds, sessionExists, sessionIdsForCacheInvalidation } from './app-logic/session-selectors.js'
import type { TimelineEntry } from './session.js'

function session(id: string, eventCount: number): SessionSummary {
  return {
    sessionId: id,
    createdAt: '2026-07-07T00:00:00.000Z',
    lastEventAt: '2026-07-07T00:00:00.000Z',
    eventCount,
    status: eventCount > 0 ? 'done' : 'idle',
  }
}

describe('session selection robustness', () => {
  it('recognizes only sessions present in the current control-plane snapshot', () => {
    const sessions = [session('parent', 3), session('child', 1)]

    expect(sessionExists(sessions, 'parent')).toBe(true)
    expect(sessionExists(sessions, 'deleted-parent')).toBe(false)
    expect(sessionExists(sessions, null)).toBe(false)
  })

  it('keeps an explicit selection when that session still exists', () => {
    const sessions = [session('parent', 3), session('child', 1)]

    expect(
      nextSessionSelection({
        sessions,
        currentSessionId: 'child',
        explicit: true,
      }),
    ).toBeNull()
  })

  it('falls back when an explicit selected session was deleted elsewhere', () => {
    const sessions = [session('empty', 0), session('active', 4)]

    expect(
      nextSessionSelection({
        sessions,
        currentSessionId: 'deleted-child',
        explicit: true,
      })?.sessionId,
    ).toBe('active')
  })

  it('selects an existing session for an implicit random startup id', () => {
    const sessions = [session('empty', 0), session('active', 4)]

    expect(
      nextSessionSelection({
        sessions,
        currentSessionId: 'random-ephemeral-id',
        explicit: false,
      })?.sessionId,
    ).toBe('active')
  })

  it('does not invent a fallback when no sessions remain', () => {
    expect(
      nextSessionSelection({
        sessions: [],
        currentSessionId: 'deleted-last-session',
        explicit: true,
      }),
    ).toBeNull()
  })

  it('keeps no session selected after an explicit clear', () => {
    const sessions = [session('previous', 5), session('next', 2)]

    expect(
      nextSessionSelection({
        sessions,
        currentSessionId: null,
        explicit: false,
      }),
    ).toBeNull()
  })
})

describe('session cache invalidation ids', () => {
  it('returns only the root session without cascade', () => {
    expect(sessionIdsForCacheInvalidation([session('root', 1), session('child', 1)], 'root', false)).toEqual(['root'])
  })

  it('returns descendants when cascade deletion is requested', () => {
    const root = session('root', 1)
    const child = { ...session('child', 1), parentSessionId: 'root' }
    const grandchild = { ...session('grandchild', 1), parentSessionId: 'child' }
    const sibling = { ...session('sibling', 1), parentSessionId: 'other' }

    expect(sessionIdsForCacheInvalidation([root, child, grandchild, sibling], 'root', true)).toEqual(['root', 'child', 'grandchild'])
  })

  it('detects sessions removed by an external control-plane update', () => {
    expect(removedSessionIds(new Set(['a', 'b', 'c']), new Set(['b', 'd']))).toEqual(['a', 'c'])
  })
})

describe('optimistic queued messages', () => {
  it('drops an optimistic queue row once the queued turn appears in the timeline', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-07T00:00:00.000Z',
        event: { kind: 'user_message', text: 'run this later' },
        effects: [{ kind: 'call_llm', messages: [], tools: [] }],
      },
    ]

    expect(
      reconcileOptimisticQueuedMessages(
        [{ id: 'optimistic-1', text: 'run this later', mode: 'queue', createdAt: '2026-07-07T00:00:00.000Z' }],
        [],
        timeline,
      ),
    ).toEqual([])
  })

  it('keeps an optimistic queue row while the host has not acknowledged it', () => {
    const optimistic = [{ id: 'optimistic-1', text: 'still pending', mode: 'queue' as const, createdAt: '2026-07-07T00:00:00.000Z' }]

    expect(reconcileOptimisticQueuedMessages(optimistic, [], [])).toBe(optimistic)
  })
})

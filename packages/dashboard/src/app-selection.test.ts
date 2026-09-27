import { describe, expect, it } from 'vitest'

import type { SessionSummary } from '@agent-kernel/shared'

import { addQueuedMessageTombstone, mergeOptimisticQueuedMessages, nextSessionSelection, reconcileOptimisticQueuedMessages, removeQueuedMessageTombstone, removedSessionIds, sessionExists, sessionIdsForCacheInvalidation } from './app-logic/session-selectors.js'
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

  it('keeps a newly created session selected while its list update is pending', () => {
    const sessions = [session('first', 4), session('second', 2)]

    expect(
      nextSessionSelection({
        sessions,
        currentSessionId: 'new-session',
        explicit: true,
        pendingSessionId: 'new-session',
      }),
    ).toBeNull()
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
  it('always returns the complete descendant tree for deletion', () => {
    const root = session('root', 1)
    const child = { ...session('child', 1), parentSessionId: 'root' }
    const grandchild = { ...session('grandchild', 1), parentSessionId: 'child' }
    const sibling = { ...session('sibling', 1), parentSessionId: 'other' }

    expect(sessionIdsForCacheInvalidation([root, child, grandchild, sibling], 'root')).toEqual(['root', 'child', 'grandchild'])
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

  it('keeps the optimistic identity across a queued snapshot followed by a stale empty snapshot', () => {
    const optimistic = [{ id: 'operation-queue', text: 'follow up', mode: 'queue' as const, createdAt: '2026-07-07T00:00:00.000Z' }]
    const server = [{ ...optimistic[0]!, createdAt: '2026-07-07T00:00:01.000Z' }]

    const afterQueuedSnapshot = reconcileOptimisticQueuedMessages(optimistic, server, [])
    expect(afterQueuedSnapshot).toBe(optimistic)
    expect(mergeOptimisticQueuedMessages(server, afterQueuedSnapshot).map((item) => item.id)).toEqual(['operation-queue'])

    const afterEmptySnapshot = reconcileOptimisticQueuedMessages(afterQueuedSnapshot, [], [])
    expect(afterEmptySnapshot).toBe(optimistic)
    expect(mergeOptimisticQueuedMessages([], afterEmptySnapshot).map((item) => item.id)).toEqual(['operation-queue'])
  })

  it('reconciles the exact queued operation even when browser and Host clocks differ', () => {
    const optimistic = [{ id: 'operation-1', text: 'same text', mode: 'queue' as const, createdAt: '2026-07-07T00:00:01.000Z' }]
    const timeline: TimelineEntry[] = [{
      seq: 1,
      ts: '2026-07-07T00:00:00.000Z',
      event: { kind: 'user_message', operationId: 'operation-1', text: 'same text' },
      effects: [],
    }]

    expect(reconcileOptimisticQueuedMessages(optimistic, [], timeline)).toEqual([])
  })

  it('does not merge distinct queued operations that have identical content', () => {
    const server = [{ id: 'operation-1', text: 'repeat', mode: 'queue' as const, createdAt: '2026-07-07T00:00:00.000Z' }]
    const optimistic = [{ id: 'operation-2', text: 'repeat', mode: 'queue' as const, createdAt: '2026-07-07T00:00:01.000Z' }]

    expect(mergeOptimisticQueuedMessages(server, optimistic).map((item) => item.id)).toEqual(['operation-1', 'operation-2'])
  })

  it('keeps an optimistic queue row while the host has not acknowledged it', () => {
    const optimistic = [{ id: 'operation-pending', text: 'still pending', mode: 'queue' as const, createdAt: '2026-07-07T00:00:00.000Z' }]

    expect(reconcileOptimisticQueuedMessages(optimistic, [], [])).toBe(optimistic)
  })

  it('immediately hides a delete-before-ACK row from optimistic and stale Host snapshots', () => {
    const deleted = { id: 'operation-deleted', text: 'remove me', mode: 'queue' as const, createdAt: '2026-07-07T00:00:00.000Z' }
    const kept = { id: 'operation-kept', text: 'keep me', mode: 'queue' as const, createdAt: '2026-07-07T00:00:01.000Z' }
    const tombstones = new Set([deleted.id])

    expect(mergeOptimisticQueuedMessages([], [deleted, kept], tombstones).map((item) => item.id)).toEqual([kept.id])
    expect(mergeOptimisticQueuedMessages([deleted, kept], [deleted, kept], tombstones).map((item) => item.id)).toEqual([kept.id])
  })

  it('rolls back only the failed delete tombstone', () => {
    const initial = new Set<string>()
    const deletingFirst = addQueuedMessageTombstone(initial, 'operation-1')
    const deletingBoth = addQueuedMessageTombstone(deletingFirst, 'operation-2')
    const afterFirstFails = removeQueuedMessageTombstone(deletingBoth, 'operation-1')

    expect([...afterFirstFails]).toEqual(['operation-2'])
    expect(initial.size).toBe(0)
  })

  it('acknowledges one operation without losing other concurrent queues', () => {
    const first = { id: 'operation-1', text: 'same text', mode: 'queue' as const, createdAt: '2026-07-07T00:00:00.000Z' }
    const second = { id: 'operation-2', text: 'same text', mode: 'queue' as const, createdAt: '2026-07-07T00:00:01.000Z' }
    const timeline: TimelineEntry[] = [{
      seq: 1,
      ts: '2026-07-07T00:00:02.000Z',
      event: { kind: 'user_message', operationId: first.id, text: first.text },
      effects: [],
    }]

    const reconciled = reconcileOptimisticQueuedMessages([first, second], [], timeline)
    expect(reconciled.map((item) => item.id)).toEqual([second.id])
    expect(mergeOptimisticQueuedMessages([], reconciled).map((item) => item.id)).toEqual([second.id])
  })
})

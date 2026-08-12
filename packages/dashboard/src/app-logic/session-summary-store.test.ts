import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@agent-kernel/shared'

import { SessionSummaryStore } from './session-summary-store.js'

const summary = (sessionId: string, eventCount = 0): SessionSummary => ({ sessionId, createdAt: 't0', eventCount })

describe('SessionSummaryStore', () => {
  it('updates one summary while preserving unrelated identities and ordering', () => {
    const store = new SessionSummaryStore()
    const first = summary('a')
    const second = summary('b')
    store.replace([first, second])

    const next = store.update('b', (current) => ({ ...current, eventCount: 1 }))

    expect(next.map((item) => item.sessionId)).toEqual(['a', 'b'])
    expect(next[0]).toBe(first)
    expect(next[1]?.eventCount).toBe(1)
  })

  it('removes missing sessions on an authoritative replacement', () => {
    const store = new SessionSummaryStore()
    store.replace([summary('a'), summary('b')])
    expect(store.replace([summary('b')]).map((item) => item.sessionId)).toEqual(['b'])
  })

  it('does not let an older throttled snapshot clear a newer running status', () => {
    const store = new SessionSummaryStore()
    store.replace([{ ...summary('a', 2), status: 'idle', lastEventAt: '2026-01-01T00:00:00Z' }])
    store.update('a', (current) => ({ ...current, status: 'thinking', lastEventAt: '2026-01-01T00:00:02Z' }))
    const next = store.replace([{ ...summary('a', 2), status: 'idle', lastEventAt: '2026-01-01T00:00:01Z' }])
    expect(next[0]?.status).toBe('thinking')
    expect(next[0]?.lastEventAt).toBe('2026-01-01T00:00:02Z')
  })
})

import { describe, expect, it } from 'vitest'

import type { SessionSummary } from '@agent-kernel/shared'

import { nextSessionSelection, sessionExists } from './app.js'

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
})

import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@agent-kernel/shared'

import { recentEmptyStateSessions } from './recent-empty-sessions.js'

const now = Date.parse('2026-09-28T06:00:00.000Z')

function session(sessionId: string, hoursAgo: number): SessionSummary {
  return {
    sessionId,
    agentRuntime: 'kernel',
    createdAt: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
    lastEventAt: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
    eventCount: 1,
  }
}

describe('recentEmptyStateSessions', () => {
  it('returns at most three non-current sessions updated within 48 hours', () => {
    expect(recentEmptyStateSessions([
      session('current', 1),
      session('newest', 2),
      session('second', 12),
      session('third', 48),
      session('fourth', 36),
      session('expired', 49),
    ], 'current', now).map((item) => item.sessionId)).toEqual(['newest', 'second', 'fourth'])
  })

  it('returns no placeholder records when nothing is recent', () => {
    expect(recentEmptyStateSessions([session('expired', 49)], null, now)).toEqual([])
  })
})

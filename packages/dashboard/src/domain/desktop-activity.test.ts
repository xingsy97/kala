import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@agent-kernel/shared'
import { DesktopActivityTracker } from './desktop-activity.js'

const summary = (sessionId: string, status: SessionSummary['status'], eventCount = 1, queuedCount = 0): SessionSummary => ({
  sessionId, agentRuntime: 'kernel', createdAt: '2026-09-15T00:00:00Z', status, eventCount, queuedCount,
})
const input = (sessions: SessionSummary[], options: Partial<Parameters<DesktopActivityTracker['update']>[0]> = {}) => ({
  sessions, activeSessionId: 'active', focused: true, visible: true, ready: true, now: 0, ...options,
})

describe('DesktopActivityTracker', () => {
  it('aggregates initial activity without historical notifications or child duplication', () => {
    const tracker = new DesktopActivityTracker()
    const result = tracker.update(input([summary('run', 'thinking'), summary('wait', 'awaiting_approval'), summary('old', 'done'), { ...summary('child', 'thinking'), parentSessionId: 'run' }], { subAgentSessionIds: new Set(['child']) }))
    expect(result.signals).toEqual([])
    expect(result.activity).toEqual({ status: 'attention', running: 1, attention: 1, completed: 0 })
  })
  it('includes user forks/continued copies even when parentSessionId is present', () => {
    const tracker = new DesktopActivityTracker()
    const fork = { ...summary('fork', 'thinking'), parentSessionId: 'original' }
    expect(tracker.update(input([fork])).activity.running).toBe(1)
    tracker.update(input([{ ...fork, status: 'done', eventCount: 2 }]))
    expect(tracker.update(input([{ ...fork, status: 'done', eventCount: 2 }], { now: 1500 })).signals[0]?.session.sessionId).toBe('fork')
  })
  it('quarantines fast child approval/completion until classified, then releases only actual user forks', () => {
    for (const terminal of ['awaiting_approval', 'done'] as const) {
      const tracker = new DesktopActivityTracker()
      const original = { ...summary('fork', 'thinking'), parentSessionId: 'parent' }
      const tool = { ...summary('tool', 'thinking'), parentSessionId: 'parent' }
      const pending = { unresolvedSessionIds: new Set(['fork', 'tool']) }
      tracker.update(input([original, tool], pending))
      const terminalSessions = [original, tool].map((session) => ({ ...session, status: terminal, eventCount: 2 }))
      expect(tracker.update(input(terminalSessions, { ...pending, now: 100 })).signals).toEqual([])
      expect(tracker.update(input(terminalSessions, { ...pending, now: 2000 })).signals).toEqual([])
      expect(tracker.nextDeadline).toBeNull()
      const classified = tracker.update(input(terminalSessions, { subAgentSessionIds: new Set(['tool']), now: 2001 }))
      expect(classified.signals.map((signal) => signal.session.sessionId)).toEqual(['fork'])
    }
  })
  it('only completes after a real end with no queue, debounce and unread until viewed', () => {
    const tracker = new DesktopActivityTracker()
    tracker.update(input([summary('other', 'thinking')]))
    expect(tracker.update(input([summary('other', 'done', 2, 1)])).signals).toEqual([])
    expect(tracker.nextDeadline).toBeNull()
    tracker.update(input([summary('other', 'done', 3)], { now: 100 }))
    expect(tracker.update(input([summary('other', 'done', 3)], { now: 1500 })).signals).toEqual([])
    const complete = tracker.update(input([summary('other', 'done', 3)], { now: 1600 }))
    expect(complete.signals).toHaveLength(1)
    expect(complete.activity.completed).toBe(1)
    expect(tracker.update(input([summary('other', 'done', 3)], { now: 2000 })).signals).toEqual([])
    expect(tracker.update(input([summary('other', 'done', 3)], { activeSessionId: 'other', now: 2100 })).activity.completed).toBe(0)
  })
  it('suppresses selected-session notifications only while the native window is visible and focused', () => {
    for (const [focused, visible, expected] of [[true, true, 0], [true, false, 1], [false, true, 1]] as const) {
      const tracker = new DesktopActivityTracker()
      tracker.update(input([summary('active', 'thinking')], { focused, visible }))
      const result = tracker.update(input([summary('active', 'awaiting_approval', 2)], { focused, visible }))
      expect(result.signals).toHaveLength(expected)
    }
  })
  it('cancels intermediate completions and does not replay reconnect/history refresh', () => {
    const tracker = new DesktopActivityTracker()
    tracker.update(input([summary('s', 'thinking')]))
    tracker.update(input([summary('s', 'done', 2)]))
    tracker.update(input([summary('s', 'thinking', 3)], { now: 500 }))
    expect(tracker.update(input([summary('s', 'thinking', 3)], { now: 2000 })).signals).toEqual([])
    tracker.update(input([summary('s', 'thinking', 3)], { ready: false }))
    expect(tracker.update(input([summary('s', 'done', 8)])).signals).toEqual([])
    expect(tracker.update(input([summary('s', 'thinking', 3)], { now: 6000 })).activity.running).toBe(0)
    expect(tracker.update(input([summary('s', 'done', 8)], { now: 9000 })).signals).toEqual([])
  })
})

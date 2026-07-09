import { describe, expect, it } from 'vitest'

import { decideInactiveSummaryNotification } from './notification-policy.js'

describe('notification-policy', () => {
  it('does not notify for focused sessions', () => {
    expect(decideInactiveSummaryNotification({ previousStatus: 'thinking', nextStatus: 'done', focusedSessionId: 's', eventSessionId: 's' })).toEqual({
      notify: false,
      level: 'none',
      reason: 'focused_session',
    })
  })

  it('does not notify for user initiated starts from idle', () => {
    expect(decideInactiveSummaryNotification({ previousStatus: 'idle', nextStatus: 'thinking', focusedSessionId: null, eventSessionId: 's', eventKind: 'user_message_sent' })).toMatchObject({
      notify: false,
      reason: 'user_initiated',
    })
  })

  it('notifies when a background running session completes', () => {
    expect(decideInactiveSummaryNotification({ previousStatus: 'thinking', nextStatus: 'done', focusedSessionId: 'active', eventSessionId: 's' })).toMatchObject({
      notify: true,
      reason: 'background_session_completed',
    })
  })

  it('notifies when a background running session needs approval', () => {
    expect(decideInactiveSummaryNotification({ previousStatus: 'executing_tools', nextStatus: 'awaiting_approval', focusedSessionId: 'active', eventSessionId: 's' })).toMatchObject({
      notify: true,
      reason: 'approval_required',
    })
  })

  it('does not notify for idle to thinking background starts without prior running state', () => {
    expect(decideInactiveSummaryNotification({ previousStatus: 'idle', nextStatus: 'thinking', focusedSessionId: 'active', eventSessionId: 's' })).toMatchObject({
      notify: false,
      reason: 'not_previously_running',
    })
  })
})

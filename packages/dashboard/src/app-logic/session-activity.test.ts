import { describe, expect, it } from 'vitest'

import { deriveSelectedSessionActivity } from './session-activity.js'

const base = {
  selectedSessionId: 'session-a',
  hydratedSessionId: 'session-a',
  summaryStatus: 'idle' as const,
  liveStatus: 'idle' as const,
  streamingActive: false,
  awaitingAck: false,
  compactRunning: false,
}

describe('deriveSelectedSessionActivity', () => {
  it.each([
    ['streaming', { streamingActive: true }],
    ['message acknowledgement', { awaitingAck: true }],
    ['compaction', { compactRunning: true }],
  ])('treats %s as one stable running indicator', (_label, override) => {
    const activity = deriveSelectedSessionActivity({ ...base, ...override })

    expect(activity.status).toBe('loading')
    expect(activity.indicatorStatus).toBe('loading')
    expect(activity.derived.isRunning).toBe(true)
    expect(activity.derived.canAcceptUserMessage).toBe(false)
  })

  it('derives approval from pending calls even before status catches up', () => {
    const activity = deriveSelectedSessionActivity({
      ...base,
      pendingCalls: [{ status: 'awaiting_approval' }],
    })

    expect(activity.derived.isWaitingForUser).toBe(true)
    expect(activity.derived.canAcceptUserMessage).toBe(false)
  })

  it('keeps failures terminal instead of masking them with a loading signal', () => {
    const activity = deriveSelectedSessionActivity({
      ...base,
      liveStatus: 'thinking',
      streamingActive: true,
      lastError: 'provider failed',
    })

    expect(activity.status).toBe('error')
    expect(activity.indicatorStatus).toBe('error')
    expect(activity.derived.isRunning).toBe(false)
    expect(activity.derived.canAcceptUserMessage).toBe(true)
  })

  it.each([
    ['idle', true],
    ['done', true],
    ['error', true],
    ['thinking', false],
    ['executing_tools', false],
    ['awaiting_approval', false],
  ] as const)('provides one message-gating decision for %s', (liveStatus, canAcceptUserMessage) => {
    const activity = deriveSelectedSessionActivity({ ...base, liveStatus })

    expect(activity.derived.canAcceptUserMessage).toBe(canAcceptUserMessage)
  })

  it('ignores stale errors, approvals, and transients from the previous session', () => {
    const activity = deriveSelectedSessionActivity({
      ...base,
      selectedSessionId: 'session-b',
      hydratedSessionId: 'session-a',
      summaryStatus: 'done',
      liveStatus: 'executing_tools',
      pendingCalls: [{ status: 'awaiting_approval' }],
      streamingActive: true,
      awaitingAck: true,
      compactRunning: true,
      lastError: 'old session failed',
    })

    expect(activity.usesLiveProjection).toBe(false)
    expect(activity.status).toBe('done')
    expect(activity.indicatorStatus).toBe('done')
    expect(activity.derived.canAcceptUserMessage).toBe(true)
  })
})

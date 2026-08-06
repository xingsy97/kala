import { describe, expect, it } from 'vitest'

import { evaluateSubAgentTimeout } from './agent-tool.js'

const limits = {
  idleTimeoutMs: 15 * 60_000,
  toolIdleTimeoutMs: 30 * 60_000,
  absoluteTimeoutMs: 60 * 60_000,
  gracePeriodMs: 3 * 60_000,
}

function initial() {
  return { last: { cursor: 0, status: 'thinking' as const }, lastActivityAt: 0 }
}

describe('evaluateSubAgentTimeout', () => {
  it('renews ordinary idle on cursor progress', () => {
    const result = evaluateSubAgentTimeout({ now: 14 * 60_000, startedAt: 0, observation: { cursor: 1, status: 'thinking' }, monitor: initial(), ...limits })
    expect(result.action).toBe('continue')
    expect(result.monitor.lastActivityAt).toBe(14 * 60_000)
    expect(result.monitor.graceStartedAt).toBeUndefined()
  })

  it('uses the longer tool idle threshold while a tool is active', () => {
    const before = evaluateSubAgentTimeout({ now: 20 * 60_000, startedAt: 0, observation: { cursor: 0, status: 'executing_tools' }, monitor: { last: { cursor: 0, status: 'executing_tools' }, lastActivityAt: 0 }, ...limits })
    expect(before.monitor.graceStartedAt).toBeUndefined()
    const after = evaluateSubAgentTimeout({ now: 30 * 60_000, startedAt: 0, observation: { cursor: 0, status: 'executing_tools' }, monitor: before.monitor, ...limits })
    expect(after.reason).toBe('tool-idle')
    expect(after.monitor.graceStartedAt).toBe(30 * 60_000)
  })

  it('honours a longer explicit tool deadline plus safety margin', () => {
    const observation = { cursor: 0, status: 'executing_tools' as const, requestedToolTimeoutMs: 45 * 60_000 }
    const monitor = { last: observation, lastActivityAt: 0 }
    const before = evaluateSubAgentTimeout({ now: 46 * 60_000, startedAt: 0, observation, monitor, ...limits, absoluteTimeoutMs: 120 * 60_000 })
    expect(before.monitor.graceStartedAt).toBeUndefined()
    const after = evaluateSubAgentTimeout({ now: 47 * 60_000, startedAt: 0, observation, monitor: before.monitor, ...limits, absoluteTimeoutMs: 120 * 60_000 })
    expect(after.reason).toBe('tool-idle')
  })

  it('starts grace for ordinary idle and cancels only after grace', () => {
    const grace = evaluateSubAgentTimeout({ now: 15 * 60_000, startedAt: 0, observation: { cursor: 0, status: 'thinking' }, monitor: initial(), ...limits })
    expect(grace.action).toBe('continue')
    expect(grace.reason).toBe('ordinary-idle')
    const cancelled = evaluateSubAgentTimeout({ now: 18 * 60_000, startedAt: 0, observation: { cursor: 0, status: 'thinking' }, monitor: grace.monitor, ...limits })
    expect(cancelled.action).toBe('cancel')
  })

  it('leaves idle grace when the child makes progress', () => {
    const grace = evaluateSubAgentTimeout({ now: 15 * 60_000, startedAt: 0, observation: { cursor: 0, status: 'thinking' }, monitor: initial(), ...limits })
    const recovered = evaluateSubAgentTimeout({ now: 16 * 60_000, startedAt: 0, observation: { cursor: 1, status: 'executing_tools' }, monitor: grace.monitor, ...limits })
    expect(recovered.action).toBe('continue')
    expect(recovered.monitor.graceStartedAt).toBeUndefined()
    expect(recovered.monitor.lastActivityAt).toBe(16 * 60_000)
  })

  it('enforces the configured assistant turn limit through grace', () => {
    const grace = evaluateSubAgentTimeout({ now: 5_000, startedAt: 0, observation: { cursor: 12, status: 'thinking' }, monitor: { last: { cursor: 11, status: 'thinking' }, lastActivityAt: 4_000 }, ...limits, turnCount: 50, maxTurns: 50 })
    expect(grace.reason).toBe('turn-limit')
    const progressed = evaluateSubAgentTimeout({ now: 60_000, startedAt: 0, observation: { cursor: 13, status: 'thinking' }, monitor: grace.monitor, ...limits, turnCount: 51, maxTurns: 50 })
    expect(progressed.monitor.graceStartedAt).toBe(5_000)
  })

  it('enforces the absolute deadline despite continued progress', () => {
    const grace = evaluateSubAgentTimeout({ now: 60 * 60_000, startedAt: 0, observation: { cursor: 20, status: 'thinking' }, monitor: { last: { cursor: 19, status: 'thinking' }, lastActivityAt: 59 * 60_000 }, ...limits })
    expect(grace.reason).toBe('absolute-deadline')
    const progressed = evaluateSubAgentTimeout({ now: 61 * 60_000, startedAt: 0, observation: { cursor: 21, status: 'executing_tools' }, monitor: grace.monitor, ...limits })
    expect(progressed.monitor.reason).toBe('absolute-deadline')
    expect(progressed.monitor.graceStartedAt).toBe(60 * 60_000)
    const cancelled = evaluateSubAgentTimeout({ now: 63 * 60_000, startedAt: 0, observation: { cursor: 22, status: 'thinking' }, monitor: progressed.monitor, ...limits })
    expect(cancelled.action).toBe('cancel')
  })
})

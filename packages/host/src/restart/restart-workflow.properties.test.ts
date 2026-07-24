import type { HostRestartAttempt } from '@agent-kernel/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { transitionRestartWorkflow, type RestartWorkflowEvent, type RestartWorkflowState } from './restart-workflow.js'

function attempt(attemptId: string): HostRestartAttempt {
  return {
    attemptId, phase: 'requested', mode: 'checkpoint', reason: 'manual', oldPid: 1,
    requestedAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z', sessions: [],
  }
}

const staleEventArb: fc.Arbitrary<RestartWorkflowEvent> = fc.constantFrom(
  { kind: 'drain_started' as const, attemptId: 'stale', updatedAt: '1', sessions: [] },
  { kind: 'checkpoints_reached' as const, attemptId: 'stale', updatedAt: '1', sessions: [] },
  { kind: 'restart_started' as const, attemptId: 'stale', updatedAt: '1', sessions: [] },
  { kind: 'abort' as const, attemptId: 'stale', updatedAt: '1', sessions: [], error: 'timeout' },
  { kind: 'fail' as const, attemptId: 'stale', updatedAt: '1', sessions: [], error: 'failed' },
)

describe('restart workflow properties', () => {
  it('arbitrary stale attempt events cannot mutate the active attempt', () => {
    fc.assert(fc.property(fc.array(staleEventArb, { maxLength: 100 }), (events) => {
      const initial: RestartWorkflowState = { current: { ...attempt('active'), phase: 'draining' }, last: attempt('older') }
      let state = initial
      for (const event of events) {
        const result = transitionRestartWorkflow(state, event)
        expect(result.commands).toEqual([])
        state = result.state
      }
      expect(state).toBe(initial)
    }), { numRuns: 150 })
  })
})

import type { HostRestartAttempt } from '@agent-kernel/shared'
import { describe, expect, it } from 'vitest'

import { transitionRestartWorkflow, type RestartWorkflowState } from './restart-workflow.js'

function attempt(attemptId: string, mode: HostRestartAttempt['mode'] = 'checkpoint'): HostRestartAttempt {
  return {
    attemptId,
    phase: 'requested',
    mode,
    reason: 'manual',
    requestedAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    oldPid: 1,
    timeoutMs: 100,
    sessions: [{
      sessionId: 'session-1',
      cursor: 2,
      initialStatus: 'thinking',
      checkpointStatus: 'waiting_llm',
      resumeAction: 'continue_turn',
    }],
  }
}

const empty: RestartWorkflowState = { current: null, last: null }
const update = { updatedAt: '2026-07-24T00:00:01.000Z', sessions: attempt('x').sessions }

describe('restart workflow', () => {
  it('moves a checkpoint request through drain and restart commands', () => {
    const requested = transitionRestartWorkflow(empty, { kind: 'request', attempt: attempt('a') })
    expect(requested.state.current?.phase).toBe('requested')
    expect(requested.commands.map((command) => command.kind)).toEqual(['publish', 'begin_drain'])

    const draining = transitionRestartWorkflow(requested.state, { kind: 'drain_started', attemptId: 'a', ...update })
    expect(draining.state.current?.phase).toBe('draining')
    expect(draining.commands.map((command) => command.kind)).toEqual(['publish', 'wait_for_checkpoints', 'schedule_timeout'])

    const checkpoint = transitionRestartWorkflow(draining.state, { kind: 'checkpoints_reached', attemptId: 'a', ...update })
    expect(checkpoint.state.current?.phase).toBe('checkpoint_reached')
    expect(checkpoint.commands.map((command) => command.kind)).toEqual(['clear_timeout', 'publish', 'start_restart'])

    const restarting = transitionRestartWorkflow(checkpoint.state, { kind: 'restart_started', attemptId: 'a', ...update })
    expect(restarting.state.current?.phase).toBe('restarting')
    expect(restarting.commands.map((command) => command.kind)).toEqual(['clear_timeout', 'publish', 'close_and_spawn'])
  })

  it('starts force requests without entering drain', () => {
    const requested = transitionRestartWorkflow(empty, { kind: 'request', attempt: attempt('force', 'force') })
    expect(requested.commands.map((command) => command.kind)).toEqual(['publish', 'start_restart'])
  })

  it('ignores stale attempt events', () => {
    const current: RestartWorkflowState = { current: { ...attempt('new'), phase: 'draining' }, last: attempt('old') }
    const staleTimeout = transitionRestartWorkflow(current, {
      kind: 'abort', attemptId: 'old', error: 'timeout', ...update,
    })
    const staleCheckpoint = transitionRestartWorkflow(current, {
      kind: 'checkpoints_reached', attemptId: 'old', ...update,
    })

    expect(staleTimeout).toEqual({ state: current, commands: [] })
    expect(staleCheckpoint).toEqual({ state: current, commands: [] })
  })

  it('keeps the active attempt when another request arrives', () => {
    const current: RestartWorkflowState = { current: { ...attempt('active'), phase: 'draining' }, last: null }
    expect(transitionRestartWorkflow(current, { kind: 'request', attempt: attempt('new') }))
      .toEqual({ state: current, commands: [] })
  })

  it('terminates once and ignores late checkpoint completion', () => {
    const current: RestartWorkflowState = { current: { ...attempt('a'), phase: 'draining' }, last: null }
    const aborted = transitionRestartWorkflow(current, {
      kind: 'abort', attemptId: 'a', error: 'cancelled', ...update,
    })
    expect(aborted.state.current).toBeNull()
    expect(aborted.state.last).toMatchObject({ phase: 'aborted', error: 'cancelled' })
    expect(aborted.commands.map((command) => command.kind)).toEqual(['clear_timeout', 'end_drain', 'publish'])

    expect(transitionRestartWorkflow(aborted.state, {
      kind: 'checkpoints_reached', attemptId: 'a', ...update,
    })).toEqual({ state: aborted.state, commands: [] })
  })
})

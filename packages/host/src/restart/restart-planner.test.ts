import { describe, expect, it } from 'vitest'

import type { LoopDrainSessionSnapshot } from '../loop-types.js'
import {
  buildRestartSessionPlans,
  checkpointStatusFor,
  planRestartSession,
  resumeActionFor,
  type RestartPlanSessionRecord,
} from './restart-planner.js'

function record(overrides: Partial<RestartPlanSessionRecord> = {}): RestartPlanSessionRecord {
  return {
    sessionId: 'sess-1',
    label: 'Session 1',
    workspaceId: 'ws-1',
    workspaceName: 'Workspace 1',
    state: { status: 'idle', cursor: 5 },
    ...overrides,
  }
}

function snapshot(overrides: Partial<LoopDrainSessionSnapshot> = {}): LoopDrainSessionSnapshot {
  return {
    sessionId: 'sess-1',
    status: 'idle',
    safe: true,
    waiting: 'none',
    pendingCalls: [],
    ...overrides,
  }
}

describe('restart planner', () => {
  it('plans session metadata, cursor fallback, and checkpoint status', () => {
    expect(planRestartSession({
      record: record(),
      snapshot: snapshot({ cursor: 9, safe: false, waiting: 'tool', status: 'executing_tools' }),
      mode: 'checkpoint',
    })).toEqual({
      sessionId: 'sess-1',
      cursor: 9,
      initialStatus: 'idle',
      checkpointStatus: 'waiting_tool',
      resumeAction: 'continue_turn',
      label: 'Session 1',
      workspaceId: 'ws-1',
      workspaceName: 'Workspace 1',
    })

    expect(planRestartSession({
      record: record({ label: undefined, workspaceName: undefined }),
      snapshot: snapshot({ cursor: undefined }),
      mode: 'checkpoint',
    })).toMatchObject({ cursor: 5 })
  })

  it('maps drain waiting state to checkpoint status', () => {
    expect(checkpointStatusFor({ safe: true, waiting: 'none' })).toBe('safe')
    expect(checkpointStatusFor({ safe: true, waiting: 'tool' })).toBe('already_safe')
    expect(checkpointStatusFor({ safe: false, waiting: 'llm' })).toBe('waiting_llm')
    expect(checkpointStatusFor({ safe: false, waiting: 'tool' })).toBe('waiting_tool')
    expect(checkpointStatusFor({ safe: false, waiting: 'idle' })).toBe('waiting_idle')
    expect(checkpointStatusFor({ safe: false, waiting: 'none' })).toBe('safe')
  })

  it('maps restart resume actions from session status and mode', () => {
    expect(resumeActionFor({ status: 'thinking' }, 'checkpoint')).toBe('continue_turn')
    expect(resumeActionFor({ status: 'executing_tools' }, 'checkpoint')).toBe('continue_turn')
    expect(resumeActionFor({ status: 'awaiting_approval' }, 'checkpoint')).toBe('wait_for_approval')
    expect(resumeActionFor({ status: 'idle' }, 'checkpoint')).toBe('none')
    expect(resumeActionFor({ status: 'done' }, 'checkpoint')).toBe('none')
    expect(resumeActionFor({ status: 'missing' }, 'checkpoint')).toBe('none')
    expect(resumeActionFor({ status: 'thinking' }, 'when_idle')).toBe('none')
  })

  it('builds plans using a snapshot lookup per record', () => {
    const plans = buildRestartSessionPlans({
      records: [
        record({ sessionId: 'sess-a', state: { status: 'thinking', cursor: 1 } }),
      ],
      mode: 'checkpoint',
      snapshotFor: (sessionId) => snapshot({ sessionId, status: 'thinking', safe: false, waiting: 'llm' }),
    })

    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      sessionId: 'sess-a',
      checkpointStatus: 'waiting_llm',
      resumeAction: 'continue_turn',
    })
  })
})

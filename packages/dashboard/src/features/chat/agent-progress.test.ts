import { describe, expect, it } from 'vitest'
import type { AgentState } from '@agent-kernel/kernel'
import { deriveAgentProgress } from './agent-progress.js'

function state(status: AgentState['status']): AgentState {
  return { sessionId: 's', status, messages: [], pendingCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, cursor: 0, approvalMode: 'auto', cwd: '/' }
}

describe('deriveAgentProgress', () => {
  it('does not expose lifetime tool-call counts as user progress', () => {
    const timeline = Array.from({ length: 4_845 }, (_, i) => ({
      seq: i + 1,
      ts: new Date(1000 + i).toISOString(),
      event: { kind: 'cancel' as const },
      effects: [{ kind: 'call_tool' as const, callId: `${i}`, name: 'x', input: {} }],
    }))
    expect(deriveAgentProgress(state('executing_tools'), timeline)).toEqual({ phase: 'tools', label: 'Working' })
  })

  it('does not infer a stalled state from elapsed time alone', () => {
    const timeline = [{ seq: 1, ts: new Date(0).toISOString(), event: { kind: 'cancel' as const }, effects: [] }]
    expect(deriveAgentProgress(state('thinking'), timeline)).toEqual({ phase: 'thinking', label: 'Preparing the next step' })
  })
})

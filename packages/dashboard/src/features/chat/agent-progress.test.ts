import { describe, expect, it } from 'vitest'

import type { AgentState } from '@agent-kernel/kernel'

import { deriveAgentProgress } from './agent-progress.js'

function state(status: AgentState['status'], pendingCalls: AgentState['pendingCalls'] = []): AgentState {
  return { sessionId: 's', status, messages: [], pendingCalls, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, cursor: 0, approvalMode: 'auto', cwd: '/' } as AgentState
}

function toolCall(seq: number, callId: string, intention: string) {
  return {
    seq, ts: new Date(seq).toISOString(), effects: [],
    event: {
      kind: 'llm_response' as const,
      message: { role: 'assistant' as const, content: [{ type: 'tool_call' as const, callId, name: 'read', input: {}, intent: intention }] },
    },
  }
}

function toolResult(seq: number, callId: string, ok: boolean) {
  return { seq, ts: new Date(seq).toISOString(), effects: [], event: { kind: 'tool_result' as const, callId, ok, content: ok ? 'ok' : 'failed' } }
}

function dispatchedToolCall(seq: number, callId: string, intention: string) {
  return { ...toolCall(seq, callId, intention), effects: [{ kind: 'call_tool' as const, callId, name: 'read', input: {} }] }
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
    expect(deriveAgentProgress(state('thinking'), timeline)).toEqual({ phase: 'thinking', label: 'Thinking' })
  })

  it('recovers thinking elapsed start from the current user turn', () => {
    const timeline = [
      { seq: 1, ts: new Date(1000).toISOString(), event: { kind: 'user_message' as const, text: 'start work' }, effects: [] },
      { seq: 2, ts: new Date(1500).toISOString(), event: { kind: 'llm_response' as const, message: { role: 'assistant' as const, content: [] } }, effects: [] },
    ]
    expect(deriveAgentProgress(state('thinking'), timeline)).toEqual({
      phase: 'thinking',
      label: 'Thinking',
      startedAt: Date.parse(new Date(1000).toISOString()),
    })
  })

  it('matches the running pending call instead of using the latest lifetime intention', () => {
    const timeline = [
      toolCall(1, 'running', 'Identify why the activity surfaces duplicate the current business objective.'),
      toolCall(2, 'newer-history', 'This newer historical call must not replace the active objective.'),
    ]
    expect(deriveAgentProgress(state('executing_tools', [{ callId: 'running', name: 'read', input: {}, status: 'dispatched' }]), timeline)).toEqual({
      phase: 'tools',
      label: 'Identify why the activity surfaces duplicate the current business objective.',
      intention: 'Identify why the activity surfaces duplicate the current business objective.',
      callId: 'running',
      outcome: 'running',
    })
  })

  it('shows a successful previous step while the agent plans what follows', () => {
    const timeline = [dispatchedToolCall(1, 'c1', 'Remove duplicate Intention copy while preserving historical Tool context.'), toolResult(2, 'c1', true)]
    expect(deriveAgentProgress(state('thinking'), timeline)).toEqual({
      phase: 'thinking',
      label: 'Remove duplicate Intention copy while preserving historical Tool context.',
      intention: 'Remove duplicate Intention copy while preserving historical Tool context.',
      callId: 'c1',
      outcome: 'succeeded',
      durationMs: 1,
    })
  })

  it('distinguishes a failed previous step from completion', () => {
    const timeline = [toolCall(1, 'c1', 'Verify the responsive Tool activity layout against the production breakpoints.'), toolResult(2, 'c1', false)]
    expect(deriveAgentProgress(state('thinking'), timeline)).toMatchObject({
      label: 'Verify the responsive Tool activity layout against the production breakpoints.',
      callId: 'c1',
      outcome: 'failed',
    })
  })

  it('projects the pending approval Intention', () => {
    const timeline = [toolCall(1, 'c1', 'Apply the approved presentation contract without changing Tool execution semantics.')]
    expect(deriveAgentProgress(state('awaiting_approval', [{ callId: 'c1', name: 'write', input: {}, status: 'awaiting_approval' }]), timeline)).toMatchObject({
      label: 'Apply the approved presentation contract without changing Tool execution semantics.',
      callId: 'c1',
      outcome: 'approval',
    })
  })

  it('uses Working instead of lifecycle prose when approval has no Intention', () => {
    expect(deriveAgentProgress(state('awaiting_approval', [{ callId: 'legacy', name: 'write', input: {}, status: 'awaiting_approval' }]), [])).toEqual({
      phase: 'approval',
      label: 'Working',
    })
  })

  it('projects the actual dispatched timestamp for a running Tool', () => {
    const timeline = [dispatchedToolCall(10, 'c1', 'Verify the active Tool without inventing a lifecycle sentence.')]
    expect(deriveAgentProgress(state('executing_tools', [{ callId: 'c1', name: 'read', input: {}, status: 'dispatched' }]), timeline)).toMatchObject({
      startedAt: Date.parse(new Date(10).toISOString()),
    })
  })

  it('selects the latest matching dispatched call when tools run concurrently', () => {
    const timeline = [
      toolCall(1, 'c1', 'Inspect the projection boundary for stale activity state.'),
      toolCall(2, 'c2', 'Verify concurrent Tool status remains associated with the correct business objective.'),
    ]
    const pending = [
      { callId: 'c1', name: 'read', input: {}, status: 'dispatched' as const },
      { callId: 'c2', name: 'grep', input: {}, status: 'dispatched' as const },
    ]
    expect(deriveAgentProgress(state('executing_tools', pending), timeline)).toMatchObject({ callId: 'c2', outcome: 'running' })
  })

  it('does not carry a settled Intention across a newer user-message boundary', () => {
    const timeline = [
      toolCall(1, 'old', 'Complete the previous user request without leaking Tool parameters.'),
      toolResult(2, 'old', true),
      { seq: 3, ts: new Date(3).toISOString(), effects: [], event: { kind: 'user_message' as const, text: 'start a different task' } },
    ]
    expect(deriveAgentProgress(state('thinking'), timeline)).toEqual({ phase: 'thinking', label: 'Thinking', startedAt: Date.parse(new Date(3).toISOString()) })
  })

  it('ignores a result that has no persisted model-authored Intention', () => {
    const timeline = [toolResult(1, 'legacy', true)]
    expect(deriveAgentProgress(state('thinking'), timeline)).toEqual({ phase: 'thinking', label: 'Thinking' })
  })

  it.each(['idle', 'done', 'error'] as const)('does not project stale Tool Intention in %s state', (status) => {
    const timeline = [toolCall(1, 'c1', 'Keep completed Tool context out of resting activity surfaces.'), toolResult(2, 'c1', true)]
    const result = deriveAgentProgress(state(status), timeline)
    expect(result.intention).toBeUndefined()
    expect(result.callId).toBeUndefined()
  })
})

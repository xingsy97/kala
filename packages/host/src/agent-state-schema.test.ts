import { createInitialState } from '@agent-kernel/kernel'
import { describe, expect, it } from 'vitest'

import { AgentStateSchema } from '../../shared/src/schema/kernel.js'

describe('AgentStateSchema phase contract', () => {
  it('parses each valid discriminated phase', () => {
    const initial = createInitialState({ sessionId: 'schema', systemPrompt: 'system' })
    const phases = [
      initial,
      { ...initial, status: 'thinking', pendingCalls: [] },
      { ...initial, status: 'done', pendingCalls: [] },
      { ...initial, status: 'awaiting_approval', pendingCalls: [{ callId: 'a', name: 'write', input: {}, status: 'awaiting_approval' }] },
      { ...initial, status: 'executing_tools', pendingCalls: [{ callId: 'b', name: 'read', input: {}, status: 'dispatched' }] },
      { ...initial, status: 'error', pendingCalls: [], error: 'provider failed' },
    ]

    for (const phase of phases) expect(AgentStateSchema.safeParse(phase).success).toBe(true)
  })

  it('rejects phase data that cannot be represented by AgentState', () => {
    const initial = createInitialState({ sessionId: 'schema' })
    expect(AgentStateSchema.safeParse({ ...initial, status: 'idle', pendingCalls: [{ callId: 'x', name: 'read', input: {}, status: 'dispatched' }] }).success).toBe(false)
    expect(AgentStateSchema.safeParse({ ...initial, status: 'error', pendingCalls: [], error: '  ' }).success).toBe(false)
    expect(AgentStateSchema.safeParse({ ...initial, status: 'error', pendingCalls: [] }).success).toBe(false)
  })
})

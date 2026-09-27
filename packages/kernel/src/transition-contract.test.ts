import { describe, expect, it } from 'vitest'

import {
  agentEventKinds,
  agentStatuses,
  createConfig,
  createInitialState,
  legalTransitions,
  stateInvariantViolation,
  step,
  transitionContract,
} from './index.js'
import type { AgentEvent, AgentState, AgentStatus } from './types.js'

type EventFixtures = {
  [K in AgentEvent['kind']]: Extract<AgentEvent, { kind: K }>
}

const config = createConfig({
  tools: [
    { name: 'read', description: 'read', inputSchema: { type: 'object' }, requiresApproval: false },
    { name: 'write', description: 'write', inputSchema: { type: 'object' }, requiresApproval: true },
  ],
  systemPrompt: 'system',
})

const events: EventFixtures = {
  user_message: { kind: 'user_message', text: 'hello' },
  llm_response: {
    kind: 'llm_response',
    message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
  },
  llm_error: { kind: 'llm_error', error: 'provider failed' },
  user_approve: { kind: 'user_approve', callId: 'call-1' },
  user_reject: { kind: 'user_reject', callId: 'call-1', reason: 'not now' },
  tool_result: { kind: 'tool_result', callId: 'call-1', ok: true, content: 'result' },
  cancel: { kind: 'cancel' },
  clear: { kind: 'clear' },
  messages_replaced: {
    kind: 'messages_replaced',
    reason: 'manual_rewrite',
    replaceRange: { start: 0, end: 0 },
    replacementMessages: [],
  },
  approval_mode_changed: { kind: 'approval_mode_changed', mode: 'ask' },
  cwd_changed: { kind: 'cwd_changed', cwd: '/workspace' },
}

function stateFor(status: AgentStatus): AgentState {
  const base = createInitialState({ sessionId: `matrix-${status}`, systemPrompt: 'system' })
  switch (status) {
    case 'idle':
      return base
    case 'thinking':
      return { ...base, status, pendingCalls: [] }
    case 'awaiting_approval':
      return {
        ...base,
        status,
        pendingCalls: [{
          callId: 'call-1',
          name: 'write',
          input: { path: 'output.txt' },
          status: 'awaiting_approval',
        }],
      }
    case 'executing_tools':
      return {
        ...base,
        status,
        pendingCalls: [{
          callId: 'call-1',
          name: 'read',
          input: { path: 'input.txt' },
          status: 'dispatched',
        }],
      }
    case 'done':
      return { ...base, status, pendingCalls: [] }
    case 'error':
      return { ...base, status, pendingCalls: [], error: 'provider failed' }
  }
}

describe('enumerable transition contract', () => {
  it('contains every status and event kind exactly once', () => {
    expect(Object.keys(transitionContract)).toEqual(agentStatuses)
    for (const status of agentStatuses) {
      expect(Object.keys(transitionContract[status])).toEqual(agentEventKinds)
      expect(legalTransitions[status]).toEqual(
        agentEventKinds.filter((kind) => transitionContract[status][kind] === 'handled'),
      )
    }
  })

  it('classifies and executes every status/event-kind cell', () => {
    for (const status of agentStatuses) {
      for (const kind of agentEventKinds) {
        const state = stateFor(status)
        const event = events[kind]
        const stateBefore = structuredClone(state)
        const eventBefore = structuredClone(event)
        const configBefore = structuredClone(config)

        const first = step(state, event, config)
        const second = step(state, event, config)

        expect(first, `${status} + ${kind} must be deterministic`).toEqual(second)
        expect(state, `${status} + ${kind} mutated state`).toEqual(stateBefore)
        expect(event, `${status} + ${kind} mutated event`).toEqual(eventBefore)
        expect(config, `${status} + ${kind} mutated config`).toEqual(configBefore)
        expect(first.next).not.toBe(state)
        expect(first.next.cursor).toBe(state.cursor + 1)
        expect(first.transition).toMatchObject({ from: status, event: kind })
        expect(stateInvariantViolation(first.next)).toBeUndefined()

        if (transitionContract[status][kind] === 'ignored') {
          expect(first.transition.outcome, `${status} + ${kind} must be ignored`).toBe('ignored')
          expect(first.effects).toEqual([])
        } else {
          expect(first.transition.outcome, `${status} + ${kind} must reach its handler`).not.toBe('ignored')
        }
      }
    }
  })
})

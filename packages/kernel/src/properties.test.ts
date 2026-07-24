import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createConfig, createInitialState, fold, fork, stateInvariantViolation, step } from './index.js'
import type { AgentEvent, Message } from './types.js'

const config = createConfig({
  systemPrompt: 'system',
  tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' }, requiresApproval: false }],
})

const short = fc.string({ maxLength: 24 })
const callId = fc.integer({ min: 0, max: 8 }).map((value) => `call-${value}`)
const message = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })
const eventArb: fc.Arbitrary<AgentEvent> = fc.oneof(
  short.map((text) => ({ kind: 'user_message' as const, text })),
  short.map((text) => ({ kind: 'llm_response' as const, message: message(text) })),
  callId.map((id) => ({
    kind: 'llm_response' as const,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'tool_call' as const, callId: id, name: 'read', input: { path: '/tmp/input' } }],
    },
  })),
  short.map((error) => ({ kind: 'llm_error' as const, error })),
  callId.map((id) => ({ kind: 'user_approve' as const, callId: id })),
  fc.tuple(callId, short).map(([id, reason]) => ({ kind: 'user_reject' as const, callId: id, reason })),
  fc.tuple(callId, fc.boolean(), short).map(([id, ok, content]) => ({ kind: 'tool_result' as const, callId: id, ok, content })),
  fc.constant({ kind: 'cancel' as const }),
  fc.constant({ kind: 'clear' as const }),
  fc.constantFrom('auto' as const, 'ask' as const, 'deny' as const, 'allow_all' as const)
    .map((mode) => ({ kind: 'approval_mode_changed' as const, mode })),
  short.map((cwd) => ({ kind: 'cwd_changed' as const, cwd })),
  fc.record({ start: fc.integer({ min: -2, max: 8 }), end: fc.integer({ min: -2, max: 8 }) })
    .map((replaceRange) => ({ kind: 'messages_replaced' as const, reason: 'manual_rewrite' as const, replaceRange, replacementMessages: [] })),
)
const eventsArb = fc.array(eventArb, { maxLength: 60 })

describe('kernel state machine properties', () => {
  it('never throws, advances once per event, and preserves invariants', () => {
    fc.assert(fc.property(eventsArb, (events) => {
      let state = createInitialState({ sessionId: 'property', systemPrompt: 'system' })
      for (const event of events) {
        const previousCursor = state.cursor
        state = step(state, event, config).next
        expect(state.cursor).toBe(previousCursor + 1)
        expect(stateInvariantViolation(state)).toBeUndefined()
      }
    }), { numRuns: 200 })
  })

  it('fold equals iterative step for arbitrary event sequences', () => {
    fc.assert(fc.property(eventsArb, (events) => {
      const initial = createInitialState({ sessionId: 'property', systemPrompt: 'system' })
      let iterative = initial
      for (const event of events) iterative = step(iterative, event, config).next
      expect(fold(initial, events, config)).toEqual(iterative)
    }), { numRuns: 150 })
  })

  it('fork equals folding the retained prefix followed by the new suffix', () => {
    fc.assert(fc.property(eventsArb, eventsArb, fc.nat(80), (original, suffix, cursor) => {
      const initial = createInitialState({ sessionId: 'property', systemPrompt: 'system' })
      expect(fork(initial, original, cursor, suffix, config))
        .toEqual(fold(initial, [...original.slice(0, cursor), ...suffix], config))
    }), { numRuns: 100 })
  })
})

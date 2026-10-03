import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createConfig, createInitialState, fold, fork, stateInvariantViolation, step } from './index.js'
import type { AgentEvent, AgentState, ApprovalMode, Message } from './types.js'

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
  short.map((prompt) => ({ kind: 'system_prompt_changed' as const, prompt })),
  fc.record({ start: fc.integer({ min: -2, max: 8 }), end: fc.integer({ min: -2, max: 8 }) })
    .map((replaceRange) => ({ kind: 'messages_replaced' as const, reason: 'manual_rewrite' as const, replaceRange, replacementMessages: [] })),
)
const eventsArb = fc.array(eventArb, { maxLength: 60 })

type TraceAction =
  | 'user_message'
  | 'llm_plain'
  | 'llm_error'
  | 'llm_safe_tool'
  | 'llm_guarded_tool'
  | 'llm_mixed_tools'
  | 'approve'
  | 'reject'
  | 'tool_result'
  | 'stale_tool_result'
  | 'cancel'
  | 'clear'
  | 'change_mode'

const traceActionsArb = fc.array(
  fc.constantFrom<TraceAction>(
    'user_message',
    'llm_plain',
    'llm_error',
    'llm_safe_tool',
    'llm_guarded_tool',
    'llm_mixed_tools',
    'approve',
    'reject',
    'tool_result',
    'stale_tool_result',
    'cancel',
    'clear',
    'change_mode',
  ),
  { minLength: 1, maxLength: 80 },
)

const traceConfig = createConfig({
  tools: [
    { name: 'read', description: 'read', inputSchema: { type: 'object' }, requiresApproval: false },
    { name: 'write', description: 'write', inputSchema: { type: 'object' }, requiresApproval: true },
  ],
})

function eventForAction(
  action: TraceAction,
  state: AgentState,
  index: number,
): AgentEvent {
  const awaiting = state.pendingCalls.find((pending) => pending.status === 'awaiting_approval')
  const dispatched = state.pendingCalls.find((pending) => pending.status === 'dispatched')
  const callId = `trace-${index}`
  switch (action) {
    case 'user_message':
      return { kind: 'user_message', text: `turn-${index}` }
    case 'llm_plain':
      return { kind: 'llm_response', message: message(`answer-${index}`) }
    case 'llm_error':
      return { kind: 'llm_error', error: `error-${index}` }
    case 'llm_safe_tool':
      return {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', callId, name: 'read', input: { path: `input-${index}` } }],
        },
      }
    case 'llm_guarded_tool':
      return {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', callId, name: 'write', input: { path: `output-${index}` } }],
        },
      }
    case 'llm_mixed_tools':
      return {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_call', callId: `${callId}-read`, name: 'read', input: { path: `input-${index}` } },
            { type: 'tool_call', callId: `${callId}-write`, name: 'write', input: { path: `output-${index}` } },
          ],
        },
      }
    case 'approve':
      return { kind: 'user_approve', callId: awaiting?.callId ?? `missing-${index}` }
    case 'reject':
      return { kind: 'user_reject', callId: awaiting?.callId ?? `missing-${index}`, reason: 'rejected' }
    case 'tool_result':
      return { kind: 'tool_result', callId: dispatched?.callId ?? `missing-${index}`, ok: true, content: 'ok' }
    case 'stale_tool_result':
      return { kind: 'tool_result', callId: `stale-${index}`, ok: true, content: 'late' }
    case 'cancel':
      return { kind: 'cancel' }
    case 'clear':
      return { kind: 'clear' }
    case 'change_mode': {
      const modes: ApprovalMode[] = ['auto', 'ask', 'deny', 'allow_all']
      return { kind: 'approval_mode_changed', mode: modes[index % modes.length]! }
    }
  }
}

describe('kernel state machine properties', () => {
  it('never throws, advances once per event, and preserves invariants', () => {
    fc.assert(fc.property(eventsArb, (events) => {
      let state = createInitialState({ sessionId: 'property', systemPrompt: 'system' })
      for (const event of events) {
        const previousCursor = state.cursor
        const stateBefore = structuredClone(state)
        const eventBefore = structuredClone(event)
        const configBefore = structuredClone(config)
        const first = step(state, event, config)
        const second = step(state, event, config)
        expect(first).toEqual(second)
        expect(state).toEqual(stateBefore)
        expect(event).toEqual(eventBefore)
        expect(config).toEqual(configBefore)
        state = first.next
        expect(state.cursor).toBe(previousCursor + 1)
        expect(stateInvariantViolation(state)).toBeUndefined()
      }
    }), { numRuns: 200 })
  })

  it('preserves approval and result correlation across state-aware traces', () => {
    fc.assert(fc.property(traceActionsArb, (actions) => {
      let state = createInitialState({ sessionId: 'model-trace' })
      const dispatchedCallIds = new Set<string>()

      actions.forEach((action, index) => {
        const previous = state
        const event = eventForAction(action, previous, index)
        const result = step(previous, event, traceConfig)

        expect(stateInvariantViolation(result.next)).toBeUndefined()
        expect(result.next.cursor).toBe(previous.cursor + 1)

        for (const effect of result.effects) {
          if (effect.kind === 'request_approval') {
            expect(result.next.pendingCalls).toContainEqual(
              expect.objectContaining({ callId: effect.callId, status: 'awaiting_approval' }),
            )
            expect(result.effects).not.toContainEqual(
              expect.objectContaining({ kind: 'call_tool', callId: effect.callId }),
            )
          }
          if (effect.kind !== 'call_tool') continue

          expect(dispatchedCallIds.has(effect.callId)).toBe(false)
          dispatchedCallIds.add(effect.callId)
          expect(result.next.pendingCalls).toContainEqual(
            expect.objectContaining({ callId: effect.callId, status: 'dispatched' }),
          )

          if (previous.status === 'awaiting_approval') {
            expect(event).toMatchObject({ kind: 'user_approve', callId: effect.callId })
          } else {
            expect(previous.status).toBe('thinking')
            expect(event.kind).toBe('llm_response')
            const schema = traceConfig.tools.find((tool) => tool.name === effect.name)
            expect(schema?.requiresApproval === false || previous.approvalMode === 'allow_all').toBe(true)
          }
        }

        if (event.kind === 'tool_result') {
          const matching = previous.pendingCalls.find(
            (pending) => pending.callId === event.callId && pending.status === 'dispatched',
          )
          if (result.transition.outcome === 'applied') {
            expect(matching).toBeDefined()
            expect(result.next.pendingCalls.some((pending) => pending.callId === event.callId)).toBe(false)
          } else {
            expect(matching).toBeUndefined()
            expect(result.effects).toEqual([])
            expect(result.next).toEqual({ ...previous, cursor: previous.cursor + 1 })
          }
        }

        state = result.next
      })
    }), { numRuns: 300 })
  })

  it('terminal/resting states never retain pending calls under arbitrary events', () => {
    fc.assert(fc.property(eventsArb, (events) => {
      let state = createInitialState({ sessionId: 'terminal-property', systemPrompt: 'system' })
      for (const event of events) {
        state = step(state, event, config).next
        if (state.status === 'idle' || state.status === 'thinking' || state.status === 'done' || state.status === 'error') {
          expect(state.pendingCalls).toEqual([])
        }
        const settled = new Set<string>()
        for (const message of state.messages) {
          for (const content of message.content) if (content.type === 'tool_result') settled.add(content.callId)
        }
        for (const pending of state.pendingCalls) expect(settled.has(pending.callId)).toBe(false)
      }
    }), { numRuns: 300 })
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

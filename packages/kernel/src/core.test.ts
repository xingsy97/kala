import { describe, expect, it } from 'vitest'
import {
  createConfig,
  createInitialState,
  fold,
  foldWithTrace,
  fork,
  step,
} from './index.js'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Message,
  ToolSchema,
} from './types.js'

// ============================================================================
// Fixtures
// ============================================================================

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file',
  inputSchema: { type: 'object' },
  requiresApproval: false,
}
const WRITE: ToolSchema = {
  name: 'write',
  description: 'Write a file',
  inputSchema: { type: 'object' },
  requiresApproval: true,
}
const TOOLS = [READ, WRITE]

const CONFIG: AgentConfig = createConfig({
  tools: TOOLS,
  systemPrompt: 'you are a coding agent',
})

function initial(): AgentState {
  return createInitialState({
    sessionId: 's1',
    systemPrompt: 'you are a coding agent',
  })
}

function asst(...content: Message['content']): Message {
  return { role: 'assistant', content }
}

// ============================================================================
// Basic state transitions
// ============================================================================

describe('step: user_message', () => {
  it('appends user message and emits call_llm', () => {
    const s0 = initial()
    const { next, effects } = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(next.status).toBe('thinking')
    expect(next.messages).toHaveLength(2) // system + user
    expect(next.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(effects).toHaveLength(1)
    expect(effects[0]?.kind).toBe('call_llm')
  })

  it('is no-op when not idle', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(next.cursor).toBe(s0.cursor + 1) // cursor still advances
    expect(next.messages).toEqual(s0.messages) // but no message added
    expect(effects).toEqual([])
  })

  it('cursor advances by exactly 1', () => {
    const s0 = initial()
    const { next } = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(next.cursor).toBe(s0.cursor + 1)
  })
})

describe('step: llm_response (plain answer)', () => {
  it('marks turn done and emits finish', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'hello!' }),
      },
      CONFIG,
    )
    expect(next.status).toBe('done')
    expect(next.messages).toHaveLength(2) // system + assistant
    expect(next.messages.at(-1)?.role).toBe('assistant')
    expect(effects).toEqual([{ kind: 'finish' }])
  })

  it('is no-op if not thinking', () => {
    const s0 = initial()
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'hi' }),
      },
      CONFIG,
    )
    expect(next.status).toBe('idle')
    expect(effects).toEqual([])
  })

  it('accumulates usage when provided', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'hi' }),
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
      },
      CONFIG,
    )
    expect(next.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    })
  })

  it('adds usage on top of prior total across turns', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'thinking',
      usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.0005 },
    }
    const { next } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'hi' }),
        usage: { inputTokens: 30, outputTokens: 5 },
      },
      CONFIG,
    )
    expect(next.usage).toEqual({
      inputTokens: 80,
      outputTokens: 15,
      costUsd: 0.0005, // delta had no cost
    })
  })
})

describe('step: llm_response with tool calls', () => {
  it('dispatches non-approval tool directly', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({
          type: 'tool_call',
          callId: 'c1',
          name: 'read',
          input: { path: '/tmp/x' },
        }),
      },
      CONFIG,
    )
    expect(next.status).toBe('executing_tools')
    expect(next.pendingCalls).toEqual([
      {
        callId: 'c1',
        name: 'read',
        input: { path: '/tmp/x' },
        status: 'dispatched',
      },
    ])
    expect(effects).toEqual([
      {
        kind: 'call_tool',
        callId: 'c1',
        name: 'read',
        input: { path: '/tmp/x' },
      },
    ])
  })

  it('parks approval-required tool in awaiting_approval', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst({
          type: 'tool_call',
          callId: 'c1',
          name: 'write',
          input: { path: '/tmp/x', content: 'y' },
        }),
      },
      CONFIG,
    )
    expect(next.status).toBe('awaiting_approval')
    expect(next.pendingCalls[0]?.status).toBe('awaiting_approval')
    expect(effects).toEqual([
      {
        kind: 'request_approval',
        callId: 'c1',
        name: 'write',
        input: { path: '/tmp/x', content: 'y' },
      },
    ])
  })

  it('handles mixed approval/auto in one response', () => {
    const s0 = { ...initial(), status: 'thinking' as const }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_response',
        message: asst(
          { type: 'tool_call', callId: 'c1', name: 'read', input: {} },
          { type: 'tool_call', callId: 'c2', name: 'write', input: {} },
        ),
      },
      CONFIG,
    )
    // Read auto-dispatched; write awaiting approval.
    expect(next.status).toBe('awaiting_approval')
    const read = next.pendingCalls.find((c) => c.callId === 'c1')
    const write = next.pendingCalls.find((c) => c.callId === 'c2')
    expect(read?.status).toBe('dispatched')
    expect(write?.status).toBe('awaiting_approval')
    expect(effects).toHaveLength(2)
  })
})

describe('step: approval / rejection', () => {
  it('approve  -  dispatched, emits call_tool', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'awaiting_approval',
      pendingCalls: [
        { callId: 'c1', name: 'write', input: { x: 1 }, status: 'awaiting_approval' },
      ],
    }
    const { next, effects } = step(s0, { kind: 'user_approve', callId: 'c1' }, CONFIG)
    expect(next.status).toBe('executing_tools')
    expect(next.pendingCalls[0]?.status).toBe('dispatched')
    expect(effects[0]).toEqual({
      kind: 'call_tool',
      callId: 'c1',
      name: 'write',
      input: { x: 1 },
    })
  })

  it('reject  -  removes pending, appends tool_result, calls LLM again', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'awaiting_approval',
      pendingCalls: [
        { callId: 'c1', name: 'write', input: {}, status: 'awaiting_approval' },
      ],
    }
    const { next, effects } = step(
      s0,
      {
        kind: 'user_reject',
        callId: 'c1',
        reason: 'nope',
      },
      CONFIG,
    )
    expect(next.pendingCalls).toEqual([])
    expect(next.status).toBe('thinking')
    expect(next.messages.at(-1)?.role).toBe('tool')
    expect(effects[0]?.kind).toBe('call_llm')
  })
})

describe('step: tool_result', () => {
  it('single tool: appends result, thinks again', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next, effects } = step(
      s0,
      {
        kind: 'tool_result',
        callId: 'c1',
        ok: true,
        content: 'file contents',
      },
      CONFIG,
    )
    expect(next.pendingCalls).toEqual([])
    expect(next.status).toBe('thinking')
    expect(next.messages.at(-1)?.content[0]).toEqual({
      type: 'tool_result',
      callId: 'c1',
      ok: true,
      content: 'file contents',
    })
    expect(effects[0]?.kind).toBe('call_llm')
  })

  it('parallel tools: waits until all complete before calling LLM', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
        { callId: 'c2', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const r1 = step(
      s0,
      { kind: 'tool_result', callId: 'c1', ok: true, content: 'a' },
      CONFIG,
    )
    expect(r1.next.status).toBe('executing_tools')
    expect(r1.effects).toEqual([])
    expect(r1.next.pendingCalls).toHaveLength(1)

    const r2 = step(
      r1.next,
      {
        kind: 'tool_result',
        callId: 'c2',
        ok: true,
        content: 'b',
      },
      CONFIG,
    )
    expect(r2.next.status).toBe('thinking')
    expect(r2.effects[0]?.kind).toBe('call_llm')
  })

  it('is no-op for unknown callId', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next, effects } = step(
      s0,
      {
        kind: 'tool_result',
        callId: 'wrong',
        ok: true,
        content: 'x',
      },
      CONFIG,
    )
    expect(next.pendingCalls).toEqual(s0.pendingCalls)
    expect(effects).toEqual([])
  })
})

describe('step: cancel + errors', () => {
  it('cancel terminates the turn', () => {
    const s0: AgentState = {
      ...initial(),
      status: 'executing_tools',
      pendingCalls: [
        { callId: 'c1', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next, effects } = step(s0, { kind: 'cancel' }, CONFIG)
    expect(next.status).toBe('done')
    expect(next.pendingCalls).toEqual([])
    expect(effects).toEqual([{ kind: 'finish' }])
  })

  it('llm_error moves to error status', () => {
    const s0: AgentState = { ...initial(), status: 'thinking' }
    const { next, effects } = step(
      s0,
      {
        kind: 'llm_error',
        error: 'rate limited',
      },
      CONFIG,
    )
    expect(next.status).toBe('error')
    expect(next.error).toBe('rate limited')
    expect(effects).toEqual([{ kind: 'emit_error', error: 'rate limited' }])
  })

  it('llm_error clears any staged pendingCalls (invariant I5)', () => {
    // Scenario: an LLM 5xx interrupts a turn where the previous LLM response
    // had already staged tool calls. The kernel must drop them  -  leaving them
    // pending would leave the dashboard rendering a "waiting to dispatch"
    // tool with no path forward, and would violate SPEC  - 5 invariant I5.
    const s0: AgentState = {
      ...initial(),
      status: 'thinking',
      pendingCalls: [
        { callId: 'stale', name: 'read', input: {}, status: 'dispatched' },
      ],
    }
    const { next } = step(s0, { kind: 'llm_error', error: 'boom' }, CONFIG)
    expect(next.status).toBe('error')
    expect(next.pendingCalls).toEqual([])
  })
})

describe('regression: state hygiene on re-entry', () => {
  it('user_message from done wipes residual pendingCalls (defense in depth)', () => {
    // If an earlier bug (or unexpected sequence) left the state with a stale
    // pending call while status='done', a fresh user_message must reset the
    // pending slate before entering 'thinking'  -  otherwise the next LLM sees
    // ghost tools that were never in its transcript.
    const s0: AgentState = {
      ...initial(),
      status: 'done',
      pendingCalls: [
        { callId: 'ghost', name: 'read', input: {}, status: 'dispatched' },
      ],
      error: 'lingering from earlier turn',
    }
    const { next } = step(s0, { kind: 'user_message', text: 'again' }, CONFIG)
    expect(next.status).toBe('thinking')
    expect(next.pendingCalls).toEqual([])
    expect(next.error).toBeUndefined()
  })
})

// ============================================================================
// Purity + immutability
// ============================================================================

describe('purity', () => {
  it('input state is never mutated', () => {
    const s0 = initial()
    const snapshot = JSON.parse(JSON.stringify(s0))
    step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(s0).toEqual(snapshot)
  })

  it('same input yields same output (idempotent step)', () => {
    const s0 = initial()
    const r1 = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    const r2 = step(s0, { kind: 'user_message', text: 'hi' }, CONFIG)
    expect(r1.next).toEqual(r2.next)
    expect(r1.effects).toEqual(r2.effects)
  })
})

// ============================================================================
// Replay + fork
// ============================================================================

describe('fold', () => {
  it('replays a full session deterministically', () => {
    const events: AgentEvent[] = [
      { kind: 'user_message', text: 'read /tmp/x' },
      {
        kind: 'llm_response',
        message: asst({
          type: 'tool_call',
          callId: 'c1',
          name: 'read',
          input: { path: '/tmp/x' },
        }),
      },
      { kind: 'tool_result', callId: 'c1', ok: true, content: 'hello' },
      {
        kind: 'llm_response',
        message: asst({ type: 'text', text: 'the file says hello' }),
      },
    ]
    const final = fold(initial(), events, CONFIG)
    expect(final.status).toBe('done')
    expect(final.cursor).toBe(4)
    expect(final.messages.at(-1)?.role).toBe('assistant')
  })

  it('trace preserves every step', () => {
    const events: AgentEvent[] = [
      { kind: 'user_message', text: 'hi' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'yo' }) },
    ]
    const { trace, final } = foldWithTrace(initial(), events, CONFIG)
    expect(trace).toHaveLength(2)
    expect(trace[0]?.cursor).toBe(1)
    expect(trace[1]?.cursor).toBe(2)
    expect(final).toBe(trace[1]?.state)
  })
})

describe('fork', () => {
  it('takes a different path from a chosen cursor', () => {
    const original: AgentEvent[] = [
      { kind: 'user_message', text: 'hi' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'original' }) },
    ]
    const alt: AgentEvent[] = [
      { kind: 'user_message', text: 'hi again' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'alternate' }) },
    ]
    // Fork at cursor 0 (before any event)  -  replace with alt.
    const forked = fork(initial(), original, 0, alt, CONFIG)
    expect(forked.messages.at(-1)?.content[0]).toMatchObject({
      text: 'alternate',
    })
  })

  it('keeps prefix and appends new suffix', () => {
    const events: AgentEvent[] = [
      { kind: 'user_message', text: 'first' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'a1' }) },
      { kind: 'user_message', text: 'second' },
      { kind: 'llm_response', message: asst({ type: 'text', text: 'a2' }) },
    ]
    // Fork after the first user message but before the LLM answered.
    const forked = fork(
      initial(),
      events,
      1,
      [{ kind: 'llm_response', message: asst({ type: 'text', text: 'different' }) }],
      CONFIG,
    )
    // Kept: system + user "first". Then the alt assistant reply.
    const texts = forked.messages
      .flatMap((m) => m.content)
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
    expect(texts).toContain('first')
    expect(texts).toContain('different')
    expect(texts).not.toContain('a1')
  })
})

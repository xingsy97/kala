/**
 * The kernel FSM.
 *
 * `step(state, event, config)` is a pure function: given the same input it
 * always returns the same output. It performs no IO. The host consumes the
 * returned effects and, when their results arrive, feeds them back as new
 * events.
 *
 * Structure: `transitions` is a two-dimensional dispatch table indexed by
 * `[status][event.kind]`. This mirrors SPEC §3's legality matrix — a reader
 * can point at row `awaiting_approval`, column `user_approve`, and see the
 * exact code that runs. Absent cells are illegal pairs and fall through to
 * a single no-op path.
 *
 * Design invariants:
 *   1. `next` is a new object; the input `state` is never mutated.
 *   2. `effects` describe what the host must do; the kernel does not do them.
 *   3. `cursor` increments by exactly 1 per event, enabling replay positioning.
 *   4. `config` is static per session (tools, system prompt). It is never
 *      mutated; state is what evolves.
 *   5. An unexpected event in the current status is a no-op — cursor advances,
 *      state otherwise unchanged, effects empty.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  AgentStatus,
  Effect,
  Message,
  MessageContent,
  PendingToolCall,
  StepResult,
  ToolCallContent,
  UsageDelta,
  UsageTotal,
} from './types.js'

type EventOfKind<K extends AgentEvent['kind']> = Extract<AgentEvent, { kind: K }>

type Handler<K extends AgentEvent['kind']> = (
  state: AgentState,
  event: EventOfKind<K>,
  config: AgentConfig,
) => StepResult

type TransitionRow = {
  [K in AgentEvent['kind']]?: Handler<K>
}

const transitions: Record<AgentStatus, TransitionRow> = {
  idle: {
    user_message: (s, e, c) => onUserMessage(s, e.text, c),
    cancel: (s) => noop(s),
  },
  thinking: {
    llm_response: (s, e, c) => onLlmResponse(s, e.message, e.usage, c),
    llm_error: (s, e) => onLlmError(s, e.error),
    cancel: (s) => onCancel(s),
  },
  awaiting_approval: {
    user_approve: (s, e) => onUserApprove(s, e.callId),
    user_reject: (s, e, c) => onUserReject(s, e.callId, e.reason, c),
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c),
    cancel: (s) => onCancel(s),
  },
  executing_tools: {
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c),
    cancel: (s) => onCancel(s),
  },
  done: {
    user_message: (s, e, c) => onUserMessage(s, e.text, c),
  },
  error: {},
}

export function step(
  state: AgentState,
  event: AgentEvent,
  config: AgentConfig,
): StepResult {
  const advanced: AgentState = { ...state, cursor: state.cursor + 1 }
  const row = transitions[advanced.status]
  const handler = row[event.kind] as Handler<typeof event.kind> | undefined
  if (!handler) return noop(advanced)
  return handler(advanced, event, config)
}

// ============================================================================
// Handlers
// ============================================================================

function onUserMessage(
  state: AgentState,
  text: string,
  config: AgentConfig,
): StepResult {
  const userMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text }],
  }
  // Defensive reset: entering a fresh turn wipes any residual pendingCalls or
  // error text so invariant I5 (status ↔ pendingCalls) can't be left broken
  // by a prior malformed transition (see docs/adversarial-review-2026-07-04).
  const next: AgentState = {
    ...state,
    messages: [...state.messages, userMsg],
    pendingCalls: [],
    status: 'thinking',
    error: undefined,
  }
  return {
    next,
    effects: [{ kind: 'call_llm', messages: next.messages, tools: config.tools }],
  }
}

function onLlmResponse(
  state: AgentState,
  message: Message,
  usage: UsageDelta | undefined,
  config: AgentConfig,
): StepResult {
  if (message.role !== 'assistant') return noop(state)

  const messages = [...state.messages, message]
  const nextUsage = usage ? addUsage(state.usage, usage) : state.usage
  const toolCalls = extractToolCalls(message.content)

  if (toolCalls.length === 0) {
    return {
      next: { ...state, messages, usage: nextUsage, status: 'done' },
      effects: [{ kind: 'finish' }],
    }
  }

  const pending: PendingToolCall[] = toolCalls.map((tc) => {
    const schema = config.tools.find((t) => t.name === tc.name)
    const requiresApproval = schema?.requiresApproval ?? true
    return {
      callId: tc.callId,
      name: tc.name,
      input: tc.input,
      status: requiresApproval ? 'awaiting_approval' : 'approved',
    }
  })

  const effects: Effect[] = []
  for (const p of pending) {
    if (p.status === 'awaiting_approval') {
      effects.push({
        kind: 'request_approval',
        callId: p.callId,
        name: p.name,
        input: p.input,
      })
    } else {
      effects.push({
        kind: 'call_tool',
        callId: p.callId,
        name: p.name,
        input: p.input,
      })
    }
  }

  const nextPending: PendingToolCall[] = pending.map((p) =>
    p.status === 'approved' ? { ...p, status: 'dispatched' } : p,
  )

  const status: AgentStatus = pending.some(
    (p) => p.status === 'awaiting_approval',
  )
    ? 'awaiting_approval'
    : 'executing_tools'

  return {
    next: {
      ...state,
      messages,
      usage: nextUsage,
      pendingCalls: nextPending,
      status,
    },
    effects,
  }
}

function onLlmError(state: AgentState, error: string): StepResult {
  // Invariant I5: status='error' → pendingCalls.length===0. Any tool calls
  // staged during the failed turn become unresolvable at this point (the LLM
  // that would have consumed their results is gone); drop them so downstream
  // consumers don't render orphaned pending entries.
  return {
    next: { ...state, pendingCalls: [], status: 'error', error },
    effects: [{ kind: 'emit_error', error }],
  }
}

function onUserApprove(state: AgentState, callId: string): StepResult {
  const target = state.pendingCalls.find((c) => c.callId === callId)
  if (!target || target.status !== 'awaiting_approval') return noop(state)

  const pendingCalls = state.pendingCalls.map((c) =>
    c.callId === callId ? { ...c, status: 'dispatched' as const } : c,
  )

  const effect: Effect = {
    kind: 'call_tool',
    callId,
    name: target.name,
    input: target.input,
  }

  const stillAwaiting = pendingCalls.some((c) => c.status === 'awaiting_approval')
  return {
    next: {
      ...state,
      pendingCalls,
      status: stillAwaiting ? 'awaiting_approval' : 'executing_tools',
    },
    effects: [effect],
  }
}

function onUserReject(
  state: AgentState,
  callId: string,
  reason: string | undefined,
  config: AgentConfig,
): StepResult {
  const target = state.pendingCalls.find((c) => c.callId === callId)
  if (!target || target.status !== 'awaiting_approval') return noop(state)

  const rejectedContent = reason ?? 'User rejected this tool call.'
  const toolResultMsg: Message = {
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        callId,
        ok: false,
        content: rejectedContent,
      },
    ],
  }

  const pendingCalls = state.pendingCalls.filter((c) => c.callId !== callId)
  const messages = [...state.messages, toolResultMsg]

  return afterPendingSettled(state, messages, pendingCalls, config)
}

function onToolResult(
  state: AgentState,
  callId: string,
  ok: boolean,
  content: string,
  config: AgentConfig,
): StepResult {
  const target = state.pendingCalls.find((c) => c.callId === callId)
  if (!target || target.status !== 'dispatched') return noop(state)

  const toolResultMsg: Message = {
    role: 'tool',
    content: [{ type: 'tool_result', callId, ok, content }],
  }
  const pendingCalls = state.pendingCalls.filter((c) => c.callId !== callId)
  const messages = [...state.messages, toolResultMsg]

  return afterPendingSettled(state, messages, pendingCalls, config)
}

function onCancel(state: AgentState): StepResult {
  return {
    next: { ...state, status: 'done', pendingCalls: [] },
    effects: [{ kind: 'finish' }],
  }
}

// ============================================================================
// Helpers
// ============================================================================

function extractToolCalls(content: readonly MessageContent[]): ToolCallContent[] {
  return content.filter((c): c is ToolCallContent => c.type === 'tool_call')
}

function afterPendingSettled(
  state: AgentState,
  messages: readonly Message[],
  pendingCalls: readonly PendingToolCall[],
  config: AgentConfig,
): StepResult {
  if (pendingCalls.length > 0) {
    const stillAwaiting = pendingCalls.some((c) => c.status === 'awaiting_approval')
    return {
      next: {
        ...state,
        messages,
        pendingCalls,
        status: stillAwaiting ? 'awaiting_approval' : 'executing_tools',
      },
      effects: [],
    }
  }
  const next: AgentState = {
    ...state,
    messages,
    pendingCalls: [],
    status: 'thinking',
  }
  return {
    next,
    effects: [{ kind: 'call_llm', messages: next.messages, tools: config.tools }],
  }
}

function addUsage(total: UsageTotal, delta: UsageDelta): UsageTotal {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    costUsd: total.costUsd + (delta.costUsd ?? 0),
  }
}

function noop(state: AgentState): StepResult {
  return { next: state, effects: [] }
}

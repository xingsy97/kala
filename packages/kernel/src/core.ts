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
  ApprovalMode,
  ContextPressureLevel,
  Effect,
  Message,
  MessageContent,
  PendingToolCall,
  StepResult,
  TodoItem,
  TodoPriority,
  TodoStatus,
  ToolCallContent,
  UsageDelta,
  UsageTotal,
} from './types.js'
import {
  DEFAULT_HARD_THRESHOLD,
  DEFAULT_SOFT_THRESHOLD,
  TODOWRITE_TOOL_NAME,
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
    user_message: (s, e, c) => onUserMessage(s, e, c),
    cancel: (s) => noop(s),
    compact_replaced: (s, e) => onCompactReplaced(s, e),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: (s, e) => onCwdChanged(s, e.cwd),
  },
  thinking: {
    llm_response: (s, e, c) => onLlmResponse(s, e.message, e.usage, c),
    llm_error: (s, e) => onLlmError(s, e.error),
    cancel: (s) => onCancel(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  awaiting_approval: {
    user_approve: (s, e) => onUserApprove(s, e.callId),
    user_reject: (s, e, c) => onUserReject(s, e.callId, e.reason, c),
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c),
    cancel: (s) => onCancel(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  executing_tools: {
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c),
    cancel: (s) => onCancel(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  done: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    compact_replaced: (s, e) => onCompactReplaced(s, e),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: (s, e) => onCwdChanged(s, e.cwd),
  },
  error: {
    compact_replaced: (s, e) => onCompactReplaced(s, e),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
}

export function step(
  state: AgentState,
  event: AgentEvent,
  config: AgentConfig,
): StepResult {
  const advanced: AgentState = { ...state, cursor: state.cursor + 1 }
  const row = transitions[advanced.status]
  const handler = row[event.kind] as Handler<typeof event.kind> | undefined
  const result = handler ? handler(advanced, event, config) : noop(advanced)
  return {
    next: withPressure(result.next, config),
    effects: result.effects,
  }
}

// ============================================================================
// Handlers
// ============================================================================

function onUserMessage(
  state: AgentState,
  event: Extract<AgentEvent, { kind: 'user_message' }>,
  config: AgentConfig,
): StepResult {
  const content: MessageContent[] = event.content
    ? [...event.content]
    : [{ type: 'text', text: event.text ?? '' }]
  const userMsg: Message = {
    role: 'user',
    content,
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

  // Approval decision per call. Mode overrides the tool schema's flag when
  // it wants to. `deny` short-circuits into a synthetic tool_result message
  // so the LLM can respond to the refusal on the next turn without the host
  // ever dispatching anything.
  type Decision = 'dispatch' | 'ask' | 'reject'
  const decisions: Array<{ call: ToolCallContent; decision: Decision }> =
    toolCalls.map((tc) => {
      const schema = config.tools.find((t) => t.name === tc.name)
      const needsApproval = schema?.requiresApproval ?? true
      const decision = decide(state.approvalMode, needsApproval)
      return { call: tc, decision }
    })

  // Any denied calls get their synthetic refusal appended as tool_result
  // content on a fresh `tool` message. The dispatched / awaiting ones flow
  // through the normal pending-call machinery.
  const rejectedContents: MessageContent[] = decisions
    .filter((d) => d.decision === 'reject')
    .map((d) => ({
      type: 'tool_result',
      callId: d.call.callId,
      ok: false,
      content: 'rejected: approval mode is "deny"',
    }))

  const pending: PendingToolCall[] = decisions
    .filter((d) => d.decision !== 'reject')
    .map((d) => ({
      callId: d.call.callId,
      name: d.call.name,
      input: d.call.input,
      status: d.decision === 'dispatch' ? 'approved' : 'awaiting_approval',
    }))

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
        ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
      })
    }
  }

  const nextPending: PendingToolCall[] = pending.map((p) =>
    p.status === 'approved' ? { ...p, status: 'dispatched' } : p,
  )

  // If every call was rejected outright, the turn ends with an implicit
  // "the LLM must answer using these refusals" — but we can't dispatch
  // anything, so we go back to thinking with a synthetic tool-result
  // message and let the host schedule the next call_llm.
  const messagesWithRejections =
    rejectedContents.length > 0
      ? [
          ...messages,
          { role: 'tool' as const, content: rejectedContents },
        ]
      : messages

  if (pending.length === 0) {
    return {
      next: {
        ...state,
        messages: messagesWithRejections,
        usage: nextUsage,
        pendingCalls: [],
        status: 'thinking',
      },
      effects: [
        {
          kind: 'call_llm',
          messages: messagesWithRejections,
          tools: config.tools,
        },
      ],
    }
  }

  const status: AgentStatus = pending.some(
    (p) => p.status === 'awaiting_approval',
  )
    ? 'awaiting_approval'
    : 'executing_tools'

  return {
    next: {
      ...state,
      messages: messagesWithRejections,
      usage: nextUsage,
      pendingCalls: nextPending,
      status,
    },
    effects,
  }
}

function decide(
  mode: ApprovalMode,
  needsApproval: boolean,
): 'dispatch' | 'ask' | 'reject' {
  switch (mode) {
    case 'allow_all':
      return 'dispatch'
    case 'ask':
      return 'ask'
    case 'deny':
      return needsApproval ? 'reject' : 'dispatch'
    case 'auto':
      return needsApproval ? 'ask' : 'dispatch'
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
    ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
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

  // Special case: `todowrite` promotes its input to first-class state. The
  // tool's own return value is just an ack; the authoritative todos list is
  // what the LLM passed in. Parsing from `target.input` (not `content`) means
  // a broken executor can't corrupt the todo state.
  const nextTodos =
    ok && target.name === TODOWRITE_TOOL_NAME
      ? parseTodosFromInput(target.input, state.todos)
      : state.todos

  return afterPendingSettled(state, messages, pendingCalls, config, nextTodos)
}

function onCancel(state: AgentState): StepResult {
  return {
    next: { ...state, status: 'done', pendingCalls: [] },
    effects: [{ kind: 'finish' }],
  }
}

function onCompactReplaced(
  state: AgentState,
  event: Extract<AgentEvent, { kind: 'compact_replaced' }>,
): StepResult {
  // Preserve the leading system prompt (index 0 if role === 'system') so the
  // agent's identity/tools framing is not lost. Everything after becomes one
  // synthetic system message carrying the summary.
  const preserved: Message[] = []
  if (state.messages.length > 0 && state.messages[0]!.role === 'system') {
    preserved.push(state.messages[0]!)
  }
  const summaryMsg: Message = {
    role: 'system',
    content: [{ type: 'text', text: event.summary }],
  }
  const usage: UsageTotal = {
    ...state.usage,
    inputTokens: event.tokensAfter,
  }
  return {
    next: {
      ...state,
      messages: [...preserved, summaryMsg],
      usage,
    },
    effects: [],
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
  todos: readonly TodoItem[] = state.todos,
): StepResult {
  if (pendingCalls.length > 0) {
    const stillAwaiting = pendingCalls.some((c) => c.status === 'awaiting_approval')
    return {
      next: {
        ...state,
        messages,
        pendingCalls,
        todos,
        status: stillAwaiting ? 'awaiting_approval' : 'executing_tools',
      },
      effects: [],
    }
  }
  const next: AgentState = {
    ...state,
    messages,
    pendingCalls: [],
    todos,
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

function onApprovalModeChanged(
  state: AgentState,
  mode: ApprovalMode,
): StepResult {
  if (state.approvalMode === mode) return noop(state)
  return { next: { ...state, approvalMode: mode }, effects: [] }
}

function onCwdChanged(state: AgentState, cwd: string): StepResult {
  if (state.cwd === cwd) return noop(state)
  return { next: { ...state, cwd }, effects: [] }
}

function withPressure(state: AgentState, config: AgentConfig): AgentState {
  const level = derivePressure(state.usage.inputTokens, config)
  if (level === state.contextPressureLevel) return state
  return { ...state, contextPressureLevel: level }
}

function derivePressure(
  inputTokens: number,
  config: AgentConfig,
): ContextPressureLevel {
  if (!config.contextLimit || config.contextLimit <= 0) return 'none'
  const ratio = inputTokens / config.contextLimit
  const hard = config.hardThreshold ?? DEFAULT_HARD_THRESHOLD
  const soft = config.softThreshold ?? DEFAULT_SOFT_THRESHOLD
  if (ratio >= hard) return 'hard'
  if (ratio >= soft) return 'soft'
  return 'none'
}

const TODO_STATUSES: readonly TodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]
const TODO_PRIORITIES: readonly TodoPriority[] = ['high', 'medium', 'low']

function parseTodosFromInput(
  input: Record<string, unknown>,
  fallback: readonly TodoItem[],
): readonly TodoItem[] {
  const raw = (input as { todos?: unknown }).todos
  if (!Array.isArray(raw)) return fallback
  const out: TodoItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const content = typeof rec.content === 'string' ? rec.content : null
    const status =
      typeof rec.status === 'string' &&
      (TODO_STATUSES as readonly string[]).includes(rec.status)
        ? (rec.status as TodoStatus)
        : null
    if (!content || !status) continue
    const priority =
      typeof rec.priority === 'string' &&
      (TODO_PRIORITIES as readonly string[]).includes(rec.priority)
        ? (rec.priority as TodoPriority)
        : undefined
    out.push(priority ? { content, status, priority } : { content, status })
  }
  return out
}

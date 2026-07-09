/**
 * FSM handlers — one function per `(status, event.kind)` transition cell.
 *
 * Every handler here is a pure function `(state, ...event fields, config) → StepResult`.
 * They are wired to the transitions table in `core.ts`; each handler mirrors
 * one row × one column of SPEC §3's legality matrix. Handlers never mutate
 * the input state and never perform IO.
 *
 * Split from `core.ts` for readability — the dispatch table stays right next
 * to `step()`, this file holds the per-event bodies.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  AgentStatus,
  ApprovalMode,
  Effect,
  Message,
  MessageContent,
  PendingToolCall,
  StepResult,
  ToolCallContent,
  UsageDelta,
} from './types.js'
import {
  addUsage,
  afterPendingSettled,
  extractToolCalls,
  noop,
} from './helpers.js'

export function onUserMessage(
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
  // by a prior malformed transition.
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

export function onLlmResponse(
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

export function onLlmError(state: AgentState, error: string): StepResult {
  // Invariant I5: status='error' → pendingCalls.length===0. Any tool calls
  // staged during the failed turn become unresolvable at this point (the LLM
  // that would have consumed their results is gone); drop them so downstream
  // consumers don't render orphaned pending entries.
  return {
    next: { ...state, pendingCalls: [], status: 'error', error },
    effects: [{ kind: 'emit_error', error }],
  }
}

export function onUserApprove(state: AgentState, callId: string): StepResult {
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

export function onUserReject(
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

export function onToolResult(
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

export function onCancel(state: AgentState): StepResult {
  return {
    next: { ...state, status: 'done', pendingCalls: [] },
    effects: [{ kind: 'finish' }],
  }
}

export function onClear(state: AgentState): StepResult {
  return {
    next: {
      ...state,
      messages: [],
      pendingCalls: [],
      status: 'idle',
      usage: {
        inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
      error: undefined,
    },
    effects: [],
  }
}

export function onCompactReplaced(
  state: AgentState,
  event: Extract<AgentEvent, { kind: 'compact_replaced' }>,
): StepResult {
  const preserved: Message[] = []
  if (state.messages.length > 0 && state.messages[0]!.role === 'system') {
    preserved.push(state.messages[0]!)
  }
  const preserveFrom = Math.min(
    Math.max(event.preserveFrom, preserved.length),
    state.messages.length,
  )
  const tail = state.messages.slice(preserveFrom)
  const summaryMsg: Message = {
    role: 'system',
    content: [{ type: 'text', text: event.summary }],
  }
  const usage = {
    ...state.usage,
    inputTokens: event.tokensAfter,
  }
  return {
    next: {
      ...state,
      messages: [...preserved, summaryMsg, ...tail],
      usage,
    },
    effects: [],
  }
}

export function onApprovalModeChanged(
  state: AgentState,
  mode: ApprovalMode,
): StepResult {
  if (state.approvalMode === mode) return noop(state)
  return { next: { ...state, approvalMode: mode }, effects: [] }
}

export function onCwdChanged(state: AgentState, cwd: string): StepResult {
  if (state.cwd === cwd) return noop(state)
  return { next: { ...state, cwd }, effects: [] }
}

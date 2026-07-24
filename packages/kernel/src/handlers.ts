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
  HandlerResult,
  ToolCallContent,
  UsageDelta,
} from './types.js'
import {
  addUsage,
  afterPendingSettled,
  extractToolCalls,
  noop,
  rejectInvalidEvent,
} from './helpers.js'
import { transitionAgentState } from './state.js'

export function onUserMessage(
  state: AgentState,
  event: Extract<AgentEvent, { kind: 'user_message' }>,
  config: AgentConfig,
): HandlerResult {
  const content: MessageContent[] = event.content
    ? [...event.content]
    : [{ type: 'text', text: event.text ?? '' }]
  const userMsg: Message = {
    role: 'user',
    content,
  }
  const repairedMessages = appendCancelledResultsForOrphanedToolCalls(state.messages)
  // Defensive reset: entering a fresh turn wipes any residual pendingCalls or
  // error text so invariant I5 (status ↔ pendingCalls) can't be left broken
  // by a prior malformed transition.
  const next = transitionAgentState(
    state,
    { status: 'thinking', pendingCalls: [] },
    { messages: [...repairedMessages, userMsg] },
  )
  return {
    next,
    effects: [{ kind: 'call_llm', messages: next.messages, tools: config.tools }],
  }
}

function appendCancelledResultsForOrphanedToolCalls(messages: readonly Message[]): readonly Message[] {
  const unresolved = new Map<string, ToolCallContent>()
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call') unresolved.set(content.callId, content)
      if (content.type === 'tool_result') unresolved.delete(content.callId)
    }
  }
  if (unresolved.size === 0) return messages
  const repairs = [...unresolved.keys()].map<Message>((callId) => ({
    role: 'tool',
    content: [{
      type: 'tool_result',
      callId,
      ok: false,
      content: 'cancelled by user',
    }],
  }))
  return [...messages, ...repairs]
}

export function onLlmResponse(
  state: AgentState,
  message: Message,
  usage: UsageDelta | undefined,
  config: AgentConfig,
): HandlerResult {
  if (message.role !== 'assistant') return rejectInvalidEvent(state)

  const messages = [...state.messages, message]
  const nextUsage = usage ? addUsage(state.usage, usage) : state.usage
  const toolCalls = extractToolCalls(message.content)

  if (toolCalls.length === 0) {
    return {
      next: transitionAgentState(state, { status: 'done', pendingCalls: [] }, { messages, usage: nextUsage }),
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
      next: transitionAgentState(
        state,
        { status: 'thinking', pendingCalls: [] },
        { messages: messagesWithRejections, usage: nextUsage },
      ),
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
    next: transitionAgentState(
      state,
      { status, pendingCalls: nextPending },
      { messages: messagesWithRejections, usage: nextUsage },
    ),
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

export function onLlmError(state: AgentState, error: string): HandlerResult {
  // Invariant I5: status='error' → pendingCalls.length===0. Any tool calls
  // staged during the failed turn become unresolvable at this point (the LLM
  // that would have consumed their results is gone); drop them so downstream
  // consumers don't render orphaned pending entries.
  return {
    next: transitionAgentState(state, { status: 'error', pendingCalls: [], error }),
    effects: [{ kind: 'emit_error', error }],
  }
}

export function onUserApprove(state: AgentState, callId: string): HandlerResult {
  const target = state.pendingCalls.find((c) => c.callId === callId)
  if (!target || target.status !== 'awaiting_approval') return rejectInvalidEvent(state)

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
    next: transitionAgentState(state, {
      status: stillAwaiting ? 'awaiting_approval' : 'executing_tools',
      pendingCalls,
    }),
    effects: [effect],
  }
}

export function onUserReject(
  state: AgentState,
  callId: string,
  reason: string | undefined,
  config: AgentConfig,
): HandlerResult {
  const target = state.pendingCalls.find((c) => c.callId === callId)
  if (!target || target.status !== 'awaiting_approval') return rejectInvalidEvent(state)

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
): HandlerResult {
  const target = state.pendingCalls.find((c) => c.callId === callId)
  if (!target || target.status !== 'dispatched') return rejectInvalidEvent(state)

  const toolResultMsg: Message = {
    role: 'tool',
    content: [{ type: 'tool_result', callId, ok, content }],
  }
  const pendingCalls = state.pendingCalls.filter((c) => c.callId !== callId)
  const messages = [...state.messages, toolResultMsg]

  return afterPendingSettled(state, messages, pendingCalls, config)
}

export function onCancel(state: AgentState): HandlerResult {
  const cancelledResults = state.pendingCalls.map<Message>((call) => ({
    role: 'tool',
    content: [{
      type: 'tool_result',
      callId: call.callId,
      ok: false,
      content: 'cancelled by user',
    }],
  }))
  return {
    next: transitionAgentState(
      state,
      { status: 'done', pendingCalls: [] },
      {
        messages: cancelledResults.length > 0
          ? [...state.messages, ...cancelledResults]
          : state.messages,
      },
    ),
    effects: [{ kind: 'finish' }],
  }
}

export function onClear(state: AgentState): HandlerResult {
  return {
    next: transitionAgentState(
      state,
      { status: 'idle', pendingCalls: [] },
      {
        messages: [],
        usage: {
        inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      },
    ),
    effects: [],
  }
}

export function onMessagesReplaced(
  state: AgentState,
  event: Extract<AgentEvent, { kind: 'messages_replaced' }>,
): HandlerResult {
  const { start, end } = event.replaceRange
  if (!Number.isInteger(start) || !Number.isInteger(end)) return rejectInvalidEvent(state)
  if (start < 0 || end < start || end > state.messages.length) return rejectInvalidEvent(state)
  if (state.pendingCalls.length > 0 && !preservesPendingToolCallGroup(state, end)) {
    return rejectInvalidEvent(state)
  }
  return {
    next: {
      ...state,
      messages: [
        ...state.messages.slice(0, start),
        ...event.replacementMessages,
        ...state.messages.slice(end),
      ],
    },
    effects: [],
  }
}

function preservesPendingToolCallGroup(state: AgentState, preserveFrom: number): boolean {
  const pending = new Set(state.pendingCalls.map((call) => call.callId))
  if (pending.size === 0) return true
  for (let i = preserveFrom; i < state.messages.length; i++) {
    const message = state.messages[i]
    if (!message || message.role !== 'assistant') continue
    for (const content of message.content) {
      if (content.type !== 'tool_call') continue
      pending.delete(content.callId)
    }
    if (pending.size === 0) return true
  }
  return false
}

export function onApprovalModeChanged(
  state: AgentState,
  mode: ApprovalMode,
): HandlerResult {
  if (state.approvalMode === mode) return noop(state)
  return { next: { ...state, approvalMode: mode }, effects: [] }
}

export function onCwdChanged(state: AgentState, cwd: string): HandlerResult {
  if (state.cwd === cwd) return noop(state)
  return { next: { ...state, cwd }, effects: [] }
}

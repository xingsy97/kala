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
 * The handler bodies live in `handlers.ts` and small pure helpers in
 * `helpers.ts`. This file exists to keep the dispatch table adjacent to
 * `step()` — the two are meant to be read together.
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
  HandlerResult,
  StepResult,
} from './types.js'
import { noop } from './helpers.js'
import {
  onApprovalModeChanged,
  onCancel,
  onClear,
  onCwdChanged,
  onLlmError,
  onLlmResponse,
  onMessagesReplaced,
  onSystemPromptChanged,
  onToolResult,
  onUserApprove,
  onUserMessage,
  onUserReject,
} from './handlers.js'

type EventOfKind<K extends AgentEvent['kind']> = Extract<AgentEvent, { kind: K }>

type Handler<K extends AgentEvent['kind']> = (
  state: AgentState,
  event: EventOfKind<K>,
  config: AgentConfig,
) => HandlerResult

type TransitionRow = {
  [K in AgentEvent['kind']]: Handler<K> | undefined
}

type TransitionTable = {
  [S in AgentStatus]: TransitionRow
}

const transitions = {
  idle: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    llm_response: undefined,
    llm_error: undefined,
    user_approve: undefined,
    user_reject: undefined,
    tool_result: undefined,
    cancel: (s) => noop(s),
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: (s, e) => onCwdChanged(s, e.cwd),
    system_prompt_changed: (s, e) => onSystemPromptChanged(s, e.prompt, e.version),
  },
  thinking: {
    user_message: undefined,
    llm_response: (s, e, c) => onLlmResponse(s, e.message, e.usage, c),
    llm_error: (s, e) => onLlmError(s, e.error),
    user_approve: undefined,
    user_reject: undefined,
    tool_result: undefined,
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: undefined,
    system_prompt_changed: (s, e) => onSystemPromptChanged(s, e.prompt, e.version),
  },
  awaiting_approval: {
    user_message: undefined,
    llm_response: undefined,
    llm_error: undefined,
    user_approve: (s, e) => onUserApprove(s, e.callId),
    user_reject: (s, e, c) => onUserReject(s, e.callId, e.reason, c),
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c, e.failure),
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    messages_replaced: undefined,
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: undefined,
    system_prompt_changed: (s, e) => onSystemPromptChanged(s, e.prompt, e.version),
  },
  executing_tools: {
    user_message: undefined,
    llm_response: undefined,
    llm_error: undefined,
    user_approve: undefined,
    user_reject: undefined,
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c, e.failure),
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: undefined,
    system_prompt_changed: (s, e) => onSystemPromptChanged(s, e.prompt, e.version),
  },
  done: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    llm_response: undefined,
    llm_error: undefined,
    user_approve: undefined,
    user_reject: undefined,
    tool_result: undefined,
    cancel: undefined,
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: (s, e) => onCwdChanged(s, e.cwd),
    system_prompt_changed: (s, e) => onSystemPromptChanged(s, e.prompt, e.version),
  },
  error: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    llm_response: undefined,
    llm_error: undefined,
    user_approve: undefined,
    user_reject: undefined,
    tool_result: undefined,
    cancel: undefined,
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: undefined,
    system_prompt_changed: (s, e) => onSystemPromptChanged(s, e.prompt, e.version),
  },
} satisfies TransitionTable

export type TransitionClassification = 'handled' | 'ignored'

export const agentStatuses = Object.freeze(
  Object.keys(transitions) as AgentStatus[],
)

export const agentEventKinds = Object.freeze(
  Object.keys(transitions.idle) as AgentEvent['kind'][],
)

export const transitionContract: Readonly<
  Record<AgentStatus, Readonly<Record<AgentEvent['kind'], TransitionClassification>>>
> = Object.freeze(Object.fromEntries(
  agentStatuses.map((status) => [
    status,
    Object.freeze(Object.fromEntries(
      agentEventKinds.map((kind) => [kind, transitions[status][kind] ? 'handled' : 'ignored']),
    )),
  ]),
) as Record<AgentStatus, Record<AgentEvent['kind'], TransitionClassification>>)

export const legalTransitions: Readonly<Record<AgentStatus, readonly AgentEvent['kind'][]>> = {
  idle: agentEventKinds.filter((kind) => transitionContract.idle[kind] === 'handled'),
  thinking: agentEventKinds.filter((kind) => transitionContract.thinking[kind] === 'handled'),
  awaiting_approval: agentEventKinds.filter((kind) => transitionContract.awaiting_approval[kind] === 'handled'),
  executing_tools: agentEventKinds.filter((kind) => transitionContract.executing_tools[kind] === 'handled'),
  done: agentEventKinds.filter((kind) => transitionContract.done[kind] === 'handled'),
  error: agentEventKinds.filter((kind) => transitionContract.error[kind] === 'handled'),
}

export function step(
  state: AgentState,
  event: AgentEvent,
  config: AgentConfig,
): StepResult {
  const from = state.status
  const priorViolation = stateInvariantViolation(state)
  const advanced: AgentState = { ...state, cursor: state.cursor + 1 }
  const row = transitions[advanced.status]
  const handler = row[event.kind] as Handler<typeof event.kind> | undefined
  if (!handler) {
    const result = noop(advanced)
    return {
      ...result,
      transition: {
        outcome: 'ignored',
        from,
        to: result.next.status,
        event: event.kind,
        reason: 'event_not_legal_in_state',
      },
    }
  }

  const result = handler(advanced, event, config)
  if (result.rejectionReason) {
    return {
      next: result.next,
      effects: result.effects,
      transition: {
        outcome: 'rejected',
        from,
        to: result.next.status,
        event: event.kind,
        reason: result.rejectionReason,
      },
    }
  }
  const violation = stateInvariantViolation(result.next)
  if (!priorViolation && violation) {
    return {
      next: advanced,
      effects: [],
      transition: {
        outcome: 'rejected',
        from,
        to: advanced.status,
        event: event.kind,
        reason: 'invariant_violation',
      },
    }
  }
  return {
    ...result,
    transition: { outcome: 'applied', from, to: result.next.status, event: event.kind },
  }
}

export function stateInvariantViolation(state: AgentState): string | undefined {
  const runtimeError = (state as { error?: unknown }).error
  if (state.status === 'awaiting_approval') {
    if (!state.pendingCalls.some((call) => call.status === 'awaiting_approval')) {
      return 'awaiting_approval requires an awaiting call'
    }
  } else if (state.status === 'executing_tools') {
    if (state.pendingCalls.length === 0 || state.pendingCalls.some((call) => call.status !== 'dispatched')) {
      return 'executing_tools requires dispatched calls only'
    }
  } else if (state.pendingCalls.length > 0) {
    return `${state.status} cannot retain pending calls`
  }
  if (state.status === 'error') {
    if (!state.error?.trim()) return 'error state requires an error message'
  } else if (runtimeError !== undefined) {
    return `${state.status} cannot retain an error message`
  }
  return undefined
}

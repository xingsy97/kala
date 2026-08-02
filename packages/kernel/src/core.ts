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
  [K in AgentEvent['kind']]?: Handler<K>
}

const transitions: Record<AgentStatus, TransitionRow> = {
  idle: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    cancel: (s) => noop(s),
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: (s, e) => onCwdChanged(s, e.cwd),
  },
  thinking: {
    llm_response: (s, e, c) => onLlmResponse(s, e.message, e.usage, c),
    llm_error: (s, e) => onLlmError(s, e.error),
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  awaiting_approval: {
    user_approve: (s, e) => onUserApprove(s, e.callId),
    user_reject: (s, e, c) => onUserReject(s, e.callId, e.reason, c),
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c, e.failure),
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  executing_tools: {
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c, e.failure),
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  done: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: (s, e) => onCwdChanged(s, e.cwd),
  },
  error: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    clear: (s) => onClear(s),
    messages_replaced: (s, e, c) => onMessagesReplaced(s, e, c),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
}

export const legalTransitions: Readonly<Record<AgentStatus, readonly AgentEvent['kind'][]>> = {
  idle: Object.keys(transitions.idle) as AgentEvent['kind'][],
  thinking: Object.keys(transitions.thinking) as AgentEvent['kind'][],
  awaiting_approval: Object.keys(transitions.awaiting_approval) as AgentEvent['kind'][],
  executing_tools: Object.keys(transitions.executing_tools) as AgentEvent['kind'][],
  done: Object.keys(transitions.done) as AgentEvent['kind'][],
  error: Object.keys(transitions.error) as AgentEvent['kind'][],
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

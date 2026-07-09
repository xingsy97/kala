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
  StepResult,
} from './types.js'
import { noop, withPressure } from './helpers.js'
import {
  onApprovalModeChanged,
  onCancel,
  onClear,
  onCompactReplaced,
  onCwdChanged,
  onLlmError,
  onLlmResponse,
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
) => StepResult

type TransitionRow = {
  [K in AgentEvent['kind']]?: Handler<K>
}

const transitions: Record<AgentStatus, TransitionRow> = {
  idle: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    cancel: (s) => noop(s),
    clear: (s) => onClear(s),
    compact_replaced: (s, e) => onCompactReplaced(s, e),
    compact_skipped: (s) => noop(s),
    compact_rejected: (s) => noop(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: (s, e) => onCwdChanged(s, e.cwd),
  },
  thinking: {
    llm_response: (s, e, c) => onLlmResponse(s, e.message, e.usage, c),
    llm_error: (s, e) => onLlmError(s, e.error),
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    compact_replaced: (s, e) => onCompactReplaced(s, e),
    compact_skipped: (s) => noop(s),
    compact_rejected: (s) => noop(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  awaiting_approval: {
    user_approve: (s, e) => onUserApprove(s, e.callId),
    user_reject: (s, e, c) => onUserReject(s, e.callId, e.reason, c),
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c),
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    compact_skipped: (s) => noop(s),
    compact_rejected: (s) => noop(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  executing_tools: {
    tool_result: (s, e, c) => onToolResult(s, e.callId, e.ok, e.content, c),
    cancel: (s) => onCancel(s),
    clear: (s) => onClear(s),
    compact_replaced: (s, e) => onCompactReplaced(s, e),
    compact_skipped: (s) => noop(s),
    compact_rejected: (s) => noop(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
  },
  done: {
    user_message: (s, e, c) => onUserMessage(s, e, c),
    clear: (s) => onClear(s),
    compact_replaced: (s, e) => onCompactReplaced(s, e),
    compact_skipped: (s) => noop(s),
    compact_rejected: (s) => noop(s),
    approval_mode_changed: (s, e) => onApprovalModeChanged(s, e.mode),
    cwd_changed: (s, e) => onCwdChanged(s, e.cwd),
  },
  error: {
    clear: (s) => onClear(s),
    compact_replaced: (s, e) => onCompactReplaced(s, e),
    compact_skipped: (s) => noop(s),
    compact_rejected: (s) => noop(s),
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

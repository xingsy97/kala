# Context Compaction

**Status**: implemented. This document describes the current agent-kernel boundary.

Agent-kernel uses host-driven context management. The kernel does not estimate
context pressure, choose compaction windows, call a summarizer, retry failed
summaries, or write compaction artifacts. The host owns those runtime policies.
The kernel only records deterministic message replacement facts through
`messages_replaced`.

## Ownership

### Kernel

- Maintains the minimum agent protocol state: messages, pending tool calls,
  status, usage, cursor, approval mode, cwd, and error.
- Applies `messages_replaced` deterministically.
- Rejects invalid replacement ranges and replacements that would orphan pending
  tool calls.
- Does not know why messages were replaced beyond the event `reason` string.
- Does not calculate `contextTokens` or `contextPressureLevel`.

### Runtime Manager / Host

- Builds `ContextSnapshot` values from current model-visible messages, tool
  schemas, reserve tokens, and session context-window settings.
- Decides manual, auto, preflight, and post-tool-result compaction attempts.
- Calls the summarizer LLM and validates the summary.
- Creates the replacement messages and dispatches `messages_replaced`.
- Writes compaction request/response/report evidence to artifacts when
  available.
- Writes skipped/rejected attempts as `runtime_metadata`, not kernel events.
- Broadcasts `contextSnapshot` in `session:ready` and `state:changed` so the
  dashboard can render context pressure without reading reducer state fields.

### Session Log

- `event` entries remain the replay source of truth.
- Successful compaction is represented as an `event` entry whose event is:

```ts
type MessagesReplacedEvent = {
  kind: 'messages_replaced'
  reason: 'compaction' | 'manual_rewrite' | 'recovery'
  replaceRange: { start: number; end: number }
  replacementMessages: readonly Message[]
  artifactRef?: EventArtifactRef
}
```

- Failed or skipped compaction attempts are represented as `runtime_metadata`
  entries, for example `action: 'compaction_skipped'` or
  `action: 'compaction_rejected'`. These are audit/debug facts; they do not feed
  replay.

## ContextSnapshot

The host computes a snapshot with this shape:

```ts
type ContextSnapshot = {
  estimatedMessageTokens: number
  estimatedToolSchemaTokens: number
  estimatedTotalInputTokens: number
  reserveTokens: number
  effectiveLimit?: number
  pressureLevel: 'none' | 'soft' | 'hard'
  reasonCodes: string[]
}
```

`estimatedTotalInputTokens` is the current model-visible estimate for the next
provider request. It is not cumulative provider usage. Cumulative provider
usage stays in `AgentState.usage`.

Reserve policy is intentionally host-owned. The current implementation reserves
up to 4,000 tokens, capped at 10% of a known context limit, so small test
windows are not dominated by the default reserve.

## Trigger Points

- `manual`: user requests compaction through the dashboard or slash command.
- `auto`: host checks `ContextSnapshot.pressureLevel === 'hard'` when a session
  is at rest.
- `preflight`: host checks before sending another LLM request.
- `tool_result`: host checks after individual tool results, so one large tool
  output cannot consume all remaining room before the batch finishes.

The host may skip an attempt when the session has no compactable content, a
runtime guard is active, the summarizer would be unsafe to call, or a circuit
breaker is open. Skips are logged as `runtime_metadata`.

## Continuation State Machine

Compaction and continuation are separate state transitions. A successful
compaction always commits the transcript replacement first; the trigger
context determines whether execution was already in progress. Callers cannot
override this decision with a boolean `resume` flag.

| Trigger context | Allowed source state | State after replacement | Continuation |
| --- | --- | --- | --- |
| `manual` | `idle`, `done`, or `error` | unchanged/resting | Never starts an Agent turn |
| `auto` | resting, while the Host is closing an existing dispatch | unchanged/resting | Does not independently start a turn; the enclosing dispatch state machine may continue work that was already active |
| `preflight` | `thinking` | `thinking` | The existing call stack retries/continues the same LLM turn exactly once |
| `tool_result` | `executing_tools` | `executing_tools` | The existing tool batch continues; it does not create a second LLM turn |

The valid transition set is therefore represented as a discriminated request,
not independent trigger and resume switches:

```ts
type CompactRequest =
  | { trigger: 'manual' | 'auto'; continuation: 'stay_resting' }
  | { trigger: 'preflight' | 'tool_result'; continuation: 'current_turn' }
```

`manual` is a maintenance action. Once its `messages_replaced` event is
durable, the Session remains in its prior resting state even if a durable todo
graph still contains unfinished nodes. The user must send a new message to
start more Agent work. In particular, the Dashboard must not translate a
manual Compact click into a recovery event.

`preflight` and `tool_result` happen inside an already-running turn. They do
not persist a synthetic no-op recovery event: the existing Host call stack is
the continuation checkpoint and proceeds after the replacement. This prevents
both a stranded turn and a duplicate model call/tool side effect. An `auto`
maintenance call made outside an active dispatch likewise remains resting; an
unfinished todo graph alone is not evidence that compaction may create a new
turn.

Planned restart recovery remains a separate protocol. It may persist an
explicit `messages_replaced(reason='recovery', resume=true)` only from a
validated restart checkpoint. Compaction trigger names and Dashboard intent
must never be used as restart evidence.

## Replacement Rules

The host must build a replacement that preserves provider protocol invariants:

- Keep the initial durable setup message when applicable.
- Replace an old compactable range with a summary message.
- Preserve recent tail messages needed for current task continuity.
- Preserve recent raw user turns only within a context-aware budget; a single
  oversized old user turn is summarized instead of copied verbatim back into
  the transcript.
- Do not drop an assistant `tool_call` while retaining its corresponding
  `tool_result`.
- Do not replace a range that intersects unresolved pending tool calls.

The kernel validates the range against current `state.messages`. Invalid
`messages_replaced` events are no-ops. The host should use the same validation
rules before dispatching, and log unexpected rejection as runtime metadata.

## Handoff-Style Summary Format (as of 2026-07-23)

The summarizer is called with a codex-style structured request rather than the
raw multi-turn history:

1. The compaction window (head slice up to `preserveFrom`) is serialised to
   plain text with `[User]:` / `[Assistant]:` / `[Assistant tool call]:` /
   `[Tool result]:` prefixes and sent as a single `user` message wrapped in
   `<transcript>…</transcript>`. This prevents the summarizer from treating an
   unfinished assistant turn as a conversation to continue.
2. If a prior compaction already installed an anchored summary (identified by
   the `SUMMARY_PREFIX` marker), that summary is passed alongside as
   `<previous-summary>…</previous-summary>` so the model can update rather
   than rewrite it.
3. The summarizer prompt requires a fixed `<template>` structure (Objective,
   User Intent, Repository/Runtime State, Decisions, Work Completed, Open
   Work, Preserved Verbatim).

The replacement written back to the transcript is:

```
[ leading system prompt (sticky),
  user: SUMMARY_PREFIX + "\n\n" + <summary body>,
  ...most recent raw user turns from the compacted region (context-aware cap,
     max 20k tokens),
  ...preservedTail ]
```

Summary lands as a **`user` message**, not a `system` message. The
`SUMMARY_PREFIX` string is a stable marker used both to signal handoff intent
to the resuming model and to detect the anchor for the next compaction.

### Validation as a gate (not observability)

`validateCompactionSummary` results and additional quality checks now decide
whether the replacement is dispatched. A summary is rejected — counting as
`consecutiveFailures += 1` and, for manual triggers, throwing to the caller —
when any of the following hold:

- `validation.ok === false` (schema-invalid: missing or empty required sections).
- `summary.length < 400` characters.
- A conservative conversational-reply heuristic fires
  (`looksLikeConversationalReply`).
- The proposed replacement would still leave a normal-size context window above
  the post-compact hard budget (`post_compaction_still_over_budget`).

Failed attempts write `runtime_metadata { action: 'compaction_skipped',
reason: 'summary_schema_invalid' | 'summary_too_short' |
'summary_conversational' | ... }` or `action: 'compaction_rejected'` and never
dispatch a `messages_replaced` event. The prior behaviour (persist validation
only as an artifact, always dispatch) is retired.

### Applied metadata payload

Successful `compaction_applied` entries carry, in addition to the previous
fields, `compressionRatio`, `previousSummaryChars`, `recentRawUsersCount`,
`recentRawUserTokenBudget`, and `validationReasonCodes` for observability.

## Replay, Resume, and Fork

Compaction changes the model-visible messages. Therefore the successful
replacement must be in the event log. Replay/fold sees `messages_replaced` and
reconstructs the same compacted message list without calling a summarizer.

`runtime_metadata` entries are not folded into kernel state. They exist for
debugging, dashboard timelines, and audit trails.

## Dashboard Behavior

Dashboard context UI reads `contextSnapshot` from host payloads:

- `session:ready.contextSnapshot`
- `state:changed.contextSnapshot`

The dashboard must not infer pressure from `AgentState`, because context
pressure is no longer reducer state.

Timeline compaction markers are derived from
`messages_replaced(reason='compaction')`. Summarizer request/response evidence
belongs in artifacts or log metadata, not in the kernel event.

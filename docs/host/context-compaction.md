# Context Compaction

**Status**: implemented; this document is the source of truth for the intended
behavior. Where implementation and this document disagree, this document wins
and the implementation is a bug to fix.

Agent-kernel uses host-driven context compaction. The host decides when and how
to summarize old context; the kernel only records and applies the resulting
`compact_replaced` event. This keeps replay deterministic, keeps model-specific
budget policy out of the reducer, and still makes every compaction boundary
visible in the JSONL ledger and dashboard debugger.

## Problem Statement

Long-running coding-agent sessions fail in three ways, and a robust compaction
system must handle all three without human intervention:

1. **Cumulative pressure**. Old chat, tool results, file excerpts, memory, and
   tool schemas gradually fill the model context window.
2. **Single-turn blowups**. One shell/search/test result can be large enough to
   make the next LLM request or even the compaction request itself exceed the
   model window.
3. **Sustained summarizer failure**. The summarizer LLM call may itself fail
   repeatedly (provider outage, authentication error, malformed model output,
   or an input that keeps hitting `prompt_too_long` even after trimming). A
   compaction system that retries forever will burn quota; one that gives up
   silently will let the session poison itself.

The dangerous case is a multi-tool-call batch. If an assistant emits four tool
calls and the first tool result is huge, waiting for all four results before
checking pressure can leave no room for the summarizer. Agent-kernel therefore
checks context pressure after individual tool results, not only at turn
boundaries.

## Design Principles

- **Reducer remains policy-light**. The reducer enforces protocol invariants and
  applies validated events. Thresholds, model budgets, summary prompts, pruning,
  retries, and hooks stay in host extensions or loop policy.
- **Durable history is not deleted**. Compaction changes model-visible state by
  appending `compact_replaced`; the event log remains the audit source.
- **The current work surface survives**. The active user turn, active tool-call
  group, recent verification output, cwd, and exact identifiers are more
  important than stale transcript prose.
- **Provider protocol pairing is protected**. Compaction must not orphan a
  `tool_result` by dropping the assistant `tool_call` that introduced it.
- **Compaction has its own budget**. The summarizer prompt and summary response
  need reserved headroom; compaction must not wait until the transcript is too
  large to summarize.
- **Compaction failure is observable, bounded, and recoverable**. Every
  compaction attempt succeeds, is skipped with a reason, or fails with a reason
  code. Repeated failure engages a circuit breaker rather than silently
  looping. A skipped compaction never leaves the session claiming compaction
  ran.

## Reference Implementations: End-To-End Mechanics

This section is written from local source code only. The goal is to make the
mechanics clear enough that a reader can implement the same feature without
guessing what "compact" means.

The four serious local references all implement the same high-level shape:

```text
1. Detect that the current model-visible context is too large or user requested compact.
2. Decide which old history becomes summarizer input and which recent tail stays verbatim.
3. Reduce media/tool outputs before the summarizer sees them.
4. Ask a model to produce a continuation summary, not a normal assistant answer.
5. Replace model-visible history with: durable setup + summary + preserved recent tail.
6. Reset or repair caches, warnings, message IDs, token accounting, and continuation state.
7. Expose the compaction as a real lifecycle event for debugging and recovery.
```

The important differences are where each project draws the cut point, how it
protects tool-call protocol ordering, and how it recovers when the summarizer
request itself is too large or keeps failing.

### Codex

Primary source files:

- `tasks/compact.rs` [1]
- `compact.rs` [2]
- `auto_compact_window.rs` [3]
- `compact/prompt.md` [4]

Codex treats compaction as a session task. It is not just a CLI command that
mutates an array of messages.

Concrete manual path:

```text
User runs /compact
  -> CompactTask::run(...)
  -> choose implementation
       token budget feature enabled  -> compact_token_budget::run_manual_compact_task
       provider remote compact       -> compact_remote or compact_remote_v2
       otherwise                     -> compact::run_compact_task
  -> run_compact_task emits TurnStarted
  -> run_compact_task_inner(... trigger=Manual, reason=UserRequested)
```

Concrete local compaction path:

```text
run_compact_task_inner
  -> create CompactionTurnMetadata(trigger, reason, implementation, phase)
  -> start CompactionAnalyticsAttempt
  -> run_pre_compact_hooks(trigger)
       Continue -> keep going
       Stopped  -> record interrupted status and abort
  -> run_compact_task_inner_impl
  -> if success, run_post_compact_hooks(trigger)
  -> record final analytics status
```

Inside `run_compact_task_inner_impl`, the state transition is:

```text
1. Emit a ContextCompaction turn item so the UI/debug stream can show compaction.
2. Clone the current session history.
3. Append the synthetic compact prompt as the newest user input in the cloned history.
4. Build a normal model Prompt from that cloned history plus base instructions.
5. Send that prompt through drain_to_completed as a compaction request.
6. Read the last assistant text from the compaction turn as the summary.
7. Build replacement history from selected durable messages plus the summary.
8. Optionally inject initial context before the last real user message.
9. Install replacement history with replace_compacted_history.
10. Advance the auto-compact window and recompute token usage.
11. Complete the ContextCompaction turn item and emit a warning about long threads.
```

The retry behavior is concrete and important. If the compaction model call fails
with a **typed** `ApiError::ContextWindowExceeded`, Codex does not give up
immediately. It calls `history.remove_first_item()` and tries again in a loop
(no bounded attempts; loop until it fits or a different error surfaces).
Retryable stream errors use backoff. User interruption, turn abort, or session
budget exhaustion are surfaced as terminal failures.

Codex tracks compaction windows in `AutoCompactWindow`:

- a stable first window ID,
- the previous window ID,
- the current window ID,
- a prefill input-token baseline,
- whether a token-budget reminder was delivered,
- whether a new context window was explicitly requested.

Codex reasoning models: the compaction stream passes `turn_context.reasoning_effort` and
`reasoning_summary` from the turn context, so reasoning tokens are respected but
the caller must decide whether to spend them on a summary.

Codex's useful lesson is lifecycle rigor: compaction has task identity, hooks,
analytics, retries, window identity, typed errors, and explicit replacement
history.

### Claude Code

Primary source files:

- `autoCompact.ts` [5]
- `compact.ts` [6]
- `commands/compact.ts` [7]
- `microCompact.ts` [8]
- `sessionMemoryCompact.ts` [9]
- `postCompactCleanup.ts` [10]

Claude Code has several compaction paths. The important point is that `/compact`
and auto-compact do not directly mean "summarize everything now". They first try
cheaper or safer reductions.

Auto-trigger path:

```text
shouldAutoCompact(messages, model, querySource, snipTokensFreed)
  -> reject recursive/incompatible sources
       querySource == session_memory -> false
       querySource == compact        -> false
       reactive-only / context-collapse modes can also suppress auto compact
  -> tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  -> effectiveWindow = contextWindow(model) - min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY=20_000)
  -> threshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS(13_000)
  -> return tokenCount >= threshold
```

The output reserve is explicit. Claude Code reserves up to 20,000 output tokens
for the summary itself. A 200k context model is not treated as "safe until 200k
input tokens"; it is treated as "safe only while there is still room for the
compact prompt and summary response".

If auto-trigger says yes:

```text
autoCompactIfNeeded
  -> if DISABLE_COMPACT, do nothing
  -> if consecutiveFailures >= 3, do nothing         <-- circuit breaker
  -> trySessionMemoryCompaction(messages, agentId, autoCompactThreshold)
       success -> reset summarized-message pointer
               -> runPostCompactCleanup
               -> mark post-compaction state
               -> return compacted
  -> compactConversation(... isAutoCompact=true, suppressUserQuestions=true)
       success -> reset summarized-message pointer
               -> runPostCompactCleanup
               -> reset consecutiveFailures to 0     <-- circuit breaker reset
       failure -> increment consecutiveFailures      <-- circuit breaker step
               -> after 3 failures, stop automatic retry attempts this session
```

Manual `/compact` path:

```text
/compact [optional custom instructions]
  -> getMessagesAfterCompactBoundary(messages)
  -> if no custom instructions, trySessionMemoryCompaction first
  -> if reactive-only mode, run reactive prompt-too-long compaction path
  -> otherwise run microcompactMessages(messages, context)
  -> compactConversation(messagesForCompact, context, cacheSharingParams, ...)
  -> reset lastSummarizedMessageId
  -> suppress compact warning
  -> clear user context cache and run post-compact cleanup
```

Inside full or partial compaction, Claude Code prepares summarizer input with
several safety passes:

```text
1. Choose messages to summarize and messages to keep.
2. Strip progress messages from kept/summarized sets where appropriate.
3. Strip media or replace media with textual attachment markers for compact input.
4. Remove or truncate reinjected context that would be expensive to summarize,
   such as repeated skill discovery/listing attachments.
5. Run pre-compact hooks and merge hook instructions with user instructions.
6. Construct a compact prompt that asks for a continuation summary.
7. Send summarizer request.
8. If the result indicates prompt-too-long, call truncateHeadForPTLRetry and retry.
9. Restore selected file attachments, plan attachment, and async-agent attachments.
10. Clear read-file state, loaded nested memory paths, warnings, and cache baselines.
```

`truncateHeadForPTLRetry` groups messages by API round (assistant + its
tool_results form one group). Each retry drops the oldest whole group so
tool-call/tool-result pairing is preserved. Bounded at 3 attempts. If gap
parsing fails, drops 20% of groups as fallback. Prepends a synthetic marker
when the leading message would be an assistant.

Post-compact cleanup clears: microcompact state, context-collapse state, user
context memoization, memory-files cache, system prompt sections, classifier
approvals, speculative checks, beta tracing state, session messages cache.
Deliberately preserves `sentSkillNames` (already installed skills shouldn't be
re-announced). Skipped for subagent compactions to protect main-thread state.

Claude Code's useful lessons: (1) compaction is a ladder of interventions
(session-memory, microcompact, full compact, partial compact, PTL-retry) with
different cost and blast radius; (2) both `consecutiveFailures` and
`postCompactCleanup` are correctness features, not observability niceties.

### opencode

Primary source files:

- `overflow.ts` [11]
- `compaction.ts` [12]
- `truncate.ts` [13]
- `message-v2.ts` [14]

opencode models compaction as a session service. It stores compaction as normal
session messages and parts, then lets the compaction agent produce a summary.

Overflow decision:

```text
isOverflow({ cfg, tokens, model, outputTokenMax })
  -> if cfg.compaction.auto === false, return false
  -> if model has no context limit, return false     <-- unknown-window fallback: never fires
  -> usable = model input/context limit minus reserved output or compaction buffer
       reserved = cfg.compaction?.reserved
                ?? min(COMPACTION_BUFFER=20_000, ProviderTransform.maxOutputTokens())
  -> count = tokens.total or input + output + cache.read + cache.write
  -> return count >= usable
```

Optional pruning before summary:

```text
prune({ sessionID })
  -> load all messages and parts
  -> walk backward through messages
  -> skip the newest user turns until at least two user turns are protected
  -> stop at an assistant summary
  -> inspect completed tool parts
  -> skip protected tools such as skill tools
  -> keep about PRUNE_PROTECT tokens of recent tool output
  -> if older prunable output exceeds PRUNE_MINIMUM, mark those parts compacted
```

Selecting what to summarize and mid-turn cut:

```text
select({ messages, cfg, model })
  -> split full history into turns
  -> choose recent turns from the end
  -> estimate each recent turn after conversion to model messages
  -> preserve as many recent turns as fit in preserveRecentBudget
       preserveRecentBudget scaled to 25% of usable window,
       bounded between MIN_PRESERVE_RECENT_TOKENS (2k) and MAX_PRESERVE_RECENT_TOKENS (8k)
  -> if a full turn does not fit, split that turn if possible
  -> return { head: messages_to_summarize, tail_start_id }
```

Main compaction process runs a `SessionProcessor` with no tools and a final
user compaction prompt. Tool outputs sent to the summarizer are capped at
`TOOL_OUTPUT_MAX_CHARS = 2000`. If the processor returns `"compact"`
(compaction itself overflowed), the assistant compaction message is written
with a `ContextOverflowError` and processing stops  -  no silent success.

opencode's useful lesson is that compaction should be represented in the same
session object model as other work, and that failure to compact must be
recorded as a first-class error state, not swallowed.

### pi

Primary source files:

- `compaction.ts` [15]
- `utils.ts` [16]
- `branch-summarization.ts` [17]
- `compaction.test.ts` [18]

pi's implementation is the easiest to read as an algorithm because it splits
pure preparation from IO.

Trigger and settings:

```text
DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
}

shouldCompact(contextTokens, contextWindow, settings)
  -> if settings.enabled is false, return false
  -> return contextTokens > contextWindow - settings.reserveTokens
```

Preparation path chooses a `cutPoint`. Valid cut points are user, assistant,
custom, bash, branch-summary, and prior-compaction-summary entries  -  **never a
tool result**. Walks backward from newest messages accumulating estimated
tokens; when `keepRecentTokens` is reached, chooses the closest valid cut
point. Reports whether the cut splits a turn.

If the cut splits a turn, pi produces a `turnPrefixSummary` for the mid-turn
part and merges it with the main summary under a `Turn Context` separator.
Summarizer input is not sent as a normal chat continuation  -  `utils.ts`
serializes it into `[User]: ...`, `[Assistant tool calls]: ...`, `[Tool
result]: ...` text lines. Tool results in the serialized summary are truncated
to 2,000 characters.

pi's boundary tracking uses `firstKeptEntryId`. On the next compaction it
locates the previous compaction entry to thread its summary forward and to
find the previous boundary. If the entry with that id no longer exists (e.g.
because the timeline was edited), pi falls back to `prevCompactionIndex + 1`.

pi's useful lessons: (1) the hard parts (token estimation, valid cut points,
previous-boundary handling, split-turn prefix, file-operation extraction) can
be tested as pure functions without a live model call; (2) boundary IDs must
degrade gracefully if the referenced entry is gone.

### Design Takeaways For Agent-Kernel

The references converge on these concrete requirements:

- Compaction must reserve room for the summary response, not only shrink input.
- The summarizer request needs a bounded retry strategy when it is too large,
  and the trim step must preserve tool_call/tool_result pairing.
- Tool outputs should be bounded before summarization and, ideally, before they
  ever enter normal model-visible history.
- The preserved tail must respect provider tool-call/tool-result pairing.
- Previous summaries should be threaded forward, but previous compaction turns
  should not be repeatedly summarized as ordinary chat.
- Post-compaction cleanup is correctness work: prompt cache baselines,
  file-read caches, warning state, message IDs, and context-injection state
  may all become stale after replacement.
- The reducer should remain policy-light, but cut-point selection and summary
  preparation should be small, testable policy functions.
- Compaction failure is a first-class outcome. A consecutive-failure circuit
  breaker and a typed skip/failure surface are correctness requirements, not
  observability niceties.

## Current Agent-Kernel Mechanism

Agent-kernel has four compaction triggers:

| Trigger | Implemented behavior |
| --- | --- |
| `manual` | `/compact` sends `client:compact`; host runs compaction when the session is at rest. |
| `auto` | Host compacts when `state.contextPressureLevel === 'hard'` and the session is at rest (`idle`, `done`, or `error`). |
| `preflight` | Immediately before a provider request, host estimates prompt size and compacts if the request would violate reserved headroom. |
| `tool_result` | After an individual tool result in a multi-tool batch, host can compact before executing the next pending sibling tool call. |

The reducer derives `contextPressureLevel` from provider-reported usage and the
configured context limit. The host consumes that signal, but the reducer never
calls an LLM or decides thresholds.

Compaction flow:

1. Host chooses a safe `preserveFrom` pivot (see **Cut-Point Selection**).
2. Messages before the pivot are copied into the summarizer request after old
   oversized tool results are reduced to head/tail excerpts.
3. Messages from the pivot onward are preserved verbatim.
4. The summarizer receives a structured engineering-handoff prompt with
   required sections: user intent and constraints, repository/runtime state,
   decisions and rationale, work completed, and open work.
5. Summarizer retry ladder (see **Summarizer Retry Ladder**) handles
   context-window failures with bounded head-trim + increasingly aggressive
   tool-result caps.
6. Host validates the summary shape. Empty summaries or summaries that fail
   validation with a fatal reason code (see **Summary Validation**) are
   rejected  -  the compaction is treated as a failed attempt.
7. Host dispatches either `compact_replaced` (success) or a `compact_skipped`
   event (bounded failure / circuit-breaker / no-op) with a reason code.
8. The reducer keeps the leading system prompt, inserts the synthetic compacted
   summary as a system message, and appends the preserved tail. If the
   proposed `preserveFrom` would orphan a pending tool_result, the reducer
   rejects the event (returns a `compact_rejected` step) and the host records
   the rejection reason.

## Protocol Invariants

`compact_replaced` is protocol-adjacent: replay must see the message
replacement, but summarizer IO remains host-owned metadata.

The reducer invariant is:

- preserve the leading system prompt,
- insert exactly one synthetic compact summary message,
- preserve messages at or after `preserveFrom`,
- **reject** compact replacements that would violate pending tool-call pairing,
  and surface the rejection as `compact_rejected` (not a silent no-op).

When the session is `executing_tools`, a `compact_replaced` event is valid only
if every pending tool call still has its originating assistant `tool_call` in
the preserved tail. This protects OpenAI/Anthropic-style tool-call/tool-result
ordering.

`compact_skipped` records a compaction attempt that the host declined to make
(or that failed at the LLM boundary). It carries a reason code and never
mutates messages. This closes the observability gap where a summarizer failure
would previously leave the ledger silent.

## Multi-Tool Batch Safety

Unsafe sequence:

```text
system
user old task
assistant old answer
user current task
assistant tool_call c1, c2, c3, c4
tool_result c1 huge output
```

If compaction waits until `c2`, `c3`, and `c4` complete, the summarizer request
may already be too large. Agent-kernel checks pressure after `c1`. If pending
sibling calls remain and the prompt estimate violates preflight headroom, the
host runs `tool_result` compaction before the next pending tool effect.

Safe compacted state:

```text
system original system prompt
system compacted summary of old task
user current task
assistant tool_call c1, c2, c3, c4
tool_result c1 head/tail preview
```

The active assistant message survives, so `c2`, `c3`, and `c4` can still return
valid tool results.

If mid-batch compaction fails or is rejected by the reducer, the host records
`compact_skipped` and lets the batch continue. The next preflight check may
try again, but the same-batch back-off (see **Back-Off Discipline**) prevents
tight looping.

## Cut-Point Selection

The pivot must satisfy all of:

1. It is a `user` message index (not a `tool_result`, not an assistant with a
   pending call).
2. All messages `[0, preserveFrom)` contain compactable content
   (i.e. there is something worth summarizing).
3. If the session is `executing_tools`, every pending tool call's originating
   assistant `tool_call` message is inside `[preserveFrom, len)`.
4. The tail `[preserveFrom, len)` fits inside `recentTailTargetTokens`,
   with a fallback that keeps at least the active tool batch's parent user
   message when the tail is naturally larger than the target.

`recentTailTargetTokens`:

- no known context limit: 12,000 estimated tokens,
- known context limit: 15% of the context window,
- bounded between 4,000 and 24,000 estimated tokens.

## Summarizer Retry Ladder

The summarizer is a normal LLM call with `tools: []` and (when the adapter
supports it) reasoning disabled  -  a summary should not spend reasoning tokens
that will not be replayed. Each attempt is one of:

| Attempt | Tool-result cap per old message | Head-drop groups |
| --- | --- | --- |
| 1 | 8,000 chars | 0 |
| 2 | 2,000 chars | 0 |
| 3 | 2,000 chars | 1 oldest group |
| 4 | 2,000 chars | 2 oldest groups |

A "group" is defined as one assistant message plus its subsequent tool_result
messages, so head-dropping preserves tool_call/tool_result pairing. Group
detection walks the prepared summarizer input from the start; adjacent
tool_results without a preceding assistant are dropped as a fifth-column
prefix along with the group.

Failure classification uses **both** a typed error kind (when the adapter
raises one) and a heuristic regex on the message text as fallback. The regex
matches `context|window|token|too large|maximum input|input exceeds|prompt is
too long`. Non-context errors do not consume retry attempts; they bubble up as
compaction failures.

Attempts stop when:

- an attempt succeeds and returns a non-empty summary that passes fatal-check
  validation, or
- the retry ladder is exhausted, or
- a non-context error propagates.

Successful compaction resets the per-session consecutive-failure counter.

## Consecutive-Failure Circuit Breaker

The host maintains `consecutiveCompactFailures` per session. Rules:

- Every failed compaction attempt (LLM error, exhausted ladder, empty summary,
  fatal validation reason) increments the counter.
- Every successful compaction resets the counter to 0.
- When the counter reaches `MAX_CONSECUTIVE_COMPACT_FAILURES = 3`, all
  `auto`, `preflight`, and `tool_result` triggers become no-ops for the rest
  of the session and dispatch `compact_skipped` with reason
  `circuit_breaker_open`.
- `manual` compaction (`/compact`) always attempts, regardless of breaker
  state  -  a human explicitly asked. A successful manual compaction closes the
  breaker.

This mirrors Claude Code's `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` but adds an
explicit manual escape hatch.

## Back-Off Discipline

Within a single tool batch, a failed `tool_result` compaction sets a
per-session `mutedUntilBatchId` marker. Further `tool_result` triggers in the
same batch are skipped with reason `back_off_same_batch`, preventing tight
loop of retries on every subsequent tool result.

## Unknown Context Window Fallback

Provider metadata is not always complete. When `config.contextLimit` is
undefined:

- `state.contextPressureLevel` remains `'none'` (auto never fires).
- Preflight uses a synthetic fallback limit of `128_000` tokens and reserves
  the higher of 16k or 12% of that. Sessions on tiny models will therefore
  overshoot before triggering  -  this is acceptable because the LLM adapter
  will surface the real error; preflight is a best-effort brake, not a
  guarantee.
- `tool_result` compaction uses the same fallback for its estimate.
- Manual `/compact` always works because it does not depend on the limit.

When the adapter first reports a context window (via provider usage metadata
or a `context_window_exceeded` error whose message contains a limit), the host
updates the session's derived limit for future triggers. This is a
best-effort inference; it does not overwrite explicit configuration.

## Small-Context Model Behavior

For context limits below `16_000` tokens, the fixed floors above (4k tail
minimum, 8k preflight reserve, 16k tool-result cap) are recomputed as ratios:

- recent tail: 40% of context, minimum 1,500 tokens,
- preflight reserve: 25% of context,
- tool-result inline cap: 40% of context, minimum 1,000 tokens.

This prevents "the constants sum to more than the window" pathologies on
small-context models. The bounds are chosen to still fit a system prompt +
one user turn + a summary on a 4k model, degrading to "compaction disabled in
practice" below ~2k where no summary would fit.

## Reasoning-Model Behavior

If the current session model supports reasoning (Anthropic extended thinking,
OpenAI o1 family):

- The summarizer request explicitly disables reasoning
  (`extendedThinkingTokens: 0` or the provider equivalent). A summary should
  not burn 4k reasoning tokens that will not be replayed.
- The reasoning budget is subtracted from the preflight reserve for regular
  turns. A 200k model with a 16k reasoning budget effectively has 184k for
  input + output.

## Post-Compact Cleanup

After a successful `compact_replaced`, the host arms a **post-compaction loop
guard** (`POST_COMPACTION_GUARD_CALLS = 6`). The next few tool calls the model
emits are inspected against a small recent-call fingerprint set; a repeat
within the guard window is treated as a suspected compaction-induced loop and
suppressed. This is the one cleanup step that is a correctness feature, not
observability. Arming is skipped when the trigger is `tool_result` (mid-batch
guarding would starve legitimate follow-up calls) and skipped when the attempt
was rejected/skipped (there is nothing to loop back on).

The following cleanup categories are called out because reference
implementations depend on them, but agent-kernel does not yet maintain the
underlying caches:

- **Prompt cache marker**: agent-kernel does not currently persist a cache
  breakpoint across turns  -  the Anthropic adapter places cache markers
  dynamically per request, so there is nothing to invalidate. If a persistent
  breakpoint is ever added, it MUST be cleared here.
- **File-read cache**: not implemented. If added later, entries whose source
  message is inside the summarized prefix must be dropped.
- **Warning state**: derived from `state.contextPressureLevel`, which the
  reducer recomputes on the next `usage` update, so it is self-healing today.
- **Skills-installed set**: also not persisted server-side yet; when it is,
  it must be preserved across compaction (already-installed skills should not
  re-announce themselves).

Cleanup does **not** run on `compact_rejected` or `compact_skipped`; there is
nothing to clean up because nothing was replaced.

## Tool Result Bounding

Agent-kernel has two complementary layers:

- **Executor overflow** stores large complete outputs outside the transcript
  and returns a preview plus a pointer. See `docs/host/tool-output-overflow.md`.
- **Host compaction input trimming** reduces old oversized `tool_result` blocks
  before the summarizer sees them.

Model-visible tool-result bounding target:

- target: 10% of the context window,
- minimum: about 2,000 estimated tokens,
- maximum: about 16,000 estimated tokens,
- head/tail split: 60% / 40%.

Summarizer input tool-result caps (see **Summarizer Retry Ladder**):

- attempts 1: 8,000 characters,
- attempts 2+: 2,000 characters.

## Threshold Policy

Reserve budgeting accounts for:

- the next assistant answer,
- provider tool schemas,
- reasoning/thinking budget when enabled,
- pending sibling tool results,
- the compaction prompt and summary response.

Preflight reserve = `min(max(8000, 0.12 * contextLimit), 0.25 * contextLimit)`.

Hard pressure threshold defaults to 0.92, soft to 0.75. These are configurable
via `AgentConfig.hardThreshold` / `softThreshold`.

Budget partition observability lives in message assembly artifacts; partitions
are not yet enforced as hard gates for every provider request (tracked in
**Known Gaps**).

## Summary Validation

The summarizer prompt requires this Markdown shape:

```text
# Compacted Context
## User Intent And Constraints
## Repository And Runtime State
## Decisions And Rationale
## Work Completed
## Open Work
```

`validateCompactionSummary` from `@agent-kernel/shared/enhancement` returns a
reason code:

- `schema_ok`  -  apply the summary.
- `missing_sections`  -  apply but flag; this is a soft signal (older sessions
  used shorter summaries).
- `empty_sections`  -  apply but flag.
- `empty_summary`  -  **fatal**; reject the summary and treat as a compaction
  failure (feeds circuit breaker).

Rejected summaries are logged to
`compaction-summaries/<session_id>/<seq>.json` with the reason and the raw
text so operators can debug.

## Concurrency and Reentrancy

- The host maintains an in-process `Set<sessionId>` of in-flight compactions.
  While a session is compacting, subsequent `runCompact` calls return without
  starting a second.
- A new `client:user_message` that arrives during compaction is queued as a
  normal event; the reducer will accept it at whichever step order matches
  the ledger.
- Tool results streaming in during compaction: `maybeCompactAfterToolResult`
  checks the in-flight set and skips.
- Host restart during compaction: the ledger contains no `compact_replaced`
  for the incomplete attempt (host writes the event only after summarizer
  success and reducer acceptance). Replay reconstructs the pre-compaction
  state; the next pressure check will re-trigger compaction naturally.

## Event Schema

- `compact_replaced` (existing): applied when compaction succeeded and the
  reducer accepted the pivot. Carries `trigger`, `preserveFrom`, summarizer
  `request`, optional `responseUsage`, `summary`, `replacedCount`,
  `tokensBefore`, `tokensAfter`, and (new) optional `attemptId` for
  cross-referencing telemetry.
- `compact_skipped` (new): applied for every compaction attempt that was
  declined or failed at the host before dispatch. Fields: `trigger`,
  `reason` (one of `circuit_breaker_open`, `back_off_same_batch`,
  `summarizer_failed`, `empty_summary`, `no_compactable_content`,
  `session_busy`), `attemptId`, optional
  `errorMessage`. Never mutates messages.
- `compact_rejected` (new): applied only by the reducer when a
  `compact_replaced` would violate pending tool-call pairing or leading
  system-prompt invariants. Fields: `attemptId`, `reason`
  (`pending_call_orphaned` or `invalid_preserve_from`). The host reads this
  reduced state to know the reducer refused, then records the failure in the
  circuit-breaker counter.

All three events are protocol-adjacent and appear in the JSONL ledger. Only
`compact_replaced` changes `state.messages`.

## Testing Matrix

Required coverage:

- manual compaction from a resting session,
- automatic compaction at hard context pressure,
- preflight compaction before oversized model requests,
- multi-tool batch where the first result is huge and pending sibling calls
  remain,
- mid-batch compaction preserving the active assistant tool-call message,
- reducer protection against orphan pending calls (emits `compact_rejected`),
- summarizer context-overflow retry ladder: cap tightening + head-drop,
- consecutive-failure circuit breaker opens after 3 failed auto attempts,
- circuit breaker closes on successful manual compaction,
- back-off within a single tool batch after one failed attempt,
- summary validation artifact generation,
- fatal `empty_summary` rejection increments the failure counter,
- small-context-model thresholds do not preserve an oversized fixed tail,
- unknown-context-limit path uses fallback in preflight and disables auto,
- reasoning-model summarizer request has reasoning disabled.

## Known Gaps

- **Focused manual compaction** such as `/compact focus on auth bug` is not
  wired through the protocol yet.
- **Startup context re-injection** is limited to the leading system prompt.
  Future skill bodies, root instructions, memory, and path-scoped rules should
  declare whether they survive compaction or must be reloaded later.
- **Budget partitions are not enforced gates**. They are visible in message
  assembly artifacts, but host policy does not yet use every partition reason
  to downshift, compact, or reject a request.
- **Token estimation is approximate**. It is sufficient for headroom
  decisions, but it is not a replacement for provider-reported usage. Reserve
  math should be recomputed against actual usage after every real turn.
- **Cross-session boundary IDs**: the ledger records `compact_replaced` but
  does not yet carry a compaction-window ID that survives replay. This makes
  it harder to attribute post-compaction behavior to a specific compaction.

## Related Documents

- `docs/host/tool-output-overflow.md` covers executor-side large-output spillover.
- `docs/planning/enhancement/05-context-engineering-engine.md` covers the
  broader context assembly and budget observability roadmap.
- `docs/protocol/event-log.md` and `docs/protocol/wire-protocol.md` define
  the ledger and dashboard protocol surfaces for `compact_replaced`,
  `compact_skipped`, and `compact_rejected`.

## References

[1] https://github.com/openai/codex/blob/98d28aab54ed86714901b6619400598598876dd0/codex-rs/core/src/tasks/compact.rs

[2] https://github.com/openai/codex/blob/98d28aab54ed86714901b6619400598598876dd0/codex-rs/core/src/compact.rs

[3] https://github.com/openai/codex/blob/98d28aab54ed86714901b6619400598598876dd0/codex-rs/core/src/state/auto_compact_window.rs

[4] https://github.com/openai/codex/blob/98d28aab54ed86714901b6619400598598876dd0/codex-rs/prompts/templates/compact/prompt.md

[5] https://github.com/chauncygu/collection-claude-code-source-code/blob/b934603b2800374b315b25061bbeffb40ab6ab26/claude-code-source-code/src/services/compact/autoCompact.ts

[6] https://github.com/chauncygu/collection-claude-code-source-code/blob/b934603b2800374b315b25061bbeffb40ab6ab26/claude-code-source-code/src/services/compact/compact.ts

[7] https://github.com/chauncygu/collection-claude-code-source-code/blob/b934603b2800374b315b25061bbeffb40ab6ab26/claude-code-source-code/src/commands/compact/compact.ts

[8] https://github.com/chauncygu/collection-claude-code-source-code/blob/b934603b2800374b315b25061bbeffb40ab6ab26/claude-code-source-code/src/services/compact/microCompact.ts

[9] https://github.com/chauncygu/collection-claude-code-source-code/blob/b934603b2800374b315b25061bbeffb40ab6ab26/claude-code-source-code/src/services/compact/sessionMemoryCompact.ts

[10] https://github.com/chauncygu/collection-claude-code-source-code/blob/b934603b2800374b315b25061bbeffb40ab6ab26/claude-code-source-code/src/services/compact/postCompactCleanup.ts

[11] https://github.com/sst/opencode/blob/7a8e7c88f495acf5af3e7584e8ec1dbab2fe04ec/packages/opencode/src/session/overflow.ts

[12] https://github.com/sst/opencode/blob/7a8e7c88f495acf5af3e7584e8ec1dbab2fe04ec/packages/opencode/src/session/compaction.ts

[13] https://github.com/sst/opencode/blob/7a8e7c88f495acf5af3e7584e8ec1dbab2fe04ec/packages/opencode/src/tool/truncate.ts

[14] https://github.com/sst/opencode/blob/7a8e7c88f495acf5af3e7584e8ec1dbab2fe04ec/packages/opencode/src/session/message-v2.ts

[15] https://github.com/earendil-works/pi/blob/ee24a9ec54a9602d55dc7ac767c270cec806c291/packages/coding-agent/src/core/compaction/compaction.ts

[16] https://github.com/earendil-works/pi/blob/ee24a9ec54a9602d55dc7ac767c270cec806c291/packages/coding-agent/src/core/compaction/utils.ts

[17] https://github.com/earendil-works/pi/blob/ee24a9ec54a9602d55dc7ac767c270cec806c291/packages/coding-agent/src/core/compaction/branch-summarization.ts

[18] https://github.com/earendil-works/pi/blob/ee24a9ec54a9602d55dc7ac767c270cec806c291/packages/coding-agent/test/compaction.test.ts

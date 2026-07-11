# Context Compaction

**Status**: implemented with remaining quality gaps.

Agent-kernel uses host-driven context compaction. The host decides when and how
to summarize old context; the kernel only records and applies the resulting
`compact_replaced` event. This keeps replay deterministic, keeps model-specific
budget policy out of the reducer, and still makes every compaction boundary
visible in the JSONL ledger and dashboard debugger.

## Problem Statement

Long-running coding-agent sessions fail in two different ways:

1. **Cumulative pressure**: old chat, tool results, file excerpts, memory, and
   tool schemas gradually fill the model context window.
2. **Single-turn blowups**: one shell/search/test result can be large enough to
   make the next LLM request or even the compaction request itself exceed the
   model window.

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
request itself is too large.

### Codex

Primary source files:

- `references/codex/codex-rs/core/src/tasks/compact.rs`
- `references/codex/codex-rs/core/src/compact.rs`
- `references/codex/codex-rs/core/src/state/auto_compact_window.rs`
- `references/codex/codex-rs/prompts/templates/compact/prompt.md`

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
with `ContextWindowExceeded`, Codex does not give up immediately. It removes the
oldest prompt item from the cloned compaction input and tries again. Retryable
stream errors use backoff. User interruption, turn abort, or session budget
exhaustion are surfaced as terminal failures.

Codex also tracks compaction windows. `AutoCompactWindow` keeps:

- a stable first window ID,
- the previous window ID,
- the current window ID,
- a prefill input-token baseline,
- whether a token-budget reminder was delivered,
- whether a new context window was explicitly requested.

The resulting mental model is:

```text
Before:
  history = [setup, old user/assistant/tool traffic, recent user work]

Compaction request:
  model sees [setup, old user/assistant/tool traffic, recent user work, compact prompt]

After:
  history = [setup, compacted summary, selected user messages, optional reinjected context]
```

Codex's useful lesson is lifecycle rigor: compaction has task identity, hooks,
analytics, retries, window identity, and explicit replacement history.

### Claude Code

Primary source files:

- `references/claude-code-collection/claude-code-source-code/src/services/compact/autoCompact.ts`
- `references/claude-code-collection/claude-code-source-code/src/services/compact/compact.ts`
- `references/claude-code-collection/claude-code-source-code/src/commands/compact/compact.ts`
- `references/claude-code-collection/claude-code-source-code/src/services/compact/microCompact.ts`
- `references/claude-code-collection/claude-code-source-code/src/services/compact/sessionMemoryCompact.ts`
- `references/claude-code-collection/claude-code-source-code/src/services/compact/postCompactCleanup.ts`

Claude Code has several compaction paths. The important point is that `/compact`
and auto-compact do not directly mean "summarize everything now". They first try
cheaper or safer reductions.

Auto-trigger path:

```text
shouldAutoCompact(messages, model, querySource, snipTokensFreed)
  -> reject recursive/incompatible sources
       querySource == session_memory -> false
       querySource == compact        -> false
       reactive-only/context-collapse modes can also suppress auto compact
  -> tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  -> effectiveWindow = contextWindow(model) - reservedSummaryOutputTokens
  -> threshold = effectiveWindow - 13_000
  -> return tokenCount >= threshold
```

The output reserve is explicit. Claude Code reserves up to `20_000` output tokens
for the summary itself. That means a 200k context model is not treated as "safe
until 200k input tokens". It is treated as "safe only while there is still room
for the compact prompt and summary response".

If auto-trigger says yes:

```text
autoCompactIfNeeded
  -> if DISABLE_COMPACT, do nothing
  -> if consecutiveFailures >= 3, do nothing
  -> trySessionMemoryCompaction(messages, agentId, autoCompactThreshold)
       success -> reset summarized-message pointer
               -> runPostCompactCleanup
               -> mark post-compaction state
               -> return compacted
  -> compactConversation(... isAutoCompact=true, suppressUserQuestions=true)
       success -> reset summarized-message pointer
               -> runPostCompactCleanup
               -> reset consecutiveFailures to 0
       failure -> increment consecutiveFailures
               -> after 3 failures, stop automatic retry attempts this session
```

Manual `/compact` path:

```text
/compact [optional custom instructions]
  -> getMessagesAfterCompactBoundary(messages)
       removes already-snipped UI scrollback from the model-visible compact input
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

The concrete before/after is:

```text
Before:
  messages = [old work, compact boundary, newer work, huge tool output, current task]

Manual projection:
  compact input starts after latest compact boundary

Microcompact/session-memory pass:
  may reduce memory or tool payloads without full conversation replacement

Full compact result:
  messages = [summary message, restored file/context attachments, preserved recent work]
```

Claude Code's useful lesson is that compaction is a ladder of interventions:
session-memory compaction, microcompact, full compact, partial compact, and
prompt-too-long retry are separate tools with different cost and blast radius.

### opencode

Primary source files:

- `references/opencode/packages/opencode/src/session/overflow.ts`
- `references/opencode/packages/opencode/src/session/compaction.ts`
- `references/opencode/packages/opencode/src/tool/truncate.ts`
- `references/opencode/packages/opencode/src/session/message-v2.ts`

opencode models compaction as a session service. It stores compaction as normal
session messages and parts, then lets the compaction agent produce a summary.

Overflow decision:

```text
isOverflow({ cfg, tokens, model, outputTokenMax })
  -> if cfg.compaction.auto === false, return false
  -> if model has no context limit, return false
  -> usable = model input/context limit minus reserved output or compaction buffer
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

Selecting what to summarize:

```text
select({ messages, cfg, model })
  -> split full history into turns
  -> choose recent turns from the end
  -> estimate each recent turn after conversion to model messages
  -> preserve as many recent turns as fit in preserveRecentBudget
  -> if a full turn does not fit, split that turn if possible
  -> return { head: messages_to_summarize, tail_start_id }
```

Main compaction process:

```text
process({ parentID, messages, sessionID, auto, overflow })
  -> require parentID to refer to a user message
  -> if overflow, maybe choose a previous real user message to replay later
  -> find prior completed compactions
  -> hide prior compaction user/assistant pairs from summarizer input
  -> carry previousSummary into the new compaction prompt
  -> run plugin hook experimental.session.compacting
       hook may inject context or replace prompt
  -> run message transform hook
  -> convert selected head to model messages with stripMedia=true
  -> cap tool output passed to summarizer at 2000 characters
  -> create assistant message with mode=compaction, agent=compaction, summary=true
  -> run SessionProcessor with no tools and a final user compaction prompt
```

What happens after the compaction model returns:

```text
If processor returns "compact":
  -> compaction itself overflowed
  -> write ContextOverflowError to compaction assistant message
  -> stop

If processor returns "continue" and this was auto compaction:
  -> if replay was selected, create a new user message copying the replayed user parts
  -> otherwise optionally create a synthetic internal continue message
  -> publish Event.Compacted

If processor message has an error:
  -> stop without pretending compaction succeeded
```

The concrete session shape is:

```text
Before:
  user U1, assistant A1, tool T1, user U2, assistant A2, user U3(parent)

Compaction user part:
  user U3 contains part { type: "compaction", auto, overflow }

Compaction assistant summary:
  assistant C1 { mode: "compaction", agent: "compaction", summary: true }

Resume after auto compaction:
  either replay copied user message, or synthetic "continue" user message
```

opencode's useful lesson is that compaction should be represented in the same
session object model as other work. That gives the debugger a real parent,
assistant summary, error state, and resume message instead of a hidden mutation.

### pi

Primary source files:

- `references/pi/packages/coding-agent/src/core/compaction/compaction.ts`
- `references/pi/packages/coding-agent/src/core/compaction/utils.ts`
- `references/pi/packages/coding-agent/src/core/compaction/branch-summarization.ts`
- `references/pi/packages/coding-agent/test/compaction.test.ts`

pi's implementation is the easiest to read as an algorithm because it splits
pure preparation from IO. The session manager decides when to call compaction;
the compaction module decides what to summarize.

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

Preparation path:

```text
prepareCompaction(pathEntries, settings)
  -> if newest entry is already a compaction entry, return undefined
  -> find previous compaction entry by walking backward
  -> previousSummary = previous compaction summary, if any
  -> boundaryStart = first entry kept by previous compaction, if known
  -> tokensBefore = estimateContextTokens(buildSessionContext(pathEntries))
  -> cutPoint = findCutPoint(pathEntries, boundaryStart, end, keepRecentTokens)
  -> firstKeptEntryId = pathEntries[cutPoint.firstKeptEntryIndex].id
  -> messagesToSummarize = entries from boundaryStart to historyEnd
  -> if cut splits a turn, turnPrefixMessages = start of that turn up to cut
  -> collect file operations from previous compaction details and tool calls
  -> return CompactionPreparation
```

The cut-point rule is explicit:

```text
findCutPoint
  -> valid cut points are user, assistant, custom, bash, branch summary,
     and compaction summary entries
  -> never cut at a tool result
  -> walk backward from newest messages and accumulate estimated tokens
  -> when keepRecentTokens is reached, choose the closest valid cut point
  -> include adjacent non-message entries before the cut if needed
  -> report whether this cut splits a turn
```

Summary generation path:

```text
compact(preparation, model, apiKey, customInstructions, ...)
  -> if cut split a turn:
       generateSummary(messagesToSummarize, previousSummary, customInstructions)
       generateTurnPrefixSummary(turnPrefixMessages)
       merge the two summaries with a "Turn Context" separator
     else:
       generateSummary(messagesToSummarize, previousSummary, customInstructions)
  -> compute readFiles and modifiedFiles from tracked file operations
  -> append <read-files> and <modified-files> blocks to the summary
  -> return { summary, firstKeptEntryId, tokensBefore, details }
```

The summarizer input is not sent as a normal chat continuation. `utils.ts`
serializes it into text like:

```text
[User]: please fix auth

[Assistant tool calls]: read(path="src/auth.ts")

[Tool result]: export function login(...) { ... truncated ... }
```

Tool results are truncated to `2_000` characters in this serialized summary
input. The system prompt explicitly says to summarize the conversation and not
continue it.

The concrete state shape is:

```text
Before path entries:
  header, old messages, previous compaction?, current turn prefix, recent suffix

Preparation result:
  summary input        = old messages after previous boundary
  optional turn prefix = beginning of current turn if the cut is mid-turn
  preserved tail       = entries starting at firstKeptEntryId

After session manager saves result:
  compaction entry { summary, firstKeptEntryId, tokensBefore, details }
  plus all entries from firstKeptEntryId onward
```

pi's useful lesson is that the hard parts can be tested as pure functions:
token estimation, valid cut points, previous-boundary handling, split-turn
prefix handling, and file-operation extraction do not need a live model call.

### Design Takeaways For Agent-Kernel

The references suggest these concrete requirements for agent-kernel:

- Compaction must reserve room for the summary response, not only shrink input.
- The summarizer request needs its own retry strategy when it is too large.
- Tool outputs should be bounded before summarization and, ideally, before they
  ever enter normal model-visible history.
- The preserved tail must respect provider tool-call/tool-result pairing.
- Previous summaries should be threaded forward, but previous compaction turns
  should not be repeatedly summarized as ordinary chat.
- Post-compaction cleanup is correctness work: prompt cache baselines, file-read
  caches, warning state, message IDs, and context-injection state may all become
  stale after replacement.
- The reducer should remain policy-light, but cut-point selection and summary
  preparation should be small, testable policy functions.

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

1. Host chooses a safe `preserveFrom` pivot.
2. Messages before the pivot are copied into the summarizer request after old
   oversized tool results are reduced to head/tail excerpts.
3. Messages from the pivot onward are preserved verbatim.
4. The summarizer receives a structured engineering-handoff prompt with required
   sections: user intent and constraints, repository/runtime state, decisions
   and rationale, work completed, and open work.
5. If the summarizer fails with a context-window style error, host retries with
   a more aggressive tool-result limit.
6. Host validates the summary shape and writes a validation artifact when
   artifact capture is enabled.
7. Host dispatches `compact_replaced` with `trigger`, `preserveFrom`, summarizer
   request metadata, optional response usage, summary text, and estimated
   before/after token counts.
8. The reducer keeps the leading system prompt, inserts the synthetic compacted
   summary as a system message, and appends the preserved tail.

## Protocol Invariants

`compact_replaced` is protocol-adjacent: replay must see the message
replacement, but summarizer IO remains host-owned metadata.

The reducer invariant is:

- preserve the leading system prompt,
- insert exactly one synthetic compact summary message,
- preserve messages at or after `preserveFrom`,
- reject or ignore compact replacements that would violate pending tool-call
  pairing.

When the session is `executing_tools`, a `compact_replaced` event is valid only
if every pending tool call still has its originating assistant `tool_call` in the
preserved tail. This protects OpenAI/Anthropic-style tool-call/tool-result
ordering.

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

## Tool Result Bounding

Agent-kernel has two complementary layers:

- **Executor overflow** stores large complete outputs outside the transcript and
  returns a preview plus a pointer. See `docs/host/tool-output-overflow.md`.
- **Host compaction input trimming** reduces old oversized `tool_result` blocks
  before the summarizer sees them.

The executor overflow layer is the preferred place to keep raw output. The host
compaction layer is a circuit breaker that prevents stale log dumps from making
the summarizer impossible to call.

Implemented summarizer input limits:

- normal compaction input keeps at most 8,000 characters per old tool result,
- retry after context-window failure keeps at most 2,000 characters per old tool
  result.

Design target for model-visible tool-result bounding remains model-aware:

- target: 10% of the context window,
- minimum: about 2,000 estimated tokens,
- maximum: about 16,000 estimated tokens,
- head/tail split: 60% / 40%.

## Threshold Policy

Recent-tail preservation is model-aware:

- no known context limit: 12,000 estimated tokens,
- known context limit: 15% of the context window,
- bounded between 4,000 and 24,000 estimated tokens.

Reserve budgeting should account for:

- the next assistant answer,
- provider tool schemas,
- reasoning/thinking budget when enabled,
- pending sibling tool results,
- the compaction prompt and summary response.

Budget partition observability exists in message assembly artifacts, but budget
partitions are not yet hard gates for every provider request.

## Summary Quality

The summarizer prompt requires this Markdown shape:

```text
# Compacted Context
## User Intent And Constraints
## Repository And Runtime State
## Decisions And Rationale
## Work Completed
## Open Work
```

The host validates the generated summary with
`validateCompactionSummary` from `@agent-kernel/shared/enhancement` and writes a
`compaction-summaries/<session_id>/<seq>.json` artifact when artifact capture is
enabled. The report uses low-cardinality reason codes such as `empty_summary`,
`missing_sections`, `empty_sections`, and `schema_ok`.

Current behavior labels bad summaries for observability. It does not yet reject,
retry with a schema hint, or block ledger insertion when the summary is
incomplete.

## Testing Matrix

Required and implemented coverage should include:

- manual compaction from a resting session,
- automatic compaction at hard context pressure,
- preflight compaction before oversized model requests,
- multi-tool batch where the first result is huge and pending sibling calls
  remain,
- mid-batch compaction preserving the active assistant tool-call message,
- reducer protection against orphan pending calls,
- summarizer context-overflow retry with more aggressive trimming,
- summary validation artifact generation,
- small-context model thresholds that do not preserve an oversized fixed tail.

## Known Gaps

- **Focused manual compaction** such as `/compact focus on auth bug` is not wired
  through the protocol yet.
- **Startup context re-injection** is limited to the leading system prompt.
  Future skill bodies, root instructions, memory, and path-scoped rules should
  declare whether they survive compaction or must be reloaded later.
- **Summary validation is observational**. Bad summaries are labeled but not yet
  rejected or retried with a schema-specific hint.
- **Budget partitions are not enforced gates**. They are visible in message
  assembly artifacts, but host policy does not yet use every partition reason to
  downshift, compact, or reject a request.
- **Token estimation is approximate**. It is sufficient for headroom decisions,
  but it is not a replacement for provider-reported usage.

## Related Documents

- `docs/host/tool-output-overflow.md` covers executor-side large-output spillover.
- `docs/planning/enhancement/05-context-engineering-engine.md` covers the broader context
  assembly and budget observability roadmap.
- `docs/protocol/event-log.md` and `docs/protocol/wire-protocol.md` define the
  ledger and dashboard protocol surfaces for `compact_replaced`.

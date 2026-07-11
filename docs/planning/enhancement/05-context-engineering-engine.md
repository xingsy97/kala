# Context Engineering Engine

Status: partially implemented; observability stronger than policy
Priority: 5
Last reviewed against implementation: 2026-07-09

## Why This Matters

For coding agents, context engineering is often more important than the model
choice. The agent must assemble system instructions, user intent, recent turns,
tool results, file excerpts, memory, skills, and compaction summaries without
silently dropping the critical fact that would solve the task.

The project has context compaction, a message assembly debugger, and host-side
message assembly artifacts. The important boundary is that assembly is now
inspectable and testable without turning provider request formatting into kernel
state.

## Production References

- Codex, Claude Code, and opencode all treat context as an explicit budget and
  expose manual or automatic compaction.
- OpenTelemetry GenAI has explicit fields for system instructions, input
  messages, prompt variables, tool definitions, and compaction indication.
- OpenTelemetry warns that full content capture is opt-in because it can be
  sensitive and large.

## Design Principle

Context engineering belongs in the host/adapter layer. The kernel should only
own canonical messages and state transitions.

## Assembly Pipeline

Make the host's provider request assembly a named pipeline:

1. Base kernel messages from replayed state.
2. Durable system prompt and surviving compact summary.
3. Active user turn and recent unclosed tool-call chain.
4. Tool registry materialization.
5. Skill/tool overlays, if enabled.
6. Memory/retrieval inserts, if enabled.
7. Provider-specific formatting.
8. Redaction/capture for debug artifacts.

Each stage should emit metadata:

- stage name
- input/output message count
- estimated tokens
- dropped or truncated items
- reason codes
- artifact references

Implemented live message assembly artifacts are written under
`message-assembly/<session_id>/<event_seq>.json` when artifact capture is
enabled. They currently record final kernel messages, tool registry size,
estimated token contribution by category, and named pipeline stages without
changing the provider request or the replay ledger.

Implemented contribution categories include system, user, assistant, tool, tool
registry, images, thinking blocks, and memory. Memory contribution is derived
only from structured `memory` tool calls and matching tool results already
present in kernel messages. The host does not infer memory from arbitrary text
and does not inject hidden memory content.

Implemented stages include `kernel.messages`, `tool.registry`,
`memory.contribution`, `host.preflight`, and `provider.adapter`. These stages
make the request pipeline explicit: canonical reducer messages, available tool
schemas, structured memory tool context, host preflight/compaction output, and
the adapter boundary that turns normalized messages/tools into provider request
shape. The memory stage records whether memory tool context is present, its
estimated token contribution, and dropped memory tool items if preflight
compaction removes them.

When the session `contextLimit` is known, the same artifact carries a `budget`
block with explicit partitions: `fixed_instructions`, `tool_schemas`,
`active_turn`, `recent_tail`, `retrieved_memory`, `output_reserve`, and
`compaction_reserve`. Each partition reports an estimated-token contribution
and low-cardinality reason codes (`active_turn_missing`, `memory_present`,
`partition_over_budget`, `near_budget`, `over_budget`). This makes the
Budgeting Policy visible per LLM call without adding budget accounting to the
reducer.

## Budgeting Policy

Use explicit budget partitions:

- Fixed instructions and tool schemas.
- Active turn and latest tool chain.
- Recent conversation tail.
- Retrieved memory/files.
- Reserve for model output.
- Reserve for compaction/summarization.

The active user turn and open tool-call chain should have the strongest
retention guarantee. Old tool output should be summarized or truncated before it
forces out current task context.

## Compaction Quality

The current compaction approach already preserves a recent tail and summarizes
the stale prefix. Production-level improvements:

- Focused manual compaction, e.g. compact around a named objective.
- Summary schema with required sections: user intent, files touched, commands
  run, decisions, failures, open work, and constraints.
- Verification pass that rejects summaries missing required facts.
- Compaction trace artifact showing replaced event range and preserved tail.
- Loop guard after compaction to prevent repeating the same failed action.

Implemented schema validation: after every `runCompact`, the host validates
the summarizer output against the required-section schema (user intent,
repository/runtime state, decisions, work completed, open work) using
`validateCompactionSummary` from `@agent-kernel/shared/enhancement`. The
validation report is written as a
`compaction-summaries/<session_id>/<seq>.json` artifact so bad summaries are
labeled with low-cardinality reason codes (`empty_summary`,
`missing_sections`, `empty_sections`, `schema_ok`) instead of silently
polluting future context. The validator is pure text  -  it does not add
validation state to the kernel and does not gate replay.

## Message Assembler UI

The debugger should show:

- Final provider messages in order.
- Contribution breakdown by source category: system, user, assistant, tool,
  compaction, memory, skills, tool registry.
- Token estimate per category and per message.
- Pipeline stages with compact summary cells, not a verbose table.
- Full API body only in the `API Call` tab, not duplicated here.

Internal implementation field names should not leak into user-facing labels.
Show concepts like `System Instructions`, `Tool Registry`, `Recent Conversation`,
and `Compaction Summary`.

## Testing Plan

- Unit tests for retention ordering under tight budgets.
- Snapshot tests for assembled messages from representative sessions.
- Tests that tool-call/tool-result pairs are not split incorrectly.
- Implemented tests for structured memory tool contribution in assembly
  artifacts.
- Implemented tests for the named assembly pipeline stages, including tool
  registry token contribution and provider adapter boundary metadata.
- Implemented headless browser coverage in `scripts/verify-dashboard-debugger.mjs`
  for Message Assembler contribution proportions, context segment selection,
  tool-registry visibility, API Call request/response separation, API body
  redaction, and the absence of duplicated API body rendering in the assembler.
- Tests that compaction summaries preserve required fields.

## Non-Goals

- Do not add context budget logic to the reducer.
- Do not use ad hoc string parsing for structured messages.
- Do not silently drop active user intent or open tool chains.

## Current Implementation Alignment

### Implemented In Code

The current implementation has meaningful context observability:

- Message assembly artifacts are written under
  `message-assembly/<session_id>/<event_seq>.json` when artifact capture is
  enabled.
- Artifacts record kernel message counts, tool registry size, category token
  estimates, and named stages such as `kernel.messages`, `tool.registry`,
  `memory.contribution`, `host.preflight`, and `provider.adapter`.
- The debugger LLM API modal has a `Message Assembler` tab that shows assembly
  stages and context contribution proportions separately from the provider API
  body.
- The `API Call` tab shows the actual request/response artifacts, avoiding
  duplicate or fake request-body displays.
- Context compaction is represented as `compact_replaced` events in the JSONL
  ledger, with dashboard detail views for compaction request/summary metadata
  when available.
- Structured memory contribution is counted only from explicit memory tool calls
  and matching tool results already present in kernel messages.
- Browser debugger e2e covers tool registry visibility, context proportions,
  API separation, and redaction behavior.

### Important Gaps

- Budget partitions are implemented but not yet enforced: partition reason
  codes such as `over_budget` and `near_budget` are observability signals, not
  yet gates that reject or downshift a request.
- Compaction quality is not yet production-level: the required-section schema
  validator now labels bad summaries, but there is no automatic retry, no
  objective-focused compaction UI, and limited loop guards after compaction.
- Tool-call/tool-result retention policies are not yet enforced as explicit
  invariants under tight budgets.
- The UI still needs a clearer user-facing explanation of where system prompt,
  tool registry, memory, compaction summary, and provider adapter output appear.
- Token estimates are approximate; provider-specific tokenizer accounting is not
  yet integrated.

### Production Quality Criteria

Context engineering is production-level when:

- Every LLM call has an auditable assembly artifact with stage-level token
  budgets, dropped/truncated item reasons, and stable references to source
  messages/artifacts.
- Active user intent and open tool-call chains have tested retention guarantees.
- Compaction summaries follow a required schema and are rejected or retried when
  they omit critical facts.
- Dashboard can explain context composition without exposing internal field names
  or duplicating API body content.
- Benchmark runs record context/compaction policy in experiment metadata.

### Next Implementation Steps

1. Turn budget partition reason codes (`over_budget`, `near_budget`,
   `active_turn_missing`) into a preflight gate that can request focused
   compaction or drop old tool output before the LLM call.
2. Add automatic retry-with-schema hint when `validateCompactionSummary`
   reports `missing_sections`/`empty_sections`, so a single bad summary does
   not survive to the ledger.
3. Add tests that force tight budgets and verify active user/tool-chain
   retention.
4. Add objective-focused manual compaction UI using existing host compaction
   hooks rather than reducer state.
5. Add experiment metadata fields for context policy and compaction policy.

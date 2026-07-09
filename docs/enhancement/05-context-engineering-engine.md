# Context Engineering Engine

Status: proposed enhancement  
Priority: 5

## Why This Matters

For coding agents, context engineering is often more important than the model
choice. The agent must assemble system instructions, user intent, recent turns,
tool results, file excerpts, memory, skills, and compaction summaries without
silently dropping the critical fact that would solve the task.

The project already has context compaction and a message assembly debugger. The
next step is to turn context assembly into an inspectable, testable subsystem
with production-level policies.

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
- Tests that compaction summaries preserve required fields.
- Browser tests for token breakdown and no duplicate API body rendering.

## Non-Goals

- Do not add context budget logic to the reducer.
- Do not use ad hoc string parsing for structured messages.
- Do not silently drop active user intent or open tool chains.


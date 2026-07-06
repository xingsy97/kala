# Context Compaction

Agent-kernel uses host-driven context compaction: the kernel records and applies
the resulting event, while the host decides when and how to summarize. This keeps
replay deterministic and keeps provider-specific compaction behavior out of the
pure reducer.

## References

- Codex documents `/compact`, automatic compaction, configurable compact prompts,
  and token thresholds. It also treats context as an explicit budget, not an
  infinite transcript.
- Claude Code documents the context window as a mixture of system prompt,
  memory, rules, skill metadata, tool outputs, file reads, and visible chat. Its
  compaction preserves durable startup context by re-injecting it and summarizes
  older message history. It also documents focused manual compaction and separate
  subagent contexts for large reads.
- Claude's platform compaction API summarizes older content near the threshold
  and continues from a `compaction` block rather than forcing the client to keep
  every old message.
- opencode exposes `compaction.auto`, `compaction.prune`, and a reserved token
  buffer. This is the right shape for an agent runtime: automatic compaction,
  optional tool-output pruning, and enough headroom for the summarizer itself.

## Current Mechanism

1. The reducer derives `contextPressureLevel` from reported input tokens and the
   configured context limit.
2. The host triggers compaction manually from `/compact` or automatically at the
   hard pressure tier, only when the session is at rest.
3. The host chooses a safe pivot at a recent `user` message. Everything before
   the pivot is summarized; everything from the pivot onward is kept verbatim.
   This avoids preserving orphan `tool_result` messages without their matching
   assistant `tool_call`.
4. The summarizer receives only the old prefix and a structured prompt. The
   output is a durable engineering handoff with sections for user intent,
   repository/runtime state, decisions, completed work, and open work.
5. The host dispatches `compact_replaced` with `preserveFrom`. The reducer keeps
   the leading system prompt, inserts the compacted summary as a synthetic system
   message, and appends the preserved recent tail.

## Why This Shape

Replacing the whole transcript with one short paragraph loses local continuity:
the agent forgets the exact latest request, current tool-call chain, and recent
verification output. Keeping the latest user turn verbatim matches the practical
pattern used by mature coding agents: summarize the stale prefix, preserve the
active working set.

The summary prompt is intentionally structured. Generic summaries tend to retain
conversation prose while dropping the facts needed to continue engineering work:
file paths, commands, failing tests, user corrections, open tasks, and rationale.

## Known Gaps

- Manual focused compaction such as `/compact focus on auth bug` is not wired
  through the protocol yet.
- Tool-output pruning before full summarization is not implemented. opencode's
  `prune` option is a good model: old bulky tool outputs can often be replaced
  with command/status/decisive-lines without paying for a summarizer call.
- Startup context re-injection is limited to the leading system prompt today.
  Future skill bodies, root instructions, memory, and path-scoped rule systems
  should declare whether they survive compaction or must be reloaded later.


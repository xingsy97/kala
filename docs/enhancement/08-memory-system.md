# Memory System

Status: proposed enhancement  
Priority: 8

## Why This Matters

Agent memory matters for repeated work: project conventions, user preferences,
past fixes, and durable facts. Bad memory is dangerous because stale or
untrusted memories silently poison context. A production memory design needs
provenance, scope, scoring, decay, and inspectability.

## Design Principle

Memory should be retrieved and assembled by host-side context engineering. The
kernel may record memory tool events, but it should not own ranking, embedding,
or long-term storage policy.

## Memory Types

Use explicit scopes:

- Session memory: facts useful within one session.
- Workspace memory: project conventions and commands.
- User memory: stable user preferences.
- Eval memory: disabled by default for benchmarks unless explicitly testing
  memory behavior.

Each memory record should include content, scope, source session/event, created
time, updated time, confidence, and tombstone status.

## Retrieval Pipeline

1. Build query from active user turn and current task metadata.
2. Filter by scope and workspace.
3. Retrieve candidates by lexical and vector search.
4. Rerank with recency, source reliability, and task relevance.
5. Fit selected memories into a budget partition.
6. Add memory contribution metadata to message assembly trace.

## Write Policy

Avoid automatic memory writes for every message. Good candidates:

- Explicit user preference.
- Repeated project command or convention verified by tool output.
- Stable repository-specific fact.
- Correction from user after agent mistake.

Memory writes should be visible and reversible in dashboard.

Implemented memory index export:

```bash
agent-kernel-host enhancement memory index \
  --root-dir runs/memory \
  --workspace-root /path/to/workspace \
  --include-global
```

The command reads workspace/global `.agent-kernel/memory/*.md` files, extracts
frontmatter such as `name`, `description`, `type`, `source`, `confidence`,
`generatedAt`, and `sessionId`, and writes `memory-index.json`. It does not add
memory to kernel state and does not inject memory into prompts. It is a derived
artifact for dashboard provenance, eval reproducibility, and cleanup tooling.

Workspace/global delete is implemented as a tombstone, not a hard erase. The
executor moves the active markdown note under `.agent-kernel/memory/.tombstones/`
and writes a JSON tombstone with `scope`, `key`, `deletedAt`, original path, and
archive path. Normal `read`/`list` only sees active notes, while
`memory-index.json` includes both `status: "active"` and `status: "tombstoned"`
entries so deletion remains auditable and reversible without adding memory state
to the kernel protocol.

Implemented message assembly observability also accounts for memory. When a
session already contains a structured `memory` tool call and its matching tool
result, the live `message-assembly` artifact includes a `memory` contribution
bucket and a `memory.contribution` pipeline stage. This is provenance and budget
metadata only; it does not create a hidden memory channel or mutate the kernel
state machine.

The dashboard artifact explorer includes a `Memory` tab that loads
`memory-index.json` artifacts on demand. It summarizes active/tombstoned,
workspace/global, and warning counts, then shows each memory key with scope,
status, description, confidence, source session, delete timestamp, and archive
path. This keeps memory provenance inspectable as artifact data instead of
adding another live protocol surface.

## Testing Plan

- Unit tests for scope filtering.
- Implemented unit tests for workspace memory index export.
- Implemented unit tests for memory contribution metadata in message assembly
  artifacts.
- Implemented unit tests for workspace/global delete tombstones and tombstone
  indexing.
- Tests that benchmark mode disables cross-task memory by default.
- Retrieval ranking tests with stale conflicting facts.
- Implemented browser tests for memory provenance views.

## Non-Goals

- Do not treat memory as hidden system prompt text.
- Do not let memory bypass context budget accounting.
- Do not add vector database dependencies to the kernel.

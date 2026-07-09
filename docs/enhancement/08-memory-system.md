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

## Testing Plan

- Unit tests for scope filtering.
- Tests that benchmark mode disables cross-task memory by default.
- Retrieval ranking tests with stale conflicting facts.
- Browser tests for memory provenance and delete/tombstone behavior.

## Non-Goals

- Do not treat memory as hidden system prompt text.
- Do not let memory bypass context budget accounting.
- Do not add vector database dependencies to the kernel.


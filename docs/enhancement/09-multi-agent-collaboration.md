# Multi-Agent Collaboration

Status: proposed enhancement  
Priority: 9

## Why This Matters

Multi-agent workflows are useful when they reduce context pressure or isolate
specialized work: code search, test diagnosis, review, documentation, and
benchmark triage. They become harmful when they add opaque state and recursive
protocol complexity.

## Existing Baseline

The host-side `agent` builtin already spawns child JSONL sessions in the same
workspace. This is the correct primitive: child agents are ordinary sessions,
not special reducer states.

## Design Principle

Keep multi-agent collaboration as session orchestration. Do not add multi-agent
entities to the kernel state machine.

## Collaboration Patterns

Research subagent:
Reads files and returns a concise report with references.

Test subagent:
Runs focused tests and reports failure causes.

Review subagent:
Inspects final diff and reports risks before answer.

Benchmark triage subagent:
For failed SWE-bench trials, summarizes why patch failed.

## Parent-Child Contract

The parent call should specify:

- objective
- workspace/cwd
- allowed tools
- max turns/time
- context budget
- expected output format

The child returns:

- final answer
- status
- session id
- event count
- key artifacts
- trace reference

## Dashboard

Show subagents as expandable linked sessions:

- Parent timeline row for the agent tool call.
- Child session summary and status.
- Link to child trace and transcript.
- Clear empty state if the child produced no visible output.

Implemented subagent graph export:

```bash
agent-kernel-host enhancement subagents graph \
  --root-dir runs/subagents \
  --sessions-dir ~/.agent-kernel/sessions
```

The command scans JSONL headers and writes `subagent-graph.json` with session
nodes and parent-child edges using `parentSessionId` and `parentCursor`. It does
not introduce a multi-agent protocol or mutate sessions. The graph is a derived
view for dashboard navigation, eval comparison, and subagent failure analysis.

## Testing Plan

- Unit tests for max depth and timeout enforcement.
- Integration test parent spawning child and receiving final result.
- Implemented unit tests for exported parent-child session graph.
- Browser test for expanded subagent card content.
- Eval test comparing single-agent vs subagent-enabled runs.

## Non-Goals

- Do not create a new multi-agent protocol in the reducer.
- Do not let child agents mutate parent messages except through tool result.
- Do not enable unbounded recursive delegation.

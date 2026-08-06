# Multi-Agent Collaboration

Status: baseline implemented; collaboration policy incomplete
Priority: 9
Last reviewed against implementation: 2026-07-09

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

## Current Implementation Alignment

### Implemented In Code

The current implementation has the right primitive:

- The host-side `agent` builtin spawns child sessions and returns an ordinary
  tool result to the parent.
- Child sessions are normal JSONL session logs with `parentSessionId` and
  `parentCursor` metadata, not special reducer state.
- Dashboard transcript renders subagent cards and can expand child session
  content.
- `agent-kernel-host enhancement subagents graph` scans session headers and
  writes `subagent-graph.json` with nodes and parent-child edges.
- Dashboard Ops view renders subagent graph artifacts.
- Browser e2e covers subagent card rendering/scroll behavior and enhancement
  action coverage verifies graph export from real session logs.
- `SubAgentRoleTemplate` / `resolveSubAgentPolicy` in
  `@agent-kernel/shared/enhancement` provide fixed role templates (`research`,
  `test`, `review`) with default allowed tools, enforced max turns, ordinary
  idle, active-tool idle, absolute deadline, grace period, and expected output.
  Aggressive defaults are documented in
  [`subagent-timeout-policy.md`](../architecture/subagent-timeout-policy.md).
  `resolveSubAgentPolicy` intersects caller input with the role template and
  parent-available tools. Undersized turn/deadline requests are raised, oversized
  requests are capped, and low-cardinality reason codes include
  `policy_max_turns_raised`, `policy_max_turns_capped`,
  `policy_timeout_raised`, and `policy_timeout_capped`.
- Host-level depth and fan-out caps are enforced in `runAgentTool`:
  `AgentConfig.maxAgentDepth` (default 3) walks the `parentSessionId` chain at
  spawn time; `AgentConfig.maxAgentFanOut` (default 4) counts live sibling
  sub-agents under the same parent (`activeSubAgentsForParent`). When either
  cap trips, the host writes a `subagent-policies/<parentSessionId>/<callId>.json`
  artifact with the resolved `maxDepth`/`resolvedDepth`/`maxFanOut`/
  `concurrentSiblingCount` fields and the corresponding reason code, then
  returns a failure envelope (`agent depth exceeded` / `agent fan-out exceeded`)
  without creating a child session.
- The host `agent` tool schema accepts optional `role`, `objective`,
  `max_turns`, `timeout_ms`, and `expected_output`. Callers normally omit
  `timeout_ms`; for compatibility it means the absolute deadline. `runAgentTool`
  enforces role/no-role defaults, tracks durable cursor/status progress, uses a
  longer idle threshold while tools execute (including an explicit tool deadline
  plus a two-minute margin), applies grace before durable cancellation, and
  preserves emitted assistant text as `timed_out_with_partial_result`. The
  resolved policy is persisted under
  `subagent-policies/<parentSessionId>/<callId>.json`.
- Dashboard `SubAgentCard` loads `subagent-policies/<parentSessionId>/<callId>.json`
  on expand and renders an inline policy panel with role, objective, allowed
  tools, max turns, timeout, depth (`resolvedDepth/maxDepth`), fan-out
  (`concurrentSiblingCount/maxFanOut`), expected output, and reason codes so
  parent timelines show the resolved policy without raw JSON inspection.
- `summarizeSubAgentUsage` and the `subagentUsage` field on `EvalRunSummary`
  aggregate subagent count, trials-with-subagents, max depth, per-trial mean,
  and resolved/unresolved splits from a `SubAgentGraph`-shaped input.
  `summarizeEvalRun` accepts an optional graph, and `exportSessionForSweBench`
  scans the sessions directory next to the parent JSONL log to attach the
  graph to the written `summary.json` whenever child sessions link back to
  the parent via `parentSessionId` metadata.
- Dashboard `ArtifactExplorerDialog` renders a `SubAgentUsagePanel`
  (`data-testid="eval-subagent-usage"`) in the Eval run-detail column when a
  loaded summary carries `subagentUsage`, showing total spawned, trials with
  sub-agents, max depth, per-trial mean, and resolved-with-sub-agents with a
  pass-rate hint. The panel hides when the field is absent, so runs without
  sub-agents keep the existing summary layout.
- `compareEvalRuns` computes a `subagentUsageDelta` from
  `baseline.subagentUsage` and `candidate.subagentUsage` using
  `diffSubAgentUsage` from `@agent-kernel/shared/enhancement`, and the
  dashboard renders it as a `SubAgentUsageDeltaPanel`
  (`data-testid="eval-subagent-usage-delta"`) inside the Comparisons list
  whenever either side carries usage.

- `packages/host/src/server.test.ts` covers the failed-child + parent-recovery
  path end-to-end over Socket.IO: parent LLM emits an `agent` tool_call, the
  child's LLM throws, the host emits `server:sub_agent_finished` with
  `status: 'failed'`, and the parent log receives a `<sub_agent status="failed">`
  envelope whose `<error>` body carries the child's underlying error so the
  parent's next turn can react rather than stall. `runAgentTool` now prefers the
  child's final `state.error` over the generic `agent ended with status <x>`
  wrapper so the failure surface stays informative.

### Important Gaps

- Depth, fan-out, timeout, role policy, and failed-child recovery are all
  covered. The remaining work is broader eval-level comparisons (e.g. quality
  and cost of subagent-enabled vs single-agent runs) rather than a specific
  correctness gap.

### Production Quality Criteria

Multi-agent support is production-level when:

- Child sessions are bounded by explicit policy: role, objective, allowed tools,
  budget, timeout, and expected output contract.
- Parent timelines show child status, key artifacts, cost, duration, and failure
  labels without requiring raw JSON inspection.
- Subagent graphs link to session replay, traces, and eval trials.
- Recursive depth and fanout are capped and visible.
- Eval reports can compare quality/cost/reliability impact of subagent usage.

### Next Implementation Steps

1. Add eval-level comparison between subagent-enabled and single-agent runs for
   the same benchmark (quality, cost, and reliability).

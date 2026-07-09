# Latency, Token, and Resource Profiling

Status: session profiling implemented; monetary cost tracking removed from product surface
Priority: 10
Last reviewed against implementation: 2026-07-10

## Why This Matters

The target roles call out first-token latency, context pressure, high
concurrency, and resource efficiency. Agent quality without latency, token, and
runtime visibility is not production-ready.

## Design Principle

Latency, token usage, retry behavior, and runtime resource pressure are
observability concerns. Record them in traces and eval artifacts, not in kernel
control flow. Do not expose token usage as monetary spend; pricing is external
operator context and is intentionally out of product scope.

## Metrics

LLM metrics:

- request latency
- time to first token/chunk
- output streaming duration
- input/output/cache/reasoning tokens
- retry count
- provider error type

Tool metrics:

- queue time
- execution time
- output size
- exit code
- timeout/killed status

Session metrics:

- wall time
- number of LLM calls
- number of tool calls
- compaction count
- total tokens
- completion status per task

## Monetary Cost Policy

The product does not compute, display, or gate on token cost in currency. Token
counts remain useful engineering telemetry, but converting tokens into spend is
ambiguous across contracts, discounts, deployments, cache policies, and provider
reporting. Any external pricing analysis belongs outside `agent-kernel`.

Implemented local profile command:

```bash
agent-kernel-host enhancement profile session \
  --root-dir runs/profile/session \
  --session-log ~/.agent-kernel/sessions/<session>.jsonl
```

The output `profile.json` records LLM calls, tool calls, failed tool results,
token totals, missing usage, missing provider traces, model ids, and wall time.
Streaming adapters also attach optional `llmTrace.response.metrics` with
`durationMs` and `timeToFirstChunkMs`. Session profiles aggregate those fields
into latency call count, average/p95 LLM duration, and average/p95 TTFT. This is
trace/profile metadata only and does not influence reducer control flow.

Implemented eval-level aggregation and budget commands:

```bash
agent-kernel-host enhancement profile aggregate \
  --root-dir runs/profile/aggregate \
  --summary runs/eval/summary.json \
  --output aggregate.json
```

`profile aggregate` walks `--root-dir` recursively, loads every `profile.json`
under it, and writes `profile-aggregate.json` with cross-trial token,
latency, and TTFT distributions (min/max/mean/p50/p95/total/count).

```bash
agent-kernel-host enhancement profile budget \
  --root-dir runs/profile/budget \
  --profile runs/profile/session/profile.json \
  --threshold p95LlmDurationMs=5000 \
  --threshold p95TtftMs=1000
```

`profile budget` reads a single `profile.json` and writes
`profile-budget.json` with `verdict.pass`, per-threshold reason codes
(`p95_llm_duration_exceeded`, `p95_ttft_exceeded`, `llm_calls_exceeded`,
`tool_calls_exceeded`, `wall_time_exceeded`, and others), observed values, and
applied thresholds.
When the verdict is a fail, the process exits with code 2 so CI runners can
block promotion without any extra scripting. The gate reads the profile only
and does not mutate any run directory.

## Dashboard

Add compact profiling views:

- Per-call latency bars in trace.
- Token and latency summary per session. Implemented in the dashboard artifact
  explorer as a `Profiles` tab that discovers `profile.json` artifacts through
  the manifest endpoint, loads their content on demand, and shows LLM/tool
  calls, token totals, missing LLM traces, model ids, average/p95 duration, and
  average/p95 TTFT.
- Eval run token and latency distribution.
- Slowest calls and largest context calls.
- TTFT for streaming LLM calls.

## Testing Plan

- Unit tests for token and latency aggregation.
- Implemented for session-log profile export.
- Browser-level component test for profile artifact rendering with missing
  provider trace counts.
- Implemented adapter tests that streaming OpenAI and Anthropic traces include
  duration and TTFT metrics.
- Browser test for token summary with missing usage fields.

## Non-Goals

- Do not block execution on telemetry aggregation.
- Do not encode provider pricing in kernel, shared protocol types, dashboard
  labels, or benchmark summaries.

## Current Implementation Alignment

### Implemented In Code

Current profiling is session/artifact based:

- `agent-kernel-host enhancement profile session` reads a session log and writes
  `profile.json`.
- Profiles record LLM calls, tool calls, failed tool results, token totals,
  missing usage count, missing provider trace count, model ids, wall time,
  duration, and TTFT metrics.
- Streaming OpenAI/Anthropic adapter traces can include duration and TTFT
  metrics, and profile export aggregates average/p95 duration and TTFT when
  present.
- Dashboard Profiles tab discovers `profile.json` artifacts through the
  manifest endpoint and renders call counts, token totals, missing traces,
  models, duration, and TTFT.
- Browser enhancement e2e verifies profile generation and dashboard rendering
  from real session logs.

### Important Gaps

- Profiling is offline/artifact-oriented; there is no live session latency/token
  panel driven by streaming runtime metrics.
- Aggregation and budget checks are implemented as offline CLI/HTTP artifacts,
  but there is no dashboard distribution chart on top of them yet.
- Some historical artifacts may still contain `costStatus` or
  `estimatedCostUsd`; dashboard and docs should not surface those fields.
- Tool queue time and detailed executor timing are not yet captured uniformly.

### Production Quality Criteria

This platform is production-level when:

- Every LLM call has duration, TTFT when streaming, usage, retry count, and typed
  provider error status or a clear missing-data reason.
- Every tool call has queue time, execution time, output bytes, timeout/killed
  status, and executor id.
- Eval summaries include latency and token distributions.
- Budgets can be configured per session/eval run and violations are surfaced as
  artifacts and dashboard warnings.

### Next Implementation Steps

1. Add live profile summary to the session status panel using existing usage and
   trace metadata.
2. Render `profile-aggregate.json` and `profile-budget.json` inline in the
   dashboard Profiles tab so distributions and budget breaches surface without
   opening raw JSON.
3. Capture executor queue/execution timing in tool result metadata or artifacts.
4. Remove stale monetary-cost fields from profile artifact schemas in a focused
   data-model cleanup.

# Latency and Cost Profiling

Status: proposed enhancement  
Priority: 10

## Why This Matters

The target roles call out first-token latency, system cost, high concurrency,
and resource efficiency. Agent quality without latency and cost visibility is
not production-ready.

## Design Principle

Latency and cost are observability concerns. Record them in traces and eval
artifacts, not in kernel control flow.

## Metrics

LLM metrics:

- request latency
- time to first token/chunk
- output streaming duration
- input/output/cache/reasoning tokens
- retry count
- provider error type
- estimated cost

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
- cost per successful task

## Cost Model

Keep a versioned pricing table outside the kernel. The host computes estimated
cost from provider-reported usage. If provider usage is unavailable, label cost
as estimated or unknown rather than pretending precision.

Implemented local profile command:

```bash
agent-kernel-host enhancement profile session \
  --root-dir runs/profile/session \
  --session-log ~/.agent-kernel/sessions/<session>.jsonl \
  --pricing pricing.json
```

`pricing.json` is optional and has this shape:

```json
{
  "version": "local-2026-07",
  "currency": "USD",
  "models": {
    "gpt-test": {
      "inputPerMillion": 1,
      "outputPerMillion": 2,
      "cacheReadPerMillion": 0.1,
      "cacheCreationPerMillion": 1
    }
  }
}
```

The output `profile.json` records LLM calls, tool calls, failed tool results,
token totals, missing usage, missing provider traces, model ids, wall time, and
estimated cost when every model has a price entry. If usage or pricing is
missing, `costStatus` is `unknown`; the runner does not invent cost precision.
Streaming adapters also attach optional `llmTrace.response.metrics` with
`durationMs` and `timeToFirstChunkMs`. Session profiles aggregate those fields
into latency call count, average/p95 LLM duration, and average/p95 TTFT. This is
trace/profile metadata only and does not influence reducer control flow.

## Dashboard

Add compact profiling views:

- Per-call latency bars in trace.
- Cost/token summary per session. Implemented in the dashboard artifact
  explorer as a `Profiles` tab that discovers `profile.json` artifacts through
  the manifest endpoint, loads their content on demand, and shows LLM/tool
  calls, token totals, known estimated cost, unknown-cost count, missing LLM
  traces, model ids, average/p95 duration, and average/p95 TTFT.
- Eval run cost distribution.
- Slowest calls and largest context calls.
- TTFT for streaming LLM calls.

## Testing Plan

- Unit tests for pricing table lookup and unknown-cost handling.
- Implemented for session-log profile export.
- Browser-level component test for profile artifact rendering with missing
  provider trace counts and estimated cost.
- Implemented adapter tests that streaming OpenAI and Anthropic traces include
  duration and TTFT metrics.
- Browser test for cost summary with missing usage fields.

## Non-Goals

- Do not block execution on cost calculation.
- Do not encode provider pricing in kernel or shared protocol types unless it is
  purely optional metadata.

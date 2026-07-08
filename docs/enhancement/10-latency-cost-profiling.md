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

## Dashboard

Add compact profiling views:

- Per-call latency bars in trace.
- Cost/token summary per session.
- Eval run cost distribution.
- Slowest calls and largest context calls.
- TTFT for streaming LLM calls.

## Testing Plan

- Unit tests for pricing table lookup and unknown-cost handling.
- Integration test that LLM spans include TTFT when streaming.
- Browser test for cost summary with missing usage fields.

## Non-Goals

- Do not block execution on cost calculation.
- Do not encode provider pricing in kernel or shared protocol types unless it is
  purely optional metadata.


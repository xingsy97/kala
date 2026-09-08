# Sub-agent timeout and long-running work policy

Status: implemented baseline
Date: 2026-08-06

## Problem

Historical local receipts show that `agent` is an outlier: 20 of 73 calls failed (27.4%), and 13 of those failures were `sub-agent exceeded timeout` (65% of Agent failures). In a recent three-way review, all children received a 120 second deadline; one completed at 119.241 seconds while two were cancelled at 120.020 and 120.022 seconds. A fixed short wall-clock timer therefore kills productive work at the boundary.

Sub-agents routinely run builds, browser acceptance, container operations, repository scans, and long tests. A tool call with no new child cursor for 5–8 minutes is normal and must not be treated as a hang.

## Policy

Role defaults deliberately prefer waiting over false cancellation:

| Role | Max turns | Ordinary idle | Active-tool idle | Absolute deadline | Grace |
|---|---:|---:|---:|---:|---:|
| Review | 120 | 30 min | 90 min | 3 h | 3 min |
| Research | 180 | 45 min | 120 min | 4 h | 5 min |
| Test | 200 | 45 min | 120 min | 5 h | 5 min |
| Implementation | 240 | 45 min | 120 min | 6 h | 5 min |
| No role | 180 | 45 min | 120 min | 4 h | 5 min |

Explicit caller values are bounded rather than trusted blindly:

| Role | Minimum turns | Maximum turns | Minimum absolute | Maximum absolute |
|---|---:|---:|---:|---:|
| Review | 20 | 240 | 20 min | 6 h |
| Research | 25 | 360 | 30 min | 8 h |
| Test | 30 | 400 | 45 min | 10 h |
| Implementation | 40 | 480 | 60 min | 12 h |
| No role | 20 | 360 | 30 min | 8 h |

A caller-supplied two-minute review timeout is raised to twenty minutes and records `policy_timeout_raised`. Oversized values are capped and record the existing cap reason. Normal callers may omit `timeout_ms` and use the much larger role default, or dynamically pass a larger `max_turns` / `timeout_ms` in the `agent` tool call for complex tasks.

For compatibility, the public `timeout_ms` input means the absolute deadline. Idle and grace values come from the selected role template.

## Activity model

The Host samples the durable child state:

- a cursor change is progress and refreshes ordinary activity;
- a status change is progress;
- `executing_tools` selects the longer active-tool idle threshold;
- a long tool call may remain on one cursor until its result arrives, so it is governed by active-tool idle, not ordinary idle;
- no activity extension may bypass the absolute deadline.

When an idle or absolute threshold is reached, the child enters a grace window. If it completes during grace, its normal result wins. At grace expiry, the Host cancels the child through the existing durable cancel path.

## Outcomes

- `completed`: child reached `done` normally.
- `timed_out_with_partial_result`: grace expired, cancellation completed, and the child had emitted assistant text. The Agent tool returns the partial report as usable output with an explicit timeout warning.
- `failed`: grace expired without usable assistant text, or dispatch failed.
- `cancelled`: explicit user or parent cancellation rather than policy timeout.

The parent must never lose a useful partial report solely because a deadline expired.

## Restart and safety

The existing parent-call identity remains the idempotency fence. Host restart reuses a completed child and stops an incomplete orphan instead of creating a duplicate. Depth remains root-to-child only: sub-agents do not receive the `agent` tool, and even old child configs that expose it are hard-capped at depth 1. Fan-out, allowed-tool intersection, and headless `allow_all` rules remain unchanged.

## Known limitation and follow-up

The current Host loop cannot safely inject a second “stop and summarize” message while `dispatchOne` is already active for the same child. Grace therefore allows natural completion but does not inject a summary turn. A future child-control protocol may add a non-reentrant summarize request. It must be implemented as a durable control event, not a concurrent `user_message` dispatch.

## Acceptance

Tests must cover:

1. aggressive defaults for every role and no-role calls;
2. raising undersized and capping oversized caller values;
3. ordinary activity renewal from cursor/status changes;
4. active-tool idle using the longer threshold;
5. absolute deadline overriding repeated progress;
6. completion during grace;
7. partial-result preservation after forced timeout;
8. no regression to depth, fan-out, tool intersection, restart, or explicit cancellation.

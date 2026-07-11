# Long Task Reliability

Status: partially implemented; audit and UI controls exist, supervisor incomplete
Priority: 7
Last reviewed against implementation: 2026-07-09

## Why This Matters

Real agent tasks last minutes or hours, cross process restarts, run background
shells, hit provider timeouts, and may be resumed from old sessions. Reliability
is a direct match for online large-scale agent infrastructure roles.

## Existing Strengths

- Append-only JSONL session log.
- Pure reducer replay.
- Host/executor split.
- Background shell registry.
- Tool cancellation path.
- Session recovery by folding logs.

## Production Reliability Goals

- A host crash should not lose completed events.
- A pending LLM or tool call should recover to a known terminal state.
- Background process state should be visible and killable.
- Long tasks should expose progress and heartbeats.
- Duplicate resumes should not execute the same irreversible tool twice.

## Host Recovery

On startup:

1. Load every session header and event log.
2. Fold state.
3. Detect in-flight states: `thinking`, `executing_tools`, `awaiting_approval`.
4. For stale LLM calls, append `llm_error` with a recovery reason or mark the
   turn resumable.
5. For stale dispatched tool calls, ask executor for status when possible;
   otherwise append synthetic failed `tool_result` with recovery metadata.
6. Keep the raw log append-only.

The host store already performs append-only recovery when a session is loaded:
pending tool calls receive synthetic failed `tool_result` events, pending
approvals are approved then failed so the reducer can settle them, and dangling
mid-stream LLM calls receive a minimal interrupted assistant response.

Implemented offline audit command:

```bash
agent-kernel-host enhancement reliability audit-session \
  --root-dir runs/reliability/session \
  --session-log ~/.agent-kernel/sessions/<session>.jsonl
```

This command folds the raw log without triggering store recovery and writes
`reliability-audit.json` with final status, pending calls, dangling kind
(`llm_call`, `tool_call`, or `approval`), recovery event count, parse warnings,
last event kind, recovery event details, and tool-call integrity checks. The
integrity section reports duplicate tool call ids, duplicate tool result ids,
tool results without a matching call, and tool calls without a result. It is
intended for CI checks, crash triage, and validating that recovered sessions no
longer show impossible active work.

Implemented chaos replay command:

```bash
agent-kernel-host enhancement reliability chaos-replay \
  --root-dir runs/reliability/chaos \
  --session-logs sessions/a.jsonl,sessions/b.jsonl
```

It writes `reliability-chaos.json` with per-session final status, dangling kind,
recovery-event count, aggregate recoverable/dangling counts, and dangling counts
by kind. This is a replay artifact over existing logs; it does not add crash or
checkpoint concepts to the reducer protocol.

Implemented reliability gate command:

```bash
agent-kernel-host enhancement reliability gate \
  --root-dir runs/reliability/gate \
  --chaos-report runs/reliability/chaos/reliability-chaos.json \
  --max-dangling 0 \
  --min-recoverable-ratio 0.9 \
  --max-recovery-events 3 \
  --kind-cap llm_call=0 \
  --kind-cap tool_call=1 \
  --require-status idle,done
```

`reliability gate` reads an existing `reliability-chaos.json`  -  or, if
`--session-logs` is supplied instead, replays the given logs inline  -  and
evaluates the result against a threshold policy: max dangling, min recoverable
ratio, max recovery-event count, per-kind dangling caps, and an allowed
terminal-status set. It writes `reliability-gate.json` with `verdict.pass`,
per-threshold reason codes (`dangling_count_exceeded`,
`recovery_event_count_exceeded`, `recoverable_ratio_below_minimum`,
`dangling_kind_exceeded:<kind>`, `session_status_not_allowed`), observed values,
and the applied policy. When the verdict is a fail, the process exits with
code 2 so CI runners can block promotion without extra scripting. The gate reads
inputs only and does not mutate the underlying logs or chaos report.

Implemented crash-classify command:

```bash
agent-kernel-host enhancement reliability classify \
  --root-dir runs/reliability/classify \
  --session-log ~/.agent-kernel/sessions/<session>.jsonl \
  --heartbeat runs/reliability/heartbeat.jsonl \
  --wedged-threshold-ms 60000
```

`reliability classify` combines a session audit with the last heartbeat record
from a `HeartbeatEmitter` file and writes `crash-kill-report.json` with a
coarse `suspectedFailure` label (`wedged`, `restart_before_result`,
`clean_shutdown`, `unknown`), the pending-call count, the last heartbeat, and a
recovery hint. This is the operator-facing binder for the low-level primitives
in `reliability-supervisor.ts` (heartbeat writer, idempotency ledger,
crash-kill classifier), meant for post-crash triage of a specific session.

## Executor Reliability

Background shell state should include:

- task id
- command
- cwd
- pid / process group id when available
- status: running, exited, killed, failed
- start/end timestamps
- exit code/signal
- output byte counts

Composer counts should count only active/running terminals, but the UI should
still expose zero and historical terminated terminals.

## Idempotency

Tool calls need stable `callId`. The executor should reject duplicate settlement
for a call id and should make dangerous operations approval-gated. For bash and
file edits, recovery should prefer surfacing uncertain state over replaying the
same side effect.

## Timeouts and Heartbeats

Use layered timeouts:

- Provider request timeout.
- Tool execution timeout.
- Background process soft and hard kill timeout.
- Session idle timeout.
- Benchmark trial timeout.

Long-running tools should emit heartbeats or output offsets so the dashboard can
distinguish progress from a stuck connection.

## Chaos Tests

Add tests that intentionally terminate components:

- Kill host during LLM call.
- Kill host during tool execution.
- Kill executor during background shell.
- Restart dashboard during active stream.
- Resume a session with pending approvals.
- Implemented unit tests for dangling LLM/tool audit and recovery-event
  detection.
- Implemented unit tests for recovery event details and tool-call integrity
  audit signals.

Each test should assert that replay succeeds and the UI does not show impossible
active counts.

## Non-Goals

- Do not make the reducer aware of OS processes.
- Do not auto-replay uncertain side-effecting tools after crash.
- Do not hide recovery events; they are part of the audit trail.

## Current Implementation Alignment

### Implemented In Code

The reliability foundation is real and stays above the reducer:

- Session store recovery folds append-only JSONL logs and settles stale pending
  work with recovery events rather than replaying uncertain side effects.
- `agent-kernel-host enhancement reliability audit-session` writes
  `reliability-audit.json` with final status, pending calls, dangling kind,
  recovery event details, parse warnings, last event kind, and tool-call
  integrity checks.
- `agent-kernel-host enhancement reliability chaos-replay` writes
  `reliability-chaos.json` over multiple logs with aggregate dangling/recovery
  counts.
- `agent-kernel-host enhancement reliability gate` reads a chaos report (or
  replays given session logs) and writes `reliability-gate.json` with pass/fail,
  per-threshold reason codes, and exits with code 2 on fail for CI gating.
- `agent-kernel-host enhancement reliability classify` reads a session log and
  heartbeat file, then writes `crash-kill-report.json` with a suspected-failure
  label and recovery hint using the `reliability-supervisor.ts` primitives
  (heartbeat writer, idempotency ledger, crash-kill classifier).
- Dashboard Ops view renders reliability audit and chaos artifacts.
- Background terminal UI exposes command, process details such as pid when
  available, status, and a kill action; composer active counts exclude killed
  terminals while still allowing historical terminal inspection.
- Browser enhancement e2e covers reliability audit/chaos actions through real
  dashboard-origin HTTP calls and artifact files.

### Important Gaps

- There is no full process supervisor with persistent process-group ownership
  across host/executor restarts.
- There is no distributed heartbeat protocol for long tools, background shells,
  benchmark workers, or provider calls.
- Crash testing is still mostly unit/replay based; there is no broad e2e matrix
  that kills host/executor/provider paths mid-operation.
- Recovery of uncertain executor-side operations is conservative, but UX around
  uncertain state and manual remediation needs more structure.
- Duplicate side-effect prevention is not yet enforced as a durable executor
  idempotency ledger.

### Production Quality Criteria

Long-task reliability is production-level when:

- Host/executor crashes during LLM calls, tool calls, approvals, background
  shells, and benchmark workers have deterministic recovery behavior and tests.
- Every active long-running unit has heartbeat, owner, pid/process group when
  applicable, last output offset, and terminal status.
- UI active counts never include terminated processes, but history remains
  visible.
- Dangerous side-effecting tool calls cannot be accidentally replayed after
  recovery.
- Recovery events are visible in trace/eval artifacts and low-cardinality
  failure labels.

### Next Implementation Steps

1. Add an executor-side idempotency ledger keyed by `sessionId` and `callId` for
   side-effecting tools.
2. Add a heartbeat artifact or host registry for long-running tools and
   benchmark workers.
3. Add crash e2e scripts that kill host/executor during representative active
   states and assert replay/UI recovery.
4. Add dashboard remediation actions for uncertain recovered state.

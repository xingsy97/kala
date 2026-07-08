# Long Task Reliability

Status: proposed enhancement  
Priority: 7

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
and last event kind. It is intended for CI checks, crash triage, and validating
that recovered sessions no longer show impossible active work.

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

Each test should assert that replay succeeds and the UI does not show impossible
active counts.

## Non-Goals

- Do not make the reducer aware of OS processes.
- Do not auto-replay uncertain side-effecting tools after crash.
- Do not hide recovery events; they are part of the audit trail.

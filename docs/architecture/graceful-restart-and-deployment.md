# Graceful Restart and Transactional Deployment

Status: source of truth

This document defines the normative Host restart and release-deployment contract. Implementations, tests, runbooks, and operator UI must follow it. A process replacement is not “graceful” merely because it exits with code 0 or because the service becomes healthy again.

## Product invariant

A planned Host restart must not turn accepted work into `Response interrupted before completion`, lose queued messages, repeat an external side effect, or require the operator to manually restart an autonomous Session.

A planned restart is complete only when:

1. every participating Session has reached a durable pre-effect checkpoint;
2. the old Host has stopped admitting new mutable work;
3. the replacement Host owns the same restart attempt;
4. every planned continuation has been consumed idempotently;
5. the target release, service, HTTP readiness, Executor reconnection, Session cursor monotonicity, and continuation outcome have been verified.

`[interrupted]` is crash-recovery evidence. It is not a successful planned-restart continuation.

## Terms

- **Restart attempt** — one durable, uniquely identified process-replacement workflow.
- **Participant set** — the frozen set of loaded Sessions captured when drain begins.
- **Pre-effect checkpoint** — a durable Session event has committed, but the next external LLM/Tool effect has not started.
- **Origin Session** — the Session whose Tool call initiated deployment of its own Host.
- **Finalize worker** — a process outside the Host service cgroup that owns activation, restart polling, verification, and rollback.
- **Planned continuation** — restart recovery from a known pre-effect checkpoint.
- **Crash recovery** — conservative recovery without a valid planned-restart handoff.

## Safety model

The Session JSONL event log remains the authoritative Agent state. Planned restart does not copy prompts or synthesize a parallel message store. A restart marker records only:

- schema version and attempt identity;
- old process identity and target release identity;
- frozen participant Session IDs;
- each participant's durable cursor, checkpoint kind, and resume action;
- replacement ownership/fencing fields;
- per-Session continuation receipt and outcome.

The marker and each Session cursor must agree before continuation. A mismatch blocks automatic recovery and is surfaced as an operational error.

## Allowed checkpoints

A checkpoint is safe only when the triggering event is durably appended and no external effect from that transition is in flight.

| Durable state | Checkpoint | Restart action |
|---|---|---|
| `idle`, `done`, `error` | `resting` | none |
| LLM response committed with Tool calls, before Tool dispatch | `before_tool_dispatch` | dispatch pending calls |
| Tool result(s) committed and reducer requested another LLM, before LLM start | `before_llm` | issue the next LLM call |
| User message committed and reducer requested LLM, before LLM start | `before_llm` | issue the next LLM call |
| Approval request committed | `waiting_for_approval` | continue waiting; never auto-approve or reject |
| Compaction replacement committed, before continuation | `before_llm` or `resting` | resume only when the pre-restart workflow required continuation |

The following are not checkpoints:

- an active provider request;
- an Executor Tool that has been dispatched but has no durable result;
- an uncommitted Session tail;
- an active compaction mutation;
- a parent Session whose required child Session has not checkpointed;
- a queue mutation or dequeue that has not committed.

Checkpoint mode lets the current external call finish, commits its result, and then suppresses the next external effect. It does not abort healthy long-running calls merely to restart faster.

## Drain admission barrier

When drain starts:

1. freeze the participant set and baseline cursor for each participant;
2. reject new user-message mutations with a retryable `restart_draining` response;
3. stop Queue drain from starting another turn;
4. stop automatic graph continuation, compaction continuation, recovery dispatch, and new Sub-agent creation;
5. allow cancellation and read-only status/history operations;
6. allow already-started LLM/Tool work to settle to a checkpoint;
7. require Session serialized tails, commit tails, queue mutations, and checkpoint marker writes to finish before process exit.

Sessions loaded or created after the participant freeze are rejected from mutable admission; the participant set must not be recomputed from live memory during later phases.

## Planned continuation

The replacement Host must validate and claim the restart marker before accepting mutable traffic. Readiness has two phases:

- `process_ready`: listener and basic diagnostics may exist;
- `runtime_ready`: restart marker validated, Sessions loaded without crash mutation, planned continuations consumed, Queue reconciliation complete.

Normal Dashboard, Executor, and mutation routes require `runtime_ready`.

Continuation uses the durable state already present:

- `before_llm` dispatches an internal resume transition that produces `call_llm`; it must not append `[interrupted]`;
- `before_tool_dispatch` executes only calls known not to have been dispatched before checkpoint;
- `waiting_for_approval` remains waiting;
- `resting` does nothing.

Every continuation is keyed by `(attemptId, sessionId, cursor, checkpointKind)`. Its claim and completion receipt are durable and idempotent. A later ordinary Host start must not consume an already completed restart marker again.

## Crash recovery

Without a valid, owned planned-restart marker:

- a dangling LLM may be closed with `[interrupted]`;
- a Tool with unknown external outcome must not be blindly repeated;
- a pending Tool can be retried only when an Executor/idempotency ledger proves it was not dispatched or can return the original result;
- an unknown non-idempotent Tool outcome requires operator attention.

Planned and crash recovery must use distinct entry points. `SessionStore.load(recoverDangling: true)` must never race a planned load for the same Session.

## Tool, Queue, compaction, and Sub-agent rules

### Tools

Planned checkpointing normally stops before dispatch or after a durable result, eliminating ambiguous in-flight Tool recovery. If a forced restart interrupts a dispatched Tool, recovery requires a stable `callId`, Executor identity, dispatch acknowledgement, and idempotency/result ledger. Unknown non-idempotent outcomes are blocked, not replayed.

### Queue

Queue snapshots and dequeue commits are durable. Drain prevents a queued item from starting after participant freeze. Replacement startup reconciles Session events by operation ID before draining the queue, preventing duplicate user turns.

### Compaction

Restart cannot cut through message replacement. It waits for the replacement commit and records whether continuation was required. The replacement Host resumes from the committed messages exactly once.

### Sub-agents

A parent and every required active child form one restart dependency group. The parent cannot report a safe checkpoint while a required child has active external work. Recovery resumes children before allowing the parent's waiting Tool result to continue. Cancellation and timeout envelopes remain durable and idempotent.

## Self-deployment protocol

A deployment initiated by a Session running on the target Host must not synchronously wait for that Host to restart.

1. The deployment command builds, stages, and verifies an immutable release generation.
2. It starts or notifies a finalize worker outside `agent-runlab-host.service` and its `KillMode=control-group` cgroup.
3. The worker durably accepts `deployId`, target release hash, predecessor, service identity, and Host restart endpoint.
4. The Tool command returns `accepted` with `deployId`.
5. The origin Session persists that Tool result and reaches a checkpoint.
6. The worker requests checkpoint restart and polls the exact `attemptId`.
7. Only after the Host reports checkpoint readiness does the worker atomically activate the target generation.
8. systemd replaces the Host.
9. The worker verifies replacement ownership, target hash, PID change, runtime readiness, Executor reconnection, and Session continuation.
10. Failure atomically reactivates the predecessor and uses the same restart protocol for rollback.

A fixed delay is not a deployment barrier. Synchronous self-deploy is rejected. `--async` is a compatibility spelling for durable worker handoff, not fire-and-forget success.

## Release transaction

SSH and LXD are transports only:

- `push(local, stagedPath)`;
- `exec(command)`.

Both use one target-side transaction:

1. acquire a non-blocking deployment lock;
2. validate target/container identity and systemd contract;
3. create `releases/<deployId>/` on the target filesystem;
4. transfer the exact manifest file set;
5. verify every digest and reject missing or extra managed files;
6. make the generation immutable;
7. record predecessor and target generation;
8. hand off to the finalize worker;
9. atomically switch a `current` symlink only at checkpoint readiness;
10. verify and retain at least one rollback generation.

Deployments must not overwrite live release files one by one. LXD must not call `systemctl restart` directly from its upload/install path.

## Supervisor contract

A supported standalone service must be preflighted for:

- one MainPID and one writable data owner;
- `Restart=always` or equivalent replacement after exit code 0;
- `KillMode=control-group`;
- release generations separated from mutable Session data;
- `ExecStart` through the atomic `current` generation;
- sufficient stop timeout for close after checkpoints, without using timeout as the drain deadline;
- a finalize worker outside the Host cgroup;
- least-privilege activation/restart permissions.

An invalid supervisor contract blocks deployment before activation.

## Restart workflow

Normative phases:

```text
requested
→ draining
→ checkpoint_reached
→ handed_off
→ activating
→ restarting
→ recovering
→ verifying
→ completed
```

Terminal alternatives are `blocked`, `aborted`, `failed`, and `rolled_back`. Timeout in checkpoint mode enters `blocked` or `aborted`; it does not silently escalate to force.

A replacement process may mark `restarting` as owned only when the marker's deployment/release identity, predecessor PID, service identity, and fencing token match. Valid JSON is not sufficient: marker input requires runtime schema validation.

## Observability

Status must expose:

- attempt/deployment ID and target release hash;
- phase and elapsed time;
- frozen participants;
- current cursor and checkpoint kind per Session;
- blocking LLM, Tool, compaction, child Session, queue mutation, or commit tail;
- continuation claim/result;
- old/new PID and runtime-ready timestamp;
- rollback generation and outcome.

The Dashboard may say “graceful restart completed” only after verification, not merely after process replacement.

## Required tests

### Unit and model tests

- checkpoint stops before Tool dispatch and before every fresh `call_llm`;
- safe requires no external work, no Session/commit tail, and durable checkpoint publication;
- participant set and baseline status remain frozen;
- drain rejects every mutable internal and external admission path;
- planned `before_llm` resumes without `[interrupted]`;
- crash recovery still produces conservative interrupted/unknown outcomes;
- marker schema, ownership, fencing, claim, and completion receipt are idempotent;
- Approval, Queue, compaction, and parent/child recovery obey this document.

### Process-level tests

Run old and replacement Host processes against temporary data for:

- active LLM;
- active Tool;
- Tool result before next LLM;
- waiting Approval;
- queued messages;
- compaction;
- Sub-agent parent/child;
- origin Session performing self-deploy;
- crash at every marker/receipt persistence boundary.

Assert cursor monotonicity, no unexpected `[interrupted]`, no duplicate user operation, and no duplicate external Tool effect.

### Deployment acceptance

Disposable targets precede LXD. Final LXD acceptance records old/new PID, exact release hash, HTTP readiness, restart/deploy IDs, Executor reconnection, participant cursors, Queue identity, and automatic continuation. LXD deployment is always the final graph node.

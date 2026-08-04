# Evaluation Platform Operations Runbook

Status: second-round operational contract; release verification remains `IMPLEMENTED_UNVERIFIED` until final clean-checkout acceptance.

This runbook closes the documentation requirements identified by [`SECOND_REVIEW.md`](SECOND_REVIEW.md). It describes required operator behavior and acceptance expectations; it is not itself execution evidence.

## Identity and access model

| Client | Identity | Allowed behavior |
|---|---|---|
| CLI | Explicit Operator, Reviewer, Viewer, or service credential supplied through the supported credential mechanism | Reads and mutations authorized by Control Plane RBAC; no implicit host credential discovery |
| SDK | Caller-supplied bearer/session credential | Typed queries, commands, event watch, and administration calls under the caller's identity |
| Administration UI | Same-origin user session | Read and mutation under the authenticated user identity, with confirmation and idempotency controls |
| Dashboard BFF | Per-user same-origin session mapped to a **Viewer-only** downstream identity | Read-only query and artifact proxying; it must reject mutation, administration, Worker, Analyzer, lease, and credential operations |
| Worker/Analyzer | Dedicated service identity bound to its session and lease generation | Only execution-plane endpoints for assigned work |

The BFF must never replace a user identity with a shared token that can mutate state or impersonate an operator. If a user initiates a mutation, the request must use an authenticated per-user Control Plane path rather than Viewer BFF authority. Audit records retain the authenticated actor and effective role.

## Online operation

Use online mode for normal reads, submissions, watches, cancellation, and maintenance operations explicitly documented as concurrency-safe.

### CLI

1. Select the Control Plane endpoint and explicit credential source; do not rely on a user-level Agent credential helper.
2. Confirm identity and capabilities with the status/query command before mutation.
3. Submit typed resource commands with an idempotency key and bounded timeout.
4. For event watch, persist the durable cursor, reconnect within the configured bound, validate the SSE media type, and treat cursor loss or malformed events as an error.
5. Interpret stable exits as success, policy block, or indeterminate/infrastructure failure; never convert indeterminate into pass.
6. Re-query authoritative state after a committed acknowledgement.

### SDK

1. Construct the client with an explicit endpoint, caller credential, deadline, and abort signal.
2. Use typed resource methods and validate every response schema.
3. Reuse the same idempotency key only for the same semantic command payload.
4. Resume event streams from the last durable cursor; an already-aborted signal must fail immediately.
5. Surface structured safe errors to callers and retain server causes only in protected server logs.

### Administration UI

1. Verify the displayed principal and role before an operation.
2. Inspect service identity, active key, Worker/Analyzer session, policy, and maintenance status.
3. Preview impact and enter the exact confirmation for reload, retention, deletion, restore, or publication actions.
4. Keep one submission pending; do not issue a duplicate after reload. Persist only the allowlisted command envelope.
5. After acknowledgement, reload authoritative status and confirm the durable audit entry names the actor and result.

## Maintenance modes

### Online maintenance

Online mode is limited to operations with a documented consistent boundary, such as dry-run impact calculation, policy inspection, hash verification, and non-destructive health checks. Record actor, mode, start/end time, snapshot boundary, result, and failure. If a consistent journal-plus-artifact boundary cannot be acquired, stop and schedule offline maintenance.

### Offline maintenance

Use offline mode for restore, destructive repair, incompatible migration, or any backup/retention operation that cannot exclude concurrent mutation safely.

1. Announce the maintenance window and block new mutating commands.
2. Drain or cancel active trials and analysis jobs; record final lease generations and cleanup receipts.
3. Stop Worker/Analyzer leasing and wait for zero active artifact writers.
4. Acquire the global maintenance lock and record the journal sequence plus artifact snapshot boundary.
5. Run backup, verify, restore, retention, or repair against that boundary.
6. Verify hashes, references, schema compatibility, audit continuity, and zero unexpected residue in a fresh target where applicable.
7. On failure, keep mutation blocked, persist the authenticated actor and failure, and follow rollback/recovery procedure.
8. On success, release the lock, restore service identities in least-privilege order, re-enable mutations, and run read plus authorized-mutation smoke checks.

Maintenance status updates must be serialized through the Control Plane journal; a process-local or last-writer-wins status is not authoritative.

## Acceptance and evidence

A runbook exercise is current release evidence only when produced from the clean release HEAD and when it records command/API calls, actor and role, mode, source revision, images, start/end times, snapshot boundary, hashes, failures, cleanup receipt, and generator metadata. Fixture tests validate command semantics; they do not replace an online/offline container exercise.

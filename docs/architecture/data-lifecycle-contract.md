# Data Lifecycle Contract

**Status:** accepted implementation contract

## Ownership

- Hosted data belongs to one `TenantRuntimeUnit`; Standalone data belongs to the local operator.
- Browser identity/session data stays in RuntimeIngressGateway storage.
- Agent Sessions, queues, artifacts, push state, Workspace aliases, and Executor identities stay in the Unit root.
- Workspace files remain on the Executor machine unless explicitly uploaded as an Artifact.

## Delete semantics

- **Session delete:** reject while active unless explicitly cancelled; remove the session log, derived artifacts, queue, registered images, and local UI cache. Deletion is idempotent and auditable.
- **Workspace forget:** allowed only when offline. Revoke Executor identity/invites and remove aliases; Sessions remain until separately deleted. It never deletes files on an Executor machine.
- **Account/Unit delete:** revoke Browser Sessions and Push subscriptions first, suspend routing, drain active turns, export if requested, then delete the complete Unit root and assignment. A failed step leaves the Unit suspended for retry, never partially active.
- **Artifact delete:** remove manifest entry and bytes together; missing bytes are repaired as an idempotent cleanup.

## Retention defaults

- active Sessions and Artifacts: retained until user deletion;
- revoked Browser Sessions and audit records: 7 days minimum diagnostic window;
- expired Executor invites: 30 days for audit, then prune;
- temporary upload, trace, overflow, and acceptance files: 7 days;
- deleted Unit tombstone: 30 days with no user content, only opaque ID, timestamps, and outcome.

Deployments may shorten content retention but must expose policy before data creation.

## Export

A Unit export contains a versioned manifest, Session JSONL, Artifacts with hashes, Workspace metadata, preferences, and notification-device metadata. It excludes Provider/API secrets, Browser cookies, Executor reconnect tokens, invite tokens, and files that remain on Executor machines.

Export is snapshot-consistent: either drain writes briefly or record a cursor/watermark and include only data at or before it.

## Quotas

Quotas are per Unit and cover:

- stored Session/event bytes;
- Artifact bytes/count;
- active Sessions and queued messages;
- Browser/Push devices;
- Executor invites/identities.

At a soft threshold, UI warns with cleanup/export actions. At a hard threshold, new content-producing operations fail before side effects with a stable `quota_exceeded` code; reading, exporting, and deletion remain available.

## Migration and recovery

- Every durable file/store has an explicit schema version.
- Migration is backup-first, atomic where possible, and restart-safe.
- Unknown/newer schema fails readiness without rewriting data.
- Startup removes abandoned temp files but never guesses about corrupted primary data.
- Backup restore verifies manifest version, hashes, event counts, Unit assignment, and file permissions before routing resumes.

## Acceptance

- delete/retry/reload remains idempotent;
- two Units reusing identical IDs cannot affect each other;
- crash at each deletion/migration phase leaves a recoverable suspended state;
- export hashes reproduce after restore;
- quota rejection creates no partial Event/Artifact;
- all retained files use restricted permissions and contain no plaintext secrets.

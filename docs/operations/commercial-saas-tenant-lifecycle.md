# Commercial SaaS tenant lifecycle runbook

This is the P0 operating contract for organization lifecycle, retention, deletion,
backup, and restore in the shared commercial SaaS control plane.

## Lifecycle states

| State | Runtime placement | User access | Required operator action |
|---|---|---|---|
| `provisioning` | placement row exists, not customer-ready | blocked by ingress | wait for provisioning outbox and runtime materialization |
| `active` | `ready` | allowed by role policy | normal service |
| `suspended` | `suspended` | blocked by ingress; live sessions revoked | resolve billing/abuse/compliance reason before reactivation |
| `closing` | `suspended` | blocked by ingress; live sessions revoked | export data, confirm backup/PITR checkpoint, schedule purge |
| `closed` | `deleted` tombstone | blocked permanently | retain tombstone and purge tenant data after grace period |

## P0 close procedure

1. Put the organization in `closing` with a unique operation id.
2. Export the organization control-plane bundle and record the artifact id.
3. Confirm the latest database backup or PITR recovery point that covers the
   export timestamp.
4. Close the organization only with `closeConfirmation = "DELETE <org_id>"` and
   a non-empty `backupReference`. The provisioning service rejects close without
   both values and records the backup reference in tenant audit.
5. Verify the Runtime Unit placement desired state is `deleted`; deleted
   materialization tombstones must not be removed or resurrected by stale
   generation events.
6. Run scheduled retention. The retention service purges control-plane browser
   sessions/devices, invokes the Host tenant purge hook for JSONL sessions and
   artifacts using the same cutoff, and writes a tenant-scoped
   `retention.purge` audit event with row counts.

## Release gates

- Runtime ingress in production must use PostgreSQL; JSON control stores are
  migration-only and rejected at startup.
- Runtime ingress must fail closed unless the database schema version exactly
  matches the release migration set, including ahead/behind drift during rolling
  deploys.
- Destructive close and retention purge must be idempotent by operation id or
  by deterministic monthly/scheduled event identity.
- Support access and retained artifacts must use redacted exports; raw provider
  credentials, signed URL queries, bearer tokens, workspace roots, and API keys
  must not leave tenant process memory.

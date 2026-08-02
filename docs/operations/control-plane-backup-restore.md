# Control-plane Backup, Restore and PITR

## Objectives

Pilot objective: **RPO 15 minutes, RTO 4 hours**. Contracted production targets require PostgreSQL WAL archiving/managed PITR and quarterly measured restore drills; nightly logical dumps alone do not satisfy the RPO.

## Backup layers

1. Continuous WAL archive plus daily base backup (or managed PostgreSQL PITR equivalent).
2. Daily custom-format `pg_dump` for portable recovery and pre-migration backups.
3. Independent backups for ZITADEL database, object storage and Runtime Unit data. A control-plane dump is not a complete product backup.
4. Backup manifests include byte length and SHA-256; backup storage is encrypted, access logged and retention controlled.

## Portable backup

```bash
export RUNTIME_INGRESS_DATABASE_URL='postgresql://...'
export RUNLAB_BACKUP_DIR=/secure/backup/control-plane
node scripts/saas-local/backup-control-plane-postgres.mjs
```

The command requires PostgreSQL client tools matching or newer than the server major version. Never place credentials in command history; production resolves them from a protected file/service environment.

## Disposable restore drill

Create an empty disposable database, point `RUNTIME_INGRESS_DATABASE_URL` at it, then run:

```bash
node scripts/saas-local/verify-control-plane-restore.mjs /secure/backup/control-plane/control-plane-TIMESTAMP.dump
```

The verifier checks the manifest, restores with `--exit-on-error`, and reports schema, Organization, membership, browser-session, Audit and Usage counts. Follow with application-level checks for login, authorization, Unit placement and one restored Session.

A restore drill fails if any of these are missing:

- exact backup/target timestamps and measured duration;
- PostgreSQL/server/client versions;
- manifest checksum;
- row-count and application-level verification;
- documented operator and corrective action.

## PITR procedure

1. Declare incident and stop/deny control-plane mutations while preserving evidence.
2. Provision a new PostgreSQL target; never restore over the only copy.
3. Restore latest base backup and replay WAL to the timestamp immediately before the destructive event.
4. Verify schema ledger checksums, Organization/Owner invariants, placements, Audit/Usage monotonicity and Outbox state.
5. Start one Gateway against the recovered target, run authentication/authorization/runtime smoke, then shift traffic.
6. Preserve the failed database read-only until incident closure.

## Retention and deletion

Recommended starting policy: daily logical dumps 14 days, weekly 8 weeks, monthly 12 months; WAL/base-backup retention sufficient for the contractual PITR window. Organization deletion reaches backups only by backup expiry; deletion evidence records that expiry date. Legal/contract policy overrides this default.

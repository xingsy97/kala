# JSON Control Data to PostgreSQL

## Preconditions

- Put Gateway in a maintenance window; no JSON control writes may occur during the final import.
- Revoke legacy outstanding Executor invites. Their raw token semantics cannot be safely upgraded; issue new enrollment tokens afterward.
- Apply PostgreSQL migrations and verify backup destination permissions.
- Keep JSON files unchanged through the compatibility window.

## Procedure

```bash
export RUNTIME_INGRESS_DATABASE_URL='postgresql://...'
export RUNTIME_INGRESS_MIGRATIONS_DIR=packages/runtime-ingress-gateway/migrations
pnpm --filter @agent-kernel/runtime-ingress-gateway build
pnpm --filter @agent-kernel/runtime-ingress-gateway migrate

export RUNTIME_INGRESS_JSON_DIRECTORY=/path/tenant-directory.json
export RUNTIME_INGRESS_JSON_SESSIONS=/path/login-states.json.sessions
pnpm --filter @agent-kernel/runtime-ingress-gateway import:json -- --dry-run
pnpm --filter @agent-kernel/runtime-ingress-gateway import:json
```

The importer validates references before connecting, copies source files to timestamped backups, imports everything in one transaction, records the source checksum, and is idempotent on rerun.

## Verification

Compare importer counts with:

```sql
SELECT count(*) FROM organizations;
SELECT count(*) FROM organization_memberships;
SELECT count(*) FROM browser_sessions;
SELECT source_checksum, summary FROM control_plane_imports;
```

Then start one Gateway with `RUNTIME_INGRESS_DATABASE_URL`, verify existing user login/session listing, Organization membership, Runtime Unit routing and logout-all. Keep all other Gateway replicas stopped until this succeeds.

## Rollback

Stop PostgreSQL-backed Gateway, unset `RUNTIME_INGRESS_DATABASE_URL`, and restart the prior binary against the unchanged JSON files. The importer never mutates source files. Browser sessions created only after cutover do not exist in the JSON rollback point, so rollback intentionally signs those users out.

Do not dual-write indefinitely. The compatibility read window exists only for controlled rollback; PostgreSQL becomes sole authority after acceptance.

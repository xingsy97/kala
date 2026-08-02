# Control-plane PostgreSQL Schema

Status: normative schema design
Migration: `packages/runtime-ingress-gateway/migrations/0001_control_plane.sql`

## Aggregate boundaries

- **Organization aggregate:** Organization, contract entitlement, membership, invite, retention policy and Runtime Unit placement.
- **Workspace aggregate:** Workspace, grant and versioned Tool Policy.
- **Executor aggregate:** pool, machine identity and one-time enrollment token.
- **Identity/session aggregate:** principal, browser session and notification device.
- **Ledgers:** Usage, Audit and Outbox are append-only from application code.

All tenant-owned relationships carry `organization_id`. Composite foreign keys prevent a Workspace, membership, pool, browser session, notification device or Executor from referencing an object in another Organization even if IDs collide or application authorization is defective.

## Invariants requiring transactions

PostgreSQL constraints cover shape and referential isolation. The repository transaction must additionally enforce:

1. Organization provisioning creates Organization, Owner membership, entitlement, retention policy, placement and Outbox event atomically.
2. Owner transfer locks all memberships for the Organization, creates/promotes the new Owner, demotes the prior Owner and increments `authorization_version`; commit is rejected if no active Owner remains.
3. Membership/grant/policy/contract changes increment `authorization_version` and append Audit + Outbox in the same transaction.
4. Executor enrollment consumes `used_count` with `SELECT ... FOR UPDATE`, verifies expiry/revocation, inserts machine identity and appends Audit atomically.
5. Placement mutation compares generation and `last_operation_id`; stale generations fail and repeated operation IDs return the original result.
6. Usage insertion is idempotent on `(organization_id, source_operation_id)`.
7. Audit and Usage rows are never updated or deleted by the application role. Retention runs through a separate narrowly scoped maintenance role.
8. Outbox workers claim rows with `FOR UPDATE SKIP LOCKED`, bounded leases and retry/dead-letter state.

## Deliberate choices

- IDs are application-generated opaque text so imports preserve identity; database sequences are not exposed externally.
- Money/cost estimates use integer microunits, never floating point.
- Token and invite plaintext is never persisted—only cryptographic hashes.
- Provider refresh tokens and push subscriptions remain encrypted envelopes pending migration to `credentialRef` where appropriate.
- Runtime Session/Event Log payloads are not copied into this schema.
- `jsonb` is limited to versioned policy/capability/device/metadata envelopes; query-critical authority remains typed columns.
- Tenant subdomains and tenant URL slugs are not routing dependencies. Optional `slug` is display/admin metadata only.

## Migration policy

- Forward migrations are immutable, ordered SQL files recorded in a migration ledger with checksum and execution time.
- Startup may verify schema compatibility but must not run unbounded DDL in every application replica.
- Destructive changes use expand/backfill/verify/contract across releases.
- Every migration runs with statement and lock timeouts and fails before traffic cutover if a required lock cannot be acquired.
- A release records the minimum and maximum compatible schema versions for Gateway and worker binaries.

## Security roles

- `runlab_migrator`: DDL only during controlled release.
- `runlab_app`: CRUD on mutable control tables; insert/select only on ledgers; no schema ownership.
- `runlab_worker`: Outbox claim/delivery fields and maintenance jobs only.
- `runlab_backup`: read-only backup privileges.
- ZITADEL uses a separate database and role.

Production connections require TLS and server identity verification. Credentials are resolved through the secret boundary and are not stored in Compose environment values or repository files.

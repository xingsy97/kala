# Commercial SaaS Multitenancy Priority Gap

**Status:** planning baseline  
**Last reviewed:** 2026-09-07

## Conclusion

Agent RunLab already has a Private Cloud style multitenant foundation: an
authenticated ingress resolves an Organization to a Runtime Unit, forwards only
trusted tenant-routing headers, and the Runtime Host routes traffic to the
matching tenant runtime/data root. That is more than simple multi-user support.

It is not yet a complete commercial SaaS multitenant product. The remaining
work is mostly about making tenancy a durable commercial and operational
contract: lifecycle, authorization coverage, isolation proof, quotas, billing
hooks, high availability, compliance, observability, and tenant administration.

## Priority definitions

| Priority | Meaning |
|---|---|
| P0 | Required before serving mutually untrusted commercial tenants in one SaaS control plane. Missing items can cause tenant-boundary, billing, data-loss, or operability failures. |
| P1 | Required for a credible paid SaaS beta or enterprise pilot. Missing items create operational load, support risk, or incomplete admin/product flows. |
| P2 | Required for mature SaaS scale. Missing items are product polish, advanced enterprise capabilities, or later-stage efficiency improvements. |

## P0: commercial safety and tenant-boundary correctness

### P0 delivery ledger

| Feature | Current delivery state | Required completion evidence |
|---|---|---|
| Tenant lifecycle state machine | In progress. Organization status is now surfaced through the Organization model and inactive Organizations fail closed at RuntimeIngressGateway before runtime proxying. Provisioning service has targeted tests for provision/status transitions, Runtime Unit placement updates, session revocation, audit, and outbox writes. Runtime Unit delete now writes a durable deleted tombstone instead of removing materialization, and stale or newer resume/provision attempts cannot resurrect a deleted Unit. | End-to-end control-plane command/API for requested/provisioning/active/suspended/closing/closed, operator runbook, and full tenant-root purge acceptance after the deleted-resource grace period. |
| Authorization coverage | Partial. Gateway enforces runtime read/write, organization manage, policy manage, workspace manage for selected routes. Host Socket.IO now has a regression test proving an ingress `viewer` actor cannot send mutating Dashboard events. Host HTTP session-scoped runtime routes now reject ingress actors crossing Organization boundaries for tool-lock, admission messages, attachment upload, session-artifact registration, and session-artifact reads. Executor installation management now stamps creating Organization attribution and blocks cross-tenant admin reads/mutations. Web-search credential mutation/test routes and settings write routes for manual models, providers, default model, agent prompt, and Socket.IO admin configuration are now admin-only in multi-tenant deployments. Background task, terminal, workspace file-list, workspace exec/binary-read, executor-ping, and overflow Socket.IO paths now reject ingress actors crossing Session Organization boundaries and require a subscribed Session that owns the workspace. | Complete route-by-route negative test matrix for remaining non-session HTTP actions. |
| Cross-tenant isolation evidence | Partial. Runtime Unit routing and forged authority header stripping have tests; inactive tenant runtime proxy denial is covered. Tenant runtime tests cover identical session IDs, HTTP artifacts, executor registries, and shared workspace IDs across separate Units. Deleted Unit tombstone tests cover stale generation and resurrection denial. Host WebSocket multiplexed session subscription now rejects ingress actors crossing Organization boundaries, Host HTTP session/artifact routes have cross-tenant negative tests, and executor install management is tenant-scoped. | Two-Organization gateway-to-runtime suite covering remaining workspace APIs and tenant-root path traversal. |
| Quota and entitlement enforcement | Partial. Control-plane schema has entitlements/usage ledger; Host has resource governor and enterprise model policy primitives. Usage ledger now rejects invalid token counts, fails closed when an Organization has no entitlement row, and exposes a tested `assertMonthlyTokenQuota()` guard. Host sessions created through ingress now persist Organization/principal attribution, and the Host loop runs an injected LLM quota enforcer before provider calls, fails closed without tenant attribution, and records provider usage after allowed calls. Host session creation now has an injected tenant session quota enforcer that runs before JSONL creation and fails closed without tenant attribution when enabled. Host message admission now has an injected tenant queue quota enforcer that runs before queue persistence and receives current pending depth. Host HTTP message attachments and session-artifact image registration now run an injected tenant storage quota enforcer before writing bytes or registry entries. Host executor announce now has an injected tenant executor quota enforcer keyed by the install record's Organization attribution, rejects unattributed quota-enabled executors, and records connected runtime duration on disconnect for executor-minute accounting. Host model selection and final LLM calls now run an injected tenant model policy enforcer, with tests proving denied models are not saved and providers are not called. Service account creation has a configured active-token quota, scope allow-list validation, deduplication, and tests proving raw tokens are not persisted. Contract entitlements now include a workspace limit, and `PostgresWorkspaceQuota` fails closed before workspace creation once the active workspace count reaches that limit. | Wire the workspace quota guard into the first workspace-create API when that API lands. |
| Tenant retention and deletion | Partial. Retention schema and `RetentionService` exist for browser sessions/notification devices and export. Targeted tests now prove purge uses the organization's retention policy, fails closed without a policy, and exports only records filtered by the requested organization. Host `SessionStore` can now purge sessions by persisted `organizationId`, applying the same deletion path used for user deletes so JSONL logs, log artifacts, Host artifact partitions, registered images, and attachment stores are removed only for the requested tenant; cutoff-based retention purge keeps newer tenant sessions. Control-plane retention now has an all-tenant purge orchestration method plus a bounded scheduler that enumerates tenant policies and returns per-tenant failures instead of hiding them. The retention service also accepts a production Host purge hook so scheduled retention can clear tenant session/artifact data with the same cutoff after the control-plane purge succeeds, and successful purges now write a tenant-scoped audit event containing the cutoff and deleted row counts. Destructive organization close now requires exact operator confirmation plus a backup/PITR reference recorded in the audit event. | Wire overflow/workspace cleanup. |
| Secret isolation | Partial. Browser refresh tokens use encrypted secret box; product docs require server-side credential references. Shared persistence redaction now has tests for secret keys, bearer tokens, API keys, workspace-root paths, signed URL query stripping, and truncation. Support ticket payloads are redacted before crossing into the ticket system, with tests proving raw bearer tokens and signed URL query strings are not sent. Webhook outbox delivery redacts event payloads before signing/sending and tests the tenant-scoped secret resolver boundary. | Redaction tests for support bundles, Dashboard diagnostics payloads, artifacts, and model context assembly. |
| Control-plane persistence | Mostly implemented for production ingress startup: production requires `RUNTIME_INGRESS_DATABASE_URL`; migration/import CLIs require database URL. Startup mode resolution is now isolated and tested so production cannot fall back to JSON stores, while non-production JSON mode remains explicit. Runtime ingress startup now reads release migrations and fails closed unless the database schema version exactly matches the running release, covering both behind and ahead rolling-deploy drift. | Migration rollback policy, PITR/restore proof, and no-fallback deployment acceptance. |
| Abuse and noisy-neighbor protection | Partial. Unit resource governor supports per-unit concurrency, queue, and artifact-byte accounting. RuntimeIngressGateway has an optional tenant/principal sliding-window rate limiter with 429/retry-after behavior and tests proving limited requests do not reach the runtime upstream. Foreground shell, background shell, file reads, and live terminal streaming now have bounded output paths; terminal sessions emit a truncation marker and are terminated once their live-output budget is exceeded. POSIX foreground/background shell commands support opt-in CPU, virtual-memory, file-size, and process-count `ulimit` controls from Executor environment variables. Monthly token spend monitoring now emits a deduplicated tenant outbox alert when usage crosses a configurable contract threshold. Managed Linux Executor services now install with systemd cgroup controls for CPU, memory, task count, file size, and no-new-privileges. | Remaining abuse tests. |

### Tenant lifecycle state machine

Define and enforce a durable tenant lifecycle:

- requested;
- provisioning;
- active;
- degraded;
- suspended;
- deleting;
- deleted;
- failed-provisioning.

Every transition must have an actor, audit event, retry behavior, and recovery
path. Runtime Unit materialization, routing readiness, default Workspace
creation, retention policy initialization, and tenant data root setup should be
part of the same observable lifecycle contract.

### Authorization coverage for every tenant-scoped operation

The existing organization and role model must be enforced consistently across
all APIs, WebSocket events, tools, sessions, workspaces, artifacts, executor
operations, admin endpoints, and background jobs.

P0 acceptance requires a negative test matrix proving that a principal from one
Organization cannot read, mutate, subscribe to, delete, or infer another
Organization's resources.

### Cross-tenant isolation evidence

Runtime Unit isolation must be converted from an architectural assumption into
release evidence. Required tests include:

- two-tenant session and event-log isolation;
- artifact and overflow-output isolation;
- workspace and executor isolation;
- tenant data-root path traversal resistance;
- forged browser header rejection;
- stale Runtime Unit generation rejection;
- tenant deletion not affecting other tenants.

For public SaaS with mutually untrusted code execution, this should also align
with the stronger isolation roadmap: at minimum process/container boundaries,
resource limits, and egress policy for higher-risk plans.

### Quota and entitlement enforcement

Control-plane schemas for usage and entitlements are not enough. Limits must be
enforced in the data path:

- concurrent sessions;
- queued turns;
- model/token budgets;
- executor minutes;
- storage and artifact size;
- workspace count;
- service account/API token count;
- model/provider availability by plan.

Quota exhaustion must produce explicit user-visible states instead of silent
failure, indefinite loading, or best-effort rejection after work has already
started.

### Tenant-scoped data retention and deletion

Retention policy must be executable, not just representable. P0 needs:

- scheduled retention jobs;
- per-tenant purge for sessions, artifacts, memory, overflow output, audit-safe
  metadata, and workspaces;
- suspend versus delete semantics;
- irreversible-delete confirmation;
- deletion audit trail;
- backup interaction rules.

### Secrets and credential isolation

Tenant secrets must never appear in Dashboard payloads, session logs, traces,
diagnostics, artifacts, or model-visible context. Required controls:

- server-side credential references only;
- tenant-scoped secret stores or key namespaces;
- rotation path;
- revocation path;
- redaction tests for support bundles and traces.

### Control-plane persistence and migration discipline

Commercial SaaS requires a single source of truth for tenant state. PostgreSQL
control-plane storage is appropriate for Private Cloud/SaaS mode, but the
product must make the production path explicit:

- no accidental production fallback to JSON stores;
- migration ordering and rollback policy;
- startup checks for required database configuration;
- backup and point-in-time restore runbook;
- schema compatibility gates during rolling deploys.

### Abuse, rate-limit, and noisy-neighbor protection

The shared control plane must protect itself and other tenants:

- per-tenant and per-principal API rate limits;
- queue depth limits;
- executor CPU/memory/disk/PID limits; POSIX shell commands can now be started
  under CPU, virtual-memory, file-size, and process-count `ulimit` budgets,
  but production SaaS still needs container/cgroup enforcement outside shell
  tools;
- output-size and artifact-size limits; live terminal output is capped and
  terminated after overflow, while shell/background/file paths already use
  bounded output buffers;
- model spend limits;
- alerting for abnormal usage.

## P1: paid beta readiness and enterprise pilot completeness

### Organization administration UI

Build an admin surface for:

- organization profile;
- member list;
- invites;
- role changes;
- workspace grants;
- retention policy;
- usage and quota status;
- service account management;
- audit-log search.

The UI must reflect forbidden, unauthorized, degraded, loading, and empty states
using the unified product state contract.

### Invite, onboarding, and membership flows

The code should support a full user journey:

- first tenant creation;
- invite issuance;
- invite acceptance;
- default role assignment;
- member removal;
- account deactivation;
- re-authentication after session expiry.

OIDC login alone is not enough; commercial tenants need understandable
organization onboarding and recovery flows.

### Billing and metering integration boundary

Even if external billing is intentionally out of scope for Private Cloud, SaaS
needs a clean billing integration boundary:

- immutable usage ledger events;
- tenant plan and entitlement snapshots;
- invoice/export API;
- overage state;
- grace period;
- manual credit/override audit trail.

The enforcement path should not depend on the eventual billing vendor.

### High availability and rollout operations

SaaS mode needs a documented and tested path for:

- multiple ingress replicas;
- control-plane database failover;
- Runtime Unit scheduling across hosts;
- drain/migrate semantics;
- rolling deploys;
- zero-downtime schema migrations;
- stale worker rejection;
- tenant-aware health checks.

### Per-tenant observability and support tooling

Operators need tenant-scoped metrics, logs, traces, and diagnostic bundles:

- tenant ID and runtime unit ID on low-cardinality metrics;
- support-safe trace correlation IDs;
- audit-visible support access;
- tenant health page;
- usage anomaly alerts;
- failed authorization decision logs.

Support access must be explicit, time-bounded, and auditable.

### Workspace-level RBAC completion

Organization roles are not enough for SaaS. Workspace-level grants must be
applied consistently to:

- session creation;
- file browsing;
- shell/executor access;
- artifact access;
- Git operations;
- memory operations;
- sharing and viewer access.

### Enterprise identity baseline

For enterprise pilots, implement the practical minimum:

- per-tenant OIDC/SAML configuration;
- domain claim or tenant discovery;
- JIT provisioning policy;
- IdP metadata rotation;
- session expiry and logout semantics;
- optional SCIM design boundary.

### Compliance export basics

Add tenant-facing exports for:

- audit log;
- usage;
- members and roles;
- workspace inventory;
- data-retention settings;
- deletion request status.

## P2: mature SaaS scale and differentiated enterprise capabilities

### Self-service plan management

Add productized plan management:

- plan comparison;
- trial conversion;
- upgrade/downgrade;
- add-on capacity;
- renewal state;
- admin notifications.

### Advanced tenant placement and regionality

Support:

- region selection;
- data residency;
- tenant migration between regions;
- warm pools by region;
- capacity forecasting;
- placement constraints for regulated tenants.

### Advanced security controls

Later enterprise controls include:

- customer-managed keys;
- tenant egress allowlists;
- private networking;
- IP allowlists;
- device posture hooks;
- break-glass approval workflow;
- SIEM streaming.

### Tenant analytics and cost optimization

Expose mature reporting:

- cost by workspace/session/model;
- latency by provider/runtime unit;
- idle resource recommendations;
- quota forecast;
- noisy workflow detection;
- executor utilization.

### Marketplace and extension governance

If the product grows tool/provider extensibility, SaaS needs tenant governance:

- approved tool catalog;
- provider policy;
- per-tenant MCP server allowlist;
- extension audit;
- sandbox policy by extension risk.

### Customer success workflows

Add operational product workflows:

- onboarding checklist;
- health score;
- renewal risk signals;
- admin education prompts;
- support case bundle generation;
- tenant-level incident history.

## Recommended implementation order

1. Finish P0 authorization coverage and isolation tests before adding more
   visible SaaS controls.
2. Implement tenant lifecycle state machine and quota enforcement together,
   because both must gate Runtime Unit provisioning and session execution.
3. Add admin UI only after the backend contracts are enforceable and audited.
4. Move to P1 HA, observability, and onboarding for a paid beta.
5. Treat P2 as scale and enterprise differentiation, not launch blockers.

## Minimum acceptance bar before calling it commercial SaaS

The product should not be called complete commercial SaaS multitenancy until all
P0 items pass automated acceptance and the following evidence exists:

- two-Organization isolation suite;
- tenant lifecycle integration suite;
- quota enforcement suite;
- retention and deletion suite;
- secret redaction suite;
- ingress/header-forgery security suite;
- control-plane migration and backup/restore runbook;
- operator runbook for tenant suspend, restore, and incident response.

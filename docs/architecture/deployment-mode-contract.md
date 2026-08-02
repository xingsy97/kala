# Deployment Mode Contract

**Status:** normative
**Scope:** Standalone and SaaS product composition, trust boundaries, capabilities, storage, and release acceptance
**Last verified:** 2026-07-29

## 1. Product modes

Agent RunLab ships one codebase in two compositions. Deployment mode changes infrastructure and capabilities; it does not create a reduced Agent implementation.

| Contract | Standalone | SaaS |
|---|---|---|
| Product entry | Direct Host/Dashboard origin | One shared product Origin behind Gateway |
| End-user identity | Not required | External OSS identity provider through Gateway |
| Browser tenant selector | None | None |
| Tenant URL/subdomain | None | None |
| Runtime composition | One fixed `TenantRuntimeUnit(local)` | One opaque Unit assignment per authenticated identity |
| Agent, Session, Workspace, File, Git, Executor, Shell, Artifacts | Enabled | Enabled |
| Benchmark and Evaluation | Enabled | Disabled in UI and server protocols |
| Host user/OIDC/RBAC knowledge | None | None |
| Browser-to-Host access | Direct, optionally shared-token protected | Prohibited; private Host ingress accepts trusted Gateway service credentials only |

## 2. Capability contract

The authoritative runtime payload is `GET /runtime/capabilities`.

```text
Standalone: agent=true, workspace=true, benchmarks=true, evaluations=true
SaaS:       agent=true, workspace=true, benchmarks=false, evaluations=false
```

The Dashboard must remain fail-closed before this payload is validated. A failed or malformed request must not infer Standalone or expose Benchmark/Evaluation. Server capability checks remain authoritative even when a client is stale or malicious.

SaaS disabling means all of the following:

- no Benchmark/Evaluation primary navigation;
- no hidden route, command-palette, Settings, Operations, Pipeline, or Artifact action that starts those services;
- raw HTTP and Socket.IO attempts fail with `403 FEATURE_DISABLED` or the protocol-equivalent denial;
- disabled service initialization is avoided where practical.

It does **not** mean hiding Workspace, files, Git, Executor, Shell, Session sidebar, general Artifacts, or Agent tools.

## 3. SaaS identity and routing contract

The browser authenticates only with the Gateway and identity provider. The immutable assignment key is:

```text
OIDC issuer + subject -> opaque TenantRuntimeUnit ID
```

For every HTTP request, Engine.IO polling request, and WebSocket upgrade, the Gateway:

1. verifies its signed product session;
2. resolves the identity assignment;
3. removes browser cookies, authorization, and attempted internal routing authority before private proxying;
4. writes the trusted Unit route and Gateway service credential;
5. keeps the route stable for the connection lifetime.

The Host validates the service credential and treats the Unit route as opaque deployment input. It does not process profiles, email, OIDC tokens, organizations, memberships, or roles. A browser-supplied Unit/routing header is never authority.

## 4. Unit isolation contract

Every `TenantRuntimeUnit` owns separate instances and storage roots for:

- Session store and message queues;
- workspace aliases and internal/external Executor identities;
- Executor registry, shell/terminal state, operation dedupe, receipts, and token batching;
- Session artifacts and general artifacts;
- push subscriptions, notification devices, and active-device state;
- Socket.IO server, namespaces, adapters, rooms, and recovery state.

Tests must deliberately reuse Session, Workspace, Artifact, call, operation, and device IDs across two Units. Guessed IDs and direct Host traffic fail closed.

Current isolation is logical and process-local. A Host process crash, compromise, memory-safety failure, or resource exhaustion can affect all loaded Units. Container/VM-per-tenant isolation is not claimed.

## 5. Storage and lifecycle

- Standalone keeps existing paths and requires no identity migration.
- SaaS stores Unit data under an opaque Unit root; identity information is retained by Gateway/control-plane storage, not Unit files.
- Provision, suspend, resume, drain, delete, export, backup, and restore are control-plane operations authenticated independently from browser sessions.
- Unit unload/reload must preserve durable state and invalidate ephemeral Engine.IO bindings.
- Push/device APIs are Unit-scoped and therefore identity-scoped through the same Gateway routing path.

## 6. Required release lanes

### Standalone lane

- deploy production bundle to LXD `13000`;
- create Session, send Agent message, use Workspace/Executor/File/Git/Shell, preview Artifact, exercise Settings;
- run Benchmark/Evaluation smoke;
- verify desktop, mobile browser, and PWA surfaces.

### SaaS lane

- deploy Docker stack at product `13001` and identity `13002`;
- create two temporary identities and prove different Units through the same Origin;
- reuse IDs across both Units and prove Session, Workspace, Executor, File, Shell, Artifact, and notification-device isolation;
- verify Agent task completion and persistence for each user;
- prove Benchmark/Evaluation absent and raw invocations denied;
- verify logout, expiry, callback failure, Gateway bypass, and HTTP/WebSocket routing;
- collect desktop/mobile screenshots, console failures, request failures, and cleanup evidence.

A page rendering, a button opening, a unit test, or an HTTP health response alone is not task-chain acceptance.

## 7. Derived documents

- Runtime architecture details: [`tenant-runtime-unit-saas.md`](tenant-runtime-unit-saas.md)
- Authenticated browser shell: [`../design/authenticated-product-shell.md`](../design/authenticated-product-shell.md)
- Local operations: [`../operations/saas-local-runbook.md`](../operations/saas-local-runbook.md)
- User journey acceptance: [`../testing/critical-user-action-matrix.md`](../testing/critical-user-action-matrix.md)
- Verification policy: [`../meta/testing.md`](../meta/testing.md)

If a derived document conflicts with this contract on deployment mode, capability shape, product Origin, or identity/Host ownership, this contract wins.

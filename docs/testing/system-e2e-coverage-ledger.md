# System E2E Coverage Ledger

**Status:** normative migration ledger  
**Authority:** [`../meta/testing.md`](../meta/testing.md), [`product-e2e-harness.md`](product-e2e-harness.md), and [`critical-user-action-matrix.md`](critical-user-action-matrix.md)  
**Last audited:** 2026-08-14

This ledger prevents a lower-layer test or fixture-driven browser check from being reported as a complete product journey. `Complete` means production artifact, real user entry, real transports/processes/side effects, final visible and authoritative state, persistence/recovery, and cleanup evidence. Public domains and external providers are outside the hermetic boundary unless a separate canary is named.

| Journey | Strongest current evidence | Reality break | Status | Required system E2E |
|---|---|---|---|---|
| Add Workspace — Linux service | `scripts/product-e2e/verify-add-workspace-linux-service.mjs` | Public domain/reverse proxy is an explicit external canary; macOS/Windows are separate journeys | Complete (Linux local-origin) | Production Dashboard → copied command → clean LXD → checksum/native install → systemd active/enabled → Workspace visible → restart/replay/cleanup |
| Add Workspace — temporary | `scripts/product-e2e/verify-add-workspace-linux-temporary.mjs` | Public origin and non-Linux platforms remain separate canaries | Complete (Linux local-origin) | Dashboard command in clean LXD → Workspace online → terminate → offline/cleanup |
| New Session | Core journey covers create/select/reload; controlled-agent journey covers durable delete | Parent/child cascade delete remains with Sub-agent journey | Complete (create/select/reload/delete) | Production bundle, UI create, exact selected ID, reload, persisted cwd |
| Agent Runtime selection | `scripts/dashboard/verify-runtime-session-picker.mjs` and Runtime metadata component/integration tests | Existing browser check stops before Session creation and does not prove the selected Runtime owns the turn | Partial | Production UI selection → remembered preference → exact Runtime in created Session and Session Info → reload |
| Running Session switch | `scripts/product-e2e/verify-controlled-agent-journey.mjs` | Hover-preview stress and mobile touch remain | Complete (desktop pointer) | Active turn plus real click/hover switch to another Session without blocked UI |
| Direct/queued message | `scripts/product-e2e/verify-controlled-agent-journey.mjs` | Many-message load stress remains a performance lane, not a functional gap | Complete (queue/edit/reorder/delete/restart/exactly-once drain) | Controlled protocol provider, production processes, ACK/queue/edit/reorder/delete/drain/reconnect |
| Files and preview | Core journey covers real text/binary/download bytes; controlled-agent journey proves live hover preview and sandbox denial UI | Large-file truncation remains a performance/limit extension | Complete (read/binary/download/live preview/denial) | Real Executor list/read/write/binary/download, live preview update, reload, path denial |
| Git | `scripts/product-e2e/verify-core-workspace-journeys.mjs` | Error/unavailable state and staged mutation remain | Complete (real status/diff) | Real repo status/diff/mutation/refresh/error through production UI |
| Interactive Terminal | `scripts/product-e2e/verify-core-workspace-journeys.mjs` | Host-restart recovery is covered; Executor-process restart with an open PTY remains | Complete (input/output/resize/kill/restart) | Real Chromium keyboard → PTY echo/resize/kill/reconnect cleanup |
| Agent tool chain | `scripts/product-e2e/verify-controlled-agent-journey.mjs` | Test runner command is represented by a real shell assertion; provider compatibility remains external | Complete (read/write/shell/failure) | Controlled same-protocol model stream with actual read/write/shell/test tools and durable result |
| GitHub Copilot Runtime | Unit/integration coverage plus `scripts/runtime/verify-agent-runtime-tools.mjs`; `scripts/product-e2e/verify-copilot-runtime-journey.mjs` is the official-provider UI canary | Official authentication/provider is external; isolated production artifact ownership, approval rejection, active-turn restart, Executor reconnect, and SDK-side deletion evidence are not yet hermetic | Partial (external canary) | Add a controlled same-protocol Copilot boundary to an isolated production Host/Executor journey; retain the official-provider canary for SDK/CLI compatibility |
| Tool intention and dot line | `scripts/product-e2e/verify-controlled-agent-journey.mjs` | Very large omission-count stress remains | Complete (multi-call/replay/geometry) | Live tool call with `_intent`, running/completed UI, expanded details, reload/replay, no overlay obstruction |
| Sub-agent lifecycle | `scripts/product-e2e/verify-controlled-agent-journey.mjs` | External provider compatibility remains a canary | Complete (success/provider failure/UI cancel) | Real child running/success/failure/cancel and parent transcript persistence |
| Custom system prompt | Core journey proves UI/disk/restart; controlled-agent journey proves provider request | External provider compatibility remains a canary | Complete (local controlled boundary) | Edit/save in production UI → disk → Host restart → new Session controlled-provider request contains prompt |
| PWA install/update/offline | `scripts/product-e2e/verify-pwa-update-reload.mjs` | v1/v2 are deterministic variants of one production build; physical iOS remains external | Complete (Chromium controlled update) | Two production builds, controlled SW update, reload latency, Session recovery, offline/reconnect |
| Restart/recovery | Core journey covers Host/browser/Executor reconnect; controlled-agent journey covers active turn plus persisted queue exactly-once | Executor process restart with open PTY remains a dedicated resilience extension | Complete (Host active-turn/queue) | Host/Executor restart during durable operations, reconnect and exactly-once state |
| Responsive surfaces | `verify-dashboard-mobile-pwa.mjs` now runs the production embedded bundle across desktop/mobile/iPad/standalone | Physical iOS keyboard remains an external-device canary | Complete (Chromium matrix) | Keep Chromium matrix; physical iOS remains an explicitly reported external-device canary |
| Private Cloud identity/isolation | Local acceptance is wired in `.github/workflows/private-cloud-product-e2e.yml` with strict two-identity/stack preflight | Current workstation lacks the local stack and temporary identities; external IdP/public origin remain canaries | Environment-gated | Local same-protocol identity/two-Unit E2E plus separate external IdP/public-origin canary |

## Existing browser-script classification

| Script | Correct classification | Reason |
|---|---|---|
| `scripts/dashboard/verify-dashboard-real.mjs` | browser system integration | Built Dashboard and real processes, but source Host/Executor and an environment-dependent model boundary |
| `scripts/dashboard/verify-dashboard-mobile-pwa.mjs` | fixture-driven browser check | Production UI geometry with prewritten Session JSONL; it does not install, update, or recover a PWA |
| `scripts/dashboard/verify-dashboard-layout-scroll.mjs` | fixture-driven browser check | Real Chromium/Host with prewritten events and no Executor task chain |
| `scripts/dashboard/verify-dashboard-headless.mjs` | static/PWA browser check | Vite preview, no Host or Executor task chain |
| `scripts/dashboard/verify-tool-call.mjs` | environment-dependent browser integration | Real tool process, but it attaches to a pre-existing environment and does not own production artifact startup |
| `scripts/product-e2e/verify-copilot-runtime-journey.mjs` | official-provider UI external canary | Uses production UI and real Copilot SDK/CLI, Host, Executor, tools, persistence, and cleanup, but attaches to an existing deployment and cannot own external authentication/provider or process restart |
| `scripts/release/verify-release-install.mjs` | release smoke | Starts one production bundle and probes assets; no user task or OS installation lifecycle |

## Topology

```mermaid
flowchart TD
  P[Normative principles and ledger] --> H[Production E2E harness]
  H --> I[Installer and Workspace identity]
  H --> S[Session and message lifecycle]
  H --> T[Terminal and filesystem]
  H --> U[Settings, tool UI, and PWA]
  I --> R[Restart and failure recovery]
  S --> R
  T --> R
  U --> R
  R --> C[CI and release gates]
```

Foundation precedes journeys so artifact startup, Chrome, LXD, evidence, timeout, and cleanup behavior are not reimplemented inconsistently. Recovery follows happy paths because it reuses their observable milestones. CI gates are last so an unstable scenario is not normalized as a flaky required check.

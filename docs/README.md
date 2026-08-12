# docs/

Documentation index for `agent-kernel`. If you're new here, start with the project [README](../README.md) — it has curated reading paths for different intents. This index is grouped by **component** so you can jump straight to whatever you're touching.

---

## By component

### Kernel — the pure-function FSM (`packages/kernel`)

| File | Purpose |
|---|---|
| [kernel/spec.md](kernel/spec.md) | **Normative.** Types, state machine, invariants. The kernel contract. |
| [kernel/core-protocol-design-review.md](kernel/core-protocol-design-review.md) | Review of the kernel FSM, event/effect schema, wire protocol, and boundary risks |

### Host — Node loop, extensions, HTTP/socket transport (`packages/host`)

| File | Purpose |
|---|---|
| [host/context-compaction.md](host/context-compaction.md) | Host-driven compaction: triggers, protocol invariants, thresholds, known gaps |
| [host/session-log-context-persistence.md](host/session-log-context-persistence.md) | **Target design.** Breaking v2 session-log/context persistence rewrite; explains current JSONL growth root cause and reference-agent formats |
| [host/background-shell-design.md](host/background-shell-design.md) | Long-running shell tasks: registry, output streaming, dashboard control plane |
| [host/sub-agent-design.md](host/sub-agent-design.md) | `agent` builtin: envelope, control-plane, forced `allow_all` |
| [host/memory-consolidation.md](host/memory-consolidation.md) | Memory extension: consolidation triggers, storage, tool exposure |
| [host/tool-output-overflow.md](host/tool-output-overflow.md) | Executor-side large-output spillover and preview pointers |
| [host/skills.md](host/skills.md) | OpenCode-style `skill({ name })` tool loading |
| [host/mcp.md](host/mcp.md) | MCP runtime integration design (planned, not yet implemented) |

### Dashboard — React SPA (`packages/dashboard`)

| File | Purpose |
|---|---|
| [dashboard/debugger-design.md](dashboard/debugger-design.md) | Right-sidebar Inspector — debugger, not metrics dashboard |
| [dashboard/advanced-debugger-features.md](dashboard/advanced-debugger-features.md) | Follow-up features building on the debugger foundation |
| [dashboard/llm-message-assembly-debugger.md](dashboard/llm-message-assembly-debugger.md) | Explaining how LLM API messages are assembled |
| [dashboard/derived-ui-enhancements.md](dashboard/derived-ui-enhancements.md) | Higher-level UI features derived from existing state |
| [dashboard/browser-feature-todo.md](dashboard/browser-feature-todo.md) | Browser (web) feature backlog |
| [dashboard/browser-core-local-runtime.md](dashboard/browser-core-local-runtime.md) | Browser-core local runtime option — planned |
| [dashboard/frontend-modernization-plan.md](dashboard/frontend-modernization-plan.md) | Phased modernization: auto-animate, TanStack Query, Motion, typewriter |
| [dashboard/session-runtime-interaction-sot.md](dashboard/session-runtime-interaction-sot.md) | **Normative.** Running-Session shell responsiveness, hover preview, status UI, overlays, stress testing, and deployment gates |

### Executor — tool sandbox (`packages/executor`)

| File | Purpose |
|---|---|
| [executor/tools.md](executor/tools.md) | **Normative.** Tool schemas, outputs, error contracts |

### Protocol — wire contracts (shared between all processes)

| File | Purpose |
|---|---|
| [protocol/wire-protocol.md](protocol/wire-protocol.md) | **Normative.** Every Socket.IO event between Dashboard, Host, and Executor |
| [protocol/event-log.md](protocol/event-log.md) | **Current implementation.** JSONL event log format for persistence, replay, fork; see the host session-log document for the breaking v2 target |

### Evaluation — standalone platform and benchmark references

| File | Purpose |
|---|---|
| [architecture/agent-evaluation-platform-refactor.md](architecture/agent-evaluation-platform-refactor.md) | Standalone evaluation architecture and clean-cutover contract |
| [architecture/agent-evaluation-platform-implementation-ledger.md](architecture/agent-evaluation-platform-implementation-ledger.md) | Atomic implementation and verification ledger |
| [evaluation/](evaluation/) | Contributor, security, compatibility, and release contracts |
| [evals/references-comparison.md](evals/references-comparison.md) | Quantitative comparison of Claude Code, Codex, opencode, pi |
| [evals/domain-knowledge/](evals/domain-knowledge/) | Per-benchmark domain notes (SWE-bench, τ-bench, Terminal-Bench, WebArena) |

### RL — Agentic RL / slime integration

| File | Purpose |
|---|---|
| [rl/system-design.md](rl/system-design.md) | **Source of truth.** Architecture, why historical sessions aren't RL samples, artifact families |
| [rl/implementation.md](rl/implementation.md) | Local implementation gate and acceptance criteria |
| [rl/training-design.md](rl/training-design.md) | Training methodology, GPU/budget decisions, stop conditions, risks |
| [rl/shared-runbooks.md](rl/shared-runbooks.md) | Shared E2E smoke tiers + rented GPU host paid runbook; per-run parameters live in `../experiments/rl/<date>-run-<n>/runbook.md` |
| [../experiments/rl/README.md](../experiments/rl/README.md) | Explains the RL experiment record layout and ignore boundaries |

---

## Cross-cutting

### Architecture

| File | Purpose |
|---|---|
| [architecture/overview.md](architecture/overview.md) | Three processes and one full turn end-to-end |
| [architecture/deployment-mode-contract.md](architecture/deployment-mode-contract.md) | **Normative.** Standalone/SaaS capabilities, identity boundary, Unit isolation, and required release lanes |
| [architecture/product-hardening-program.md](architecture/product-hardening-program.md) | Current gated implementation order: product foundation, refactors, Docker, Box, quality gate, then LXD |
| [architecture/hosted-hybrid-enterprise-benchmark-matrix.md](architecture/hosted-hybrid-enterprise-benchmark-matrix.md) | Grafana/GitLab/GitHub/Sentry benchmark matrix and Hosted/Hybrid build-vs-integrate decisions |
| [architecture/core-agent-invariants-and-fault-model.md](architecture/core-agent-invariants-and-fault-model.md) | Normative cross-component authority map, invariants, fault injections, proofs, and release blockers |
| [architecture/browser-session-store.md](architecture/browser-session-store.md) | Accepted design for opaque, server-revocable browser Sessions, device lists, refresh, and logout-all |
| [architecture/observability-contract.md](architecture/observability-contract.md) | Bounded metrics, structured errors, health, SLOs, redaction, alerting, and acceptance |
| [architecture/data-lifecycle-contract.md](architecture/data-lifecycle-contract.md) | Ownership, deletion, retention, export, quotas, migrations, backup, and recovery semantics |
| [architecture/strong-isolation-roadmap.md](architecture/strong-isolation-roadmap.md) | Migration from logical Units to worker processes, containers, and remote Runtime pools |
| [architecture/runtime-naming-migration.md](architecture/runtime-naming-migration.md) | RuntimeIngressGateway/RuntimeHost/RuntimeUnitIngress naming contract and compatibility policy |
| [architecture/llm-dependency-contract.md](architecture/llm-dependency-contract.md) | Explicit LLM Port/Adapter/Factory/SecretResolver boundaries and lifecycle scopes |
| [architecture/session-artifact-registry.md](architecture/session-artifact-registry.md) | Durable session-bound `artifact://` image registration and rendering |
| [architecture/visual-approval-loop.md](architecture/visual-approval-loop.md) | **Normative target.** Read-only Visual Preview, A2UI-compatible Visual IR, Agent-only patching, design confirmation, functional-coverage gates, and Browser Lab verification |
| [testing/core-hardening-baseline-2026-07-31.md](testing/core-hardening-baseline-2026-07-31.md) | Frozen source/runtime/data baseline and evidence rules for the highest-strength core Agent regression program |
| [testing/core-change-risk-and-coverage-matrix.md](testing/core-change-risk-and-coverage-matrix.md) | Changed-surface to invariant/test mapping, confirmed gaps, severity, and downstream audit ownership |
| [testing/session-log-integrity-audit.md](testing/session-log-integrity-audit.md) | Session cursor/append/replay atomicity findings, legacy compatibility policy, fixes, and regression evidence |
| [architecture/tenant-runtime-unit-saas.md](architecture/tenant-runtime-unit-saas.md) | **Accepted architecture and implementation record.** `TenantRuntimeUnit` logical isolation and SaaS composition |
| [architecture/standalone-runtime-unit-refactor.md](architecture/standalone-runtime-unit-refactor.md) | **Normative.** Stable Ingress, Standalone `local` Unit, external deployment Supervisor, migration, rollback, and final cutover contract |

### Operations

| File | Purpose |
|---|---|
| [operations/saas-local-runbook.md](operations/saas-local-runbook.md) | Single Docker SaaS stack with mandatory NFS Session storage, bootstrap, verification, backup, upgrade, and rollback |
| [operations/standalone-runtime-unit-cutover.md](operations/standalone-runtime-unit-cutover.md) | External staging, preflight, bounded cutover, verification, observation, and rollback for Standalone Runtime Unit migration |

### Design

| File | Purpose |
|---|---|
| [design/human-attention-score.md](design/human-attention-score.md) | Session-scoped human attention indicator and draft risk-matched LLM evaluator |
| [design/session-slash-commands.md](design/session-slash-commands.md) | Session slash command semantics for `/clear`, `/rename`, `/stop`, and `/delete` |
| [design/authenticated-product-shell.md](design/authenticated-product-shell.md) | SaaS account identity, logout, cache partitioning, and authenticated product-shell behavior |
| [design/logout-semantics.md](design/logout-semantics.md) | Product logout, logout-all, Provider-wide logout, forced-login, and cross-device behavior |
| [design/account-center.md](design/account-center.md) | Hosted profile, login Sessions/devices, identity links, data/legal/support, and Settings grouping |

### Testing

| File | Purpose |
|---|---|
| [testing/critical-user-action-matrix.md](testing/critical-user-action-matrix.md) | Mode-aware end-to-end acceptance criteria for every critical visible action |
| [testing/feature-review-ledger.md](testing/feature-review-ledger.md) | Current feature-by-feature implementation evidence, gaps, and remaining release proof |
| [testing/current-program-baseline.md](testing/current-program-baseline.md) | Frozen LXD boundary, current service snapshot, isolated validation environments, and evidence policy |
| [testing/product-e2e-harness.md](testing/product-e2e-harness.md) | Normative real-action, side-effect, persistence, failure/recovery, evidence, and cleanup contract |

### Capabilities

| File | Purpose |
|---|---|
| [capabilities/](capabilities/) | Numbered capability designs (11 items — see the [README](capabilities/README.md)) |

### Planning

| File | Purpose |
|---|---|
| [planning/roadmap.md](planning/roadmap.md) | Shipped feature ledger + deferred items |
| [planning/feature-gaps.md](planning/feature-gaps.md) | Shipped vs. deliberately-out vs. gaps; comparison table (pi / opencode / codex / claude-code) |
| [planning/production-readiness.md](planning/production-readiness.md) | What still stands between the current build and a production deploy |
| [planning/roadmap-notes/dashboard-product-readiness.md](planning/roadmap-notes/dashboard-product-readiness.md) | Active coordinating plan for product maturity, phased implementation, and verification evidence |
| [planning/roadmap-notes/](planning/roadmap-notes/) | Free-form roadmap essays: streaming, RL, product-polish, and explicit non-goals |

### Meta — principles, testing, releasing, ADRs

| File | Purpose |
|---|---|
| [meta/principles.md](meta/principles.md) | Non-negotiable principles that govern all doc + code decisions |
| [meta/past-mistakes.md](meta/past-mistakes.md) | Retrospective on decisions that turned out wrong, so we don't repeat them |
| [meta/authoring-notes.md](meta/authoring-notes.md) | Index of authoring guidance for contributors |
| [meta/testing.md](meta/testing.md) | Per-layer test strategy + CI configuration |
| [meta/releasing.md](meta/releasing.md) | npm publish workflow (tag-driven) |
| [meta/adr/](meta/adr/) | Architecture Decision Records — one file per big call, with alternatives and consequences |

---

## When docs disagree

Authority is concern-specific rather than one global linear ranking:

- agent execution semantics: `kernel/spec.md`;
- cross-process wire messages: `protocol/*.md`;
- Executor tool contracts: `executor/tools.md`;
- deployment modes, capabilities, identity ownership, and Unit isolation: `architecture/deployment-mode-contract.md`;
- verification policy: `meta/testing.md`;
- user-journey acceptance: `testing/critical-user-action-matrix.md`;
- runbooks and planning/status ledgers are derived and never override normative contracts.

Each cross-cutting document should declare its status and scope. If documents conflict, fix the derived or stale document rather than selecting whichever was edited most recently.

## When code disagrees with docs

**Docs win.** The kernel and its consumers are meant to be spec-driven. If the code does something the spec doesn't describe, either the code is buggy or the spec is missing something. Open an issue.

## Adding a new doc

- Belongs to one component? Put it under `kernel/`, `host/`, `dashboard/`, `executor/`, `protocol/`, or `evals/`.
- Cross-component design? Put it under `architecture/`.
- Capability design? Put it under `capabilities/`.
- Roadmap or planning note? Put it under `planning/`.
- Principle, process, ADR, or team-level guidance? Put it under `meta/`.
- Add a link to this index in the same PR.

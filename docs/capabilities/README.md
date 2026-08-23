# Capability Design Index

Status: implementation-aligned design documents
Created: 2026-07-09
Last reviewed against implementation: 2026-07-09

This folder collects production-oriented capability designs for `agent-kernel`.
The files are ordered by expected user and product value, not by
implementation difficulty.

Each document now has an implementation alignment section. That section is the
source of truth for what the repository actually does today versus what remains
design work. This distinction matters because several capability areas already
have CLI actions, artifact schemas, dashboard readouts, and browser e2e coverage,
but are not yet full product workflows.

The main rule across all documents is: do not increase the complexity of the
core reducer, state machine, or wire protocol unless the feature cannot be built
cleanly at the host, executor, dashboard, or adapter layer. The project already
has a good core property: an append-only JSONL event ledger and replayable pure
kernel state. New capabilities should preserve that property and export to
industrial standards instead of inventing toy protocols.

## Priority Order

1. [SWE-bench Evaluation Integration](01-swe-bench-evaluation-integration.md)
2. [Production Agent Tracing](02-production-agent-tracing.md)
3. [Agent Evaluation Platform](03-agent-eval-benchmark-platform.md)
4. [Agentic RL Rollout Export](04-agentic-rl-rollout-export.md)
5. [Context Engineering Engine](05-context-engineering-engine.md)
6. [Model and Tool Router](06-model-tool-router.md)
7. [Long Task Reliability](07-long-task-reliability.md)
8. [Memory System](08-memory-system.md)
9. [Multi-Agent Collaboration](09-multi-agent-collaboration.md)
10. [Latency and Cost Profiling](10-latency-cost-profiling.md)
11. [Platform Components](11-platform-components.md)

## Current Implementation Snapshot

| Area | Implemented today | Not production-complete yet |
| --- | --- | --- |
| SWE-bench | Standalone adapter, fresh immutable task/slice resolution, pinned official harness, isolated Worker execution, canonical evidence, three-Agent acceptance. | Remaining production invariants are tracked in the evaluation implementation ledger. |
| Production tracing | Redacted request/response artifacts, OpenInference-shaped trace export, OTLP HTTP JSON exporter CLI with retry/header/timeout controls, message assembly artifacts, LLM API modal, router/tool catalog artifacts, adapter capture of provider `gatewayRequestId` + optional `weightVersion` surfaced as `gen_ai.response.id`/`agent_kernel.model.weight_version` span attributes. | No always-on live OTLP streaming from within a running session, no collector integration guide, partial provider request capture depending on adapter path, no cross-run trace comparison backend. |
| Eval platform | Independent protocol, Control Plane, Worker, Analyzer/grader, Dashboard, plugin SDK, reports, regression gates, defect/reproduction lifecycle, and CI integrations. | Open requirements remain itemized in the evaluation implementation ledger. |
| Agentic RL | Rollout sidecars, conservative segment index, slime handoff manifest with checked-in trainer contract fixture, guarded verl export requiring real token ids with matching checked-in captured-token + AgentLoopOutput fixtures, and a `verify-reward` runner emitting canonical `rl_reward` artifacts from RL verifier results. | No generation-time token gateway, no trainer integration, no batch rollout controller. |
| Context engineering | Compaction events, message assembly artifacts, contribution breakdown, debugger modal, structured memory contribution accounting, budget partition reason codes, compaction summary schema validation. | No preflight gate that consumes budget reason codes; no compaction retry when summaries fail schema validation; no objective-aware compaction wizard. |
| Model/tool router | Router decision artifacts, tool catalog artifacts, `tool-catalog diff` CLI/HTTP action for cross-run catalog comparison, skill-backed tool marking. | No health-aware provider fallback policy, no retry taxonomy artifacts, no capability-based executor routing. |
| Long task reliability | Append-only recovery, offline reliability audit, chaos replay report, `reliability gate` verdict with CI exit codes, `reliability classify` crash-kill report using heartbeat + audit primitives, background terminal process info/kill UI. | No process supervisor that actually consumes the heartbeat/idempotency-ledger primitives from a live session, no crash-kill e2e matrix across host/executor/provider, no executor-side idempotency enforcement path. |
| Memory | Workspace/global markdown memory index (with stale/conflict detection), tombstones, dashboard Memory tab with stale/conflict counts, assembly contribution metadata, host-side lexical retrieval (`memory retrieve` CLI + HTTP action) with token budget + reason codes, Session policy derivation via `deriveSessionMemoryPolicy`, and host-loop enforcement of disabled memory scopes. | No preflight injection of retrieved hits into the message assembly budget, no memory write approval UX. |
| Multi-agent | Host `agent` builtin, child sessions, subagent graph export, dashboard expandable subagent cards, least-privilege role-template policy resolver (`research`/`implementation`/`test`/`review`) with controlled implementation writes, timeout, recursive depth, and per-parent fan-out enforcement; failed-child and parent-recovery Socket.IO coverage. | No product-level comparative quality/cost view for subagent-enabled versus single-agent sessions. |
| Latency/cost profiling | Product Session profile export, pricing file support, TTFT/duration aggregation, and dashboard Profiles tab. | No always-on session cost panel, no versioned provider pricing bundles, no executor queue-time capture. |
| Platform components | Independently buildable TypeScript evaluation services/plugins, production-form images, public SDK packaging, release gates, and official SWE-Bench Python tool layer. | No external artifact server; remaining deployment/conformance evidence is tracked in the ledger. |

## Evaluation entry point

Evaluation is not a product Dashboard or Host feature. Deploy the standalone
Control Plane, Workers, Analyzer/grader, and `eval-dashboard`, submit a fresh
canonical run through the Control Plane CLI/API, and inspect it in that
standalone Web application. Product sessions and historical product artifacts
are never used as evaluation input.

## Common Architecture Rule

Each capability should fit this layering:

- Kernel: pure reducer, existing event/state invariants, no benchmark or vendor
  knowledge.
- Host: product orchestration, LLM adapters, product session logs, and product trace export.
- Executor: workspace-local tools, sandbox, process management, file operations.
- Dashboard: product inspection, replay, and diagnostics; evaluation has its own Dashboard.
- Adapters: SWE-bench, OpenTelemetry/OpenInference, RL frameworks, external eval
  stores.

The durable session JSONL remains the harness ledger. Production traces,
benchmark results, and RL samples are derived/exported artifacts with their own
industry-compatible contracts.

## Design Principles

These principles are implementation constraints, not style preferences.

### 1. Preserve The Kernel Boundary

The reducer remains the smallest stable contract in the system. It should only
model agent-visible state transitions: messages, pending tool calls, approval,
usage, status, memory entries that are intentionally reducer-owned, and replay
cursor. It must not learn benchmark names, provider telemetry fields, trace span
ids, reward schemas, pricing tables, process ids, or model-router internals.

When a feature seems to need a new event kind or state field, first try one of
these placements:

- event-log metadata next to an existing event;
- host-side artifact referenced by session id and event seq;
- dashboard-derived view from existing event/effect data;
- standalone evaluation artifact referenced through the Control Plane;
- executor-local process/tool metadata surfaced through normal tool results.

Only add reducer protocol surface when replay correctness or agent-visible
behavior genuinely depends on it.

### 2. Use Standards As Export Contracts

The project can keep simple internal TypeScript types for implementation, but
the external contract should map to mature ecosystems:

- trace export maps to OpenTelemetry GenAI and OpenInference concepts;
- benchmark grading delegates to official harnesses such as SWE-bench;
- RL rollout export maps to slime/verl-native adapter shapes;
- release automation uses standard GitHub Actions release artifacts.

Internal metadata types are allowed only as adapters or indexes. They must not
be presented as new universal protocols.

### 3. Separate Ledger, Artifacts, And Views

There are three different data classes:

- ledger: append-only JSONL session events for replay;
- artifact: large or sensitive payloads such as request bodies, responses,
  diffs, logs, traces, scores, and token segments;
- view: dashboard projections, summaries, charts, filters, and compact tables.

Do not store large artifacts in kernel state. Do not require dashboard views to
be authoritative. Do not make artifacts necessary for deterministic replay.

### 4. Redaction Is Part Of Persistence

Anything written to disk or exported outside process memory must pass through a
redaction boundary when it may contain provider URLs, credentials, local paths,
environment variables, prompt bodies, tool args, tool results, or user data.
The UI should state whether content is captured, redacted, truncated, or absent.

### 5. Every Capability Needs A Failure Taxonomy

Production systems need low-cardinality failure labels. Each capability should
define its own operational labels and keep raw details as artifacts. Examples:
`provider_timeout`, `patch_apply_failed`, `tool_timeout`, `artifact_missing`,
`agent_timeout`, `redaction_applied`, `unknown_cost`.

### 6. Eval And RL Must Be Reproducible

Every eval or rollout run must record model id, provider adapter, prompt/tool
versions, code version when available, dataset version, timeout policy,
compaction policy, and environment summary. A score without run metadata is not
useful for comparisons or training.

### 7. UI Fancy Features Stay Derived

Dashboard capabilities can be visually rich, but they should remain projections
over session logs, artifacts, traces, and eval summaries. They must not add
hidden state machines that compete with the host/kernel lifecycle.

## Implementation Foundation

The first implementation layer shared by all capability themes is:

- an artifact store for redacted JSON/text artifacts;
- an artifact manifest that indexes run outputs for dashboards and cleanup jobs
  without copying artifact payloads into a second store;
- deterministic redaction helpers;
- an OpenTelemetry/OpenInference-shaped span exporter derived from session logs;
- eval run and trial metadata writers;
- SWE-bench prediction JSONL helpers and official harness command builder;
- RL rollout sidecar helpers that index ledger, trace, token, and reward
  artifacts without pretending to be a training tensor format.

This foundation gives every later feature a concrete place to put data while
keeping the core state machine unchanged.

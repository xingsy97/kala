# Enhancement Design Index

Status: planning documents  
Created: 2026-07-09

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

## Common Architecture Rule

Each enhancement should fit this layering:

- Kernel: pure reducer, existing event/state invariants, no benchmark or vendor
  knowledge.
- Host: orchestration, LLM adapters, session logs, trace export, eval runners.
- Executor: workspace-local tools, sandbox, process management, file operations.
- Dashboard: inspection, replay, diagnostics, eval result exploration.
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
- adapter-specific run directory under `runs/`;
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

### 5. Every Enhancement Needs A Failure Taxonomy

Production systems need low-cardinality failure labels. Each enhancement should
define its own operational labels and keep raw details as artifacts. Examples:
`provider_timeout`, `patch_apply_failed`, `tool_timeout`, `artifact_missing`,
`agent_timeout`, `redaction_applied`, `unknown_cost`.

### 6. Eval And RL Must Be Reproducible

Every eval or rollout run must record model id, provider adapter, prompt/tool
versions, code version when available, dataset version, timeout policy,
compaction policy, and environment summary. A score without run metadata is not
useful for comparisons or training.

### 7. UI Fancy Features Stay Derived

Dashboard enhancements can be visually rich, but they should remain projections
over session logs, artifacts, traces, and eval summaries. They must not add
hidden state machines that compete with the host/kernel lifecycle.

## Implementation Foundation

The first implementation layer shared by all enhancement themes is:

- an artifact store for redacted JSON/text artifacts;
- deterministic redaction helpers;
- an OpenTelemetry/OpenInference-shaped span exporter derived from session logs;
- eval run and trial metadata writers;
- SWE-bench prediction JSONL helpers and official harness command builder;
- RL rollout sidecar helpers that index ledger, trace, token, and reward
  artifacts without pretending to be a training tensor format.

This foundation gives every later feature a concrete place to put data while
keeping the core state machine unchanged.

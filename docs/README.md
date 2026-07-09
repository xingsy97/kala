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
| [host/web-native-paths-implementation.md](host/web-native-paths-implementation.md) | Companion to [capability 12](capabilities/12-web-native-path-handling.md) |

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

### Executor — tool sandbox (`packages/executor`)

| File | Purpose |
|---|---|
| [executor/tools.md](executor/tools.md) | **Normative.** Tool schemas, outputs, error contracts |

### Protocol — wire contracts (shared between all processes)

| File | Purpose |
|---|---|
| [protocol/wire-protocol.md](protocol/wire-protocol.md) | **Normative.** Every Socket.IO event between Dashboard, Host, and Executor |
| [protocol/event-log.md](protocol/event-log.md) | **Current implementation.** JSONL event log format for persistence, replay, fork; see the host session-log document for the breaking v2 target |

### Evals — benchmarks, references

| File | Purpose |
|---|---|
| [evals/badcase-mining.md](evals/badcase-mining.md) | Bad-case mining: category definitions and pipeline |
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

### Capabilities

| File | Purpose |
|---|---|
| [capabilities/](capabilities/) | Numbered capability designs (12 items — see the [README](capabilities/README.md)) |

### Planning

| File | Purpose |
|---|---|
| [planning/roadmap.md](planning/roadmap.md) | Shipped feature ledger + deferred items |
| [planning/feature-gaps.md](planning/feature-gaps.md) | Shipped vs. deliberately-out vs. gaps; comparison table (pi / opencode / codex / claude-code) |
| [planning/production-readiness.md](planning/production-readiness.md) | What still stands between the current build and a production deploy |
| [planning/roadmap-notes/](planning/roadmap-notes/) | Free-form roadmap essays: eval-moat, narrative, streaming, RL, product-polish, what-not-to-do |

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

If two docs contradict each other, the more normative one wins:

**kernel/spec.md > protocol/\*.md > executor/tools.md > everything else**

If you find such a contradiction, please open a PR to fix the lower-tier doc — that's the definition of a doc bug.

## When code disagrees with docs

**Docs win.** The kernel and its consumers are meant to be spec-driven. If the code does something the spec doesn't describe, either the code is buggy or the spec is missing something. Open an issue.

## Adding a new doc

- Belongs to one component? Put it under `kernel/`, `host/`, `dashboard/`, `executor/`, `protocol/`, or `evals/`.
- Cross-component design? Put it under `architecture/`.
- Capability design? Put it under `capabilities/`.
- Roadmap or planning note? Put it under `planning/`.
- Principle, process, ADR, or team-level guidance? Put it under `meta/`.
- Add a link to this index in the same PR.

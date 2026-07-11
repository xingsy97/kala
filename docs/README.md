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
| [host/background-shell-design.md](host/background-shell-design.md) | Long-running shell tasks: registry, output streaming, dashboard control plane |
| [host/sub-agent-design.md](host/sub-agent-design.md) | `agent` builtin: envelope, control-plane, forced `allow_all` |
| [host/memory-consolidation.md](host/memory-consolidation.md) | Memory extension: consolidation triggers, storage, tool exposure |
| [host/tool-output-overflow.md](host/tool-output-overflow.md) | Executor-side large-output spillover and preview pointers |
| [host/skills.md](host/skills.md) | OpenCode-style `skill({ name })` tool loading |
| [host/mcp.md](host/mcp.md) | MCP runtime integration design (planned, not yet implemented) |
| [host/web-native-paths-implementation.md](host/web-native-paths-implementation.md) | Companion to [enhancement 12](planning/enhancement/12-web-native-path-handling.md) |

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
| [protocol/event-log.md](protocol/event-log.md) | **Normative.** JSONL event log format for persistence, replay, fork |

### Evals — benchmarks, RL, references

| File | Purpose |
|---|---|
| [evals/badcase-mining.md](evals/badcase-mining.md) | Bad-case mining: category definitions and pipeline |
| [evals/agentic-rl-integration.md](evals/agentic-rl-integration.md) | Agentic RL rollout integration — adapter-first, not trajectory-first |
| [evals/references-comparison.md](evals/references-comparison.md) | Quantitative comparison of Claude Code, Codex, opencode, pi |
| [evals/domain-knowledge/](evals/domain-knowledge/) | Per-benchmark domain notes (SWE-bench, τ-bench, Terminal-Bench, WebArena) |

---

## Cross-cutting

### Architecture

| File | Purpose |
|---|---|
| [architecture/overview.md](architecture/overview.md) | Three processes and one full turn end-to-end |

### Planning

| File | Purpose |
|---|---|
| [planning/roadmap.md](planning/roadmap.md) | Shipped feature ledger + deferred items |
| [planning/feature-gaps.md](planning/feature-gaps.md) | Shipped vs. deliberately-out vs. gaps; comparison table (pi / opencode / codex / claude-code) |
| [planning/production-readiness.md](planning/production-readiness.md) | What still stands between the current build and a production deploy |
| [planning/enhancement/](planning/enhancement/) | Numbered enhancement designs (12 items — see the [README](planning/enhancement/README.md)) |
| [planning/roadmap-notes/](planning/roadmap-notes/) | Free-form roadmap essays: eval-moat, narrative, streaming, RL, product-polish, what-not-to-do |

### Meta — principles, testing, releasing, ADRs

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
- Roadmap / enhancement design? Put it under `planning/`.
- Principle, process, ADR, or team-level guidance? Put it under `meta/`.
- Add a link to this index in the same PR.

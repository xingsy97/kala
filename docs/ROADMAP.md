# Roadmap

**Status of this doc**: Living. Update as phases complete.

The project is split into six phases, each producing a runnable milestone. Every phase has explicit acceptance criteria — you can tell it's "done" without asking.

---

## Legend

- 🟢 **Complete** — all acceptance criteria met
- 🟡 **In progress**
- ⚪ **Not started / deferred**

---

## Phase 0 — Learning & spec 🟢

**Purpose**: Ground the design in the actual state of the art. Avoid inventing things existing projects already handle well.

**Deliverables**:
- 🟢 Clone and read the reference projects: [pi](https://github.com/earendil-works/pi), [opencode](https://github.com/sst/opencode), [codex](https://github.com/openai/codex), [Claude Code source-collection](https://github.com/chauncygu/collection-claude-code-source-code)
- 🟢 Quantitative comparison: `docs/references-comparison.md` (~2800 words, 10 kernel design lessons)
- 🟢 Full design + spec: `docs/SPEC.md`, `docs/ARCHITECTURE.md`, protocol docs, ADRs
- 🟢 Repository skeleton: monorepo with pnpm workspace, TypeScript strict mode, Vitest

---

## Phase 1 — Kernel 🟢

**Deliverables** (`packages/kernel/`):
- Types: `types.ts` — Message / Event / State / Effect / Config
- FSM step: `core.ts` — pure `step(state, event, config)` (dispatch table, see [ADR 0010](adr/0010-fsm-dispatch-table.md))
- State factory: `state.ts` — `createInitialState()`, `createConfig()`
- Fold/fork: `fold.ts` — `fold`, `foldWithTrace`, `fork`
- Barrel: `index.ts`

**Kernel is zero-runtime-dependency, pure-function.** Production code ~350 LOC (excluding tests). Every kernel invariant in `docs/SPEC.md` §5 is tested.

---

## Phase 2 — Host 🟢

**Deliverables** (`packages/host/`):
- `src/llm/anthropic.ts` — Anthropic Messages API adapter (streaming SSE)
- `src/llm/openai.ts` — OpenAI Chat Completions adapter (also handles Codex-compatible endpoints)
- `src/llm/index.ts` — provider registry, model → adapter mapping
- `src/loop.ts` — the host loop: `runSession(state, config, deps)`. Consumes effects, dispatches IO, feeds results back as events. Iterates until terminal status. Handles compaction (auto + manual), the `agent` builtin, stream cancellation, and background shell dispatch.
- `src/store/session.ts` — in-memory session map + JSONL append-only event log writer. Recovers stuck sessions on load.
- `src/store/replay.ts` — load from JSONL, produce state via `fold`
- `src/connection/server.ts` — Socket.IO server, both namespaces, room routing, workspace-based `tool:call` routing
- `src/connection/dashboard.ts` — dashboard event handlers
- `src/connection/executor.ts` — executor event handlers
- `src/config.ts` — auto-import providers from `~/.codex/config.toml` and `~/.claude/settings.json`, merge with `~/.agent-kernel/config.json`
- `src/index.ts` — entry point: `startHostServer(port, deps)`
- `bin/agent-kernel-host.ts` — CLI to run Host standalone; also serves `packages/dashboard/dist/`

Plus `packages/shared/src/protocol.ts` — wire protocol types shared across host / executor / dashboard.

---

## Phase 3 — Executor 🟢

**Deliverables** (`packages/executor/`):
- `src/tools/` — one file per tool in [tools.md](tools.md): `read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash`, `todowrite`, `web_search`, `bash_output`, `kill_shell`
- `src/tools/index.ts` — tool registry + input-schema validation (ajv)
- `src/sandbox.ts` — workspace whitelist enforcement (symlink-aware)
- `src/client.ts` — Socket.IO client to Host; announces `workspaceId` / `workspaceName` / `os` / `runtime` / `sandboxRoots` / tool names; handles `tool:call` / `fs:list_dirs` / cancel
- `src/background.ts` — per-executor background shell registry (`bash --run-in-background` → `taskId`; `bash_output`; `kill_shell`)
- `src/index.ts` — entry point: `startExecutor({ host })`
- `bin/agent-kernel-executor.ts` — CLI

The `agent` builtin is host-side, not executor-side; it does not appear in the executor tool registry.

---

## Phase 4 — Dashboard 🟢

**Deliverables** (`packages/dashboard/`):
- Vite + React + Tailwind + shadcn/ui scaffolding
- `src/client/socket.ts` — Socket.IO client hooks
- `src/features/explorer/` — two-level tree of workspaces + sessions with time-bucket grouping, cwd surfacing, rename-in-place, and Info dialogs for workspace and session metadata
- `src/features/chat/` — chat panel (text + image blocks, streaming render, compact boundary marker, user message edit + fork, image paste), Composer (model picker, context pressure ring, approval mode picker, `/compact` slash command, context pressure banner)
- `src/features/inspector/` — state tree viewer, event timeline (with compaction request details), effects panel, usage panel, approval cards with unified diff for `edit` / `write`
- `src/features/history/` — replay scrubber, fork button on any event
- `src/features/settings/` — provider list (auto-imported + user-added), model picker per provider, approval mode default, host / port config
- `src/features/create-session/` — Workspace picker + Finder-style cwd picker + provider/model picker
- `src/features/background/` — background terminal panel derived from `bash` / `bash_output` / `kill_shell` events
- `src/features/activity/` — bottom activity bar (runtime status, permission banners)

Built as a static bundle; served by Host from `packages/dashboard/dist/`. Themes: light + dark via Tailwind `darkMode: 'class'` and shadcn semantic tokens.

---

## Phase 5 — Replay & Fork 🟢

The differentiated capability.

- Host: `client:fork` handler creates new JSONL with fork header (see [event-log.md](protocol/event-log.md) §5). Fork header inlines the folded state so parent logs can be archived without breaking the child.
- Dashboard: session list from the JSONL directory (`server:sessions`), timeline scrubber, Fork button on any event.
- Snapshot writing (optional perf hack): every N events or on turn-end, write a `snapshot` entry. Deleting snapshots is always safe.

---

## Phase 6 — Browser Executor (WebContainer) ⚪

Intentionally out of v1 scope. The extension point is designed but the WebContainer adapter is not shipped.

**Why deferred**: the wire protocol and Socket.IO client contract already permit a browser-side executor (the executor doesn't own kernel state, only tool execution). Actually shipping a WebContainer adapter would require an FS + spawn interface refactor across the tools (WebContainer's API is `fs.promises`-style but posix-only, no sync variants, no realpath), COOP/COEP cross-origin isolation headers in the dashboard Vite config, StackBlitz auth token handling, and browser-side manual QA. v1's contribution stops at "the kernel, host, and dashboard are agnostic to how tools run" — the Node executor is proof enough of that decoupling.

---

## Cross-cutting concerns (ongoing)

- **Test coverage**: kernel 100%, host ≥80%, executor tools ≥90%, dashboard component + puppeteer computedStyle cross-check for theme / layout changes (see [testing.md](testing.md) §5.3)
- **Docs currency**: any protocol / spec change requires the corresponding doc PR in the same commit
- **CI**: GitHub Actions running `pnpm typecheck && pnpm test && pnpm build` on PRs
- **Examples**: `examples/` walkthroughs per phase double as regression checks

---

## Deferred / not committed

Ideas outside the current scope. See [FEATURE-GAPS.md](FEATURE-GAPS.md) §3 for the concrete short list and §2 for the "never" list; the items below are the larger-scope ones that are not simple to slot in:

- **Additional LLM adapters**: local llama.cpp / ollama; anything with a non-OpenAI-compat wire format.
- **MCP runtime**: expose the executor as an MCP server; consume third-party MCP tools at runtime. Currently a config-only stub.
- **Multi-executor per session**: routing different tool names to different workspaces within one turn. Intentionally not designed for (see [ARCHITECTURE.md](ARCHITECTURE.md) §4.3).
- **Kernel port to Rust**: same spec, different impl language, for embedding in non-JS environments.
- **Extension API**: a documented way to add planning/memory/subagent orchestration around the kernel, without patching it.
- **Session sharing**: publish a session (JSONL) as a public URL, viewable but not forkable. Doubles as a bug-repro tool.
- **Cost budget enforcement**: host-level threshold on `usage.costUsd`; auto-inject cancel if exceeded.

---

## Non-goals

- **Not a Claude Code / Codex competitor.** Reference implementation and teaching artifact, not a product with a paid tier.
- **Not an orchestration framework.** Kernel doesn't do orchestration (see [ADR 0005](adr/0005-kernel-boundary.md)). We don't chase LangGraph / crewai's feature set.
- **Not a UI framework.** Dashboard is one artifact of one deployment. If someone wants a TUI, VS Code extension, or CLI-only front-end, they can build on top of the kernel and protocol.

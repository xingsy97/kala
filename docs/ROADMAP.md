# Roadmap

**Status of this doc**: Living. Update as phases complete.
**Last updated**: 2026-07-04

The project is split into six phases, each producing a runnable milestone. Every phase has explicit acceptance criteria — you can tell it's "done" without asking.

Timings below are calendar estimates assuming one person working part-time (evenings/weekends). Adjust to reality.

---

## Legend

- 🟢 **Complete** — all acceptance criteria met
- 🟡 **In progress**
- ⚪ **Not started**

---

## Phase 0 — Learning & spec (Complete) 🟢

**Purpose**: Ground the design in the actual state of the art. Avoid inventing things existing projects already handle well.

**Deliverables**:
- 🟢 Clone and read the 4 reference projects: [pi](https://github.com/earendil-works/pi), [opencode](https://github.com/sst/opencode), [codex](https://github.com/openai/codex), [Claude Code source-collection](https://github.com/chauncygu/collection-claude-code-source-code)
- 🟢 Produce quantitative comparison: `docs/references-comparison.md` (~2800 words, 10 kernel design lessons)
- 🟢 Full design + spec: `docs/SPEC.md`, `docs/ARCHITECTURE.md`, protocol docs, ADRs
- 🟢 Repository skeleton: monorepo with pnpm workspace, TypeScript strict mode, Vitest

**Acceptance**: Design and specs are complete enough that a competent implementer (human or code agent) can start Phase 1 without asking questions. **Met**.

---

## Phase 1 — Kernel (Complete) 🟢

**Purpose**: Land the heart of the project. Everything else is scaffolding around this.

**Deliverables** (in `packages/kernel/`):
- 🟢 Types: `types.ts` — Message / Event / State / Effect / Config
- 🟢 FSM step: `core.ts` — pure `step(state, event, config)` (dispatch table, see [ADR 0010](adr/0010-fsm-dispatch-table.md))
- 🟢 State factory: `state.ts` — `createInitialState()`, `createConfig()`
- 🟢 Fold/fork: `fold.ts` — `fold`, `foldWithTrace`, `fork`
- 🟢 Barrel: `index.ts`
- 🟢 Tests: 23 unit tests in `core.test.ts`

**Acceptance criteria**:
- ✅ `pnpm test` passes 23/23
- ✅ `pnpm typecheck` clean
- ✅ `pnpm build` produces `dist/` with `.js` + `.d.ts`
- ✅ Kernel imports zero runtime dependencies
- ✅ Line count: production code < 500 (achieved ~350 LOC excluding tests)
- ✅ Every kernel invariant in `docs/SPEC.md` §5 is tested

**Status: complete**.

---

## Phase 2 — Host (LLM adapter + host loop + Socket.IO server) 🟢

**Purpose**: Turn the kernel into a running agent. Wire in a real LLM and a stub Executor. Prove the loop end-to-end.

**Deliverables** (in `packages/host/`):
- `src/llm/anthropic.ts` — Anthropic Messages API adapter (translate `Message[]` ↔ Anthropic request/response)
- `src/llm/openai.ts` — OpenAI Chat Completions adapter (deferred to Phase 2.5 if crunched)
- `src/llm/index.ts` — provider registry, model → adapter mapping
- `src/loop.ts` — the host loop: `runSession(state, config, deps) → Promise<AgentState>`. Consumes effects, dispatches IO, feeds results back as events. Iterates until terminal status.
- `src/store/session.ts` — in-memory session map + JSONL append-only event log writer
- `src/store/replay.ts` — load from JSONL, produce state via `fold`
- `src/connection/server.ts` — Socket.IO server, both namespaces, room routing
- `src/connection/dashboard.ts` — dashboard event handlers
- `src/connection/executor.ts` — executor event handlers
- `src/index.ts` — entry point: `startHostServer(port, deps)`
- `bin/agent-kernel-host.ts` — CLI to run Host standalone

Plus:
- `packages/shared/src/protocol.ts` — wire protocol types (used by host, executor, dashboard)
- Contract tests: given a mock LLM and a mock Executor client, drive a full turn and assert the event log matches expectations

**Acceptance criteria**:
- Can run `node packages/host/bin/agent-kernel-host.js` locally
- With a mocked Anthropic response, driving a turn end-to-end produces the correct JSONL log
- Real Anthropic call with a real API key returns a response and the loop terminates
- 90%+ unit-test coverage on the LLM adapter (mocked HTTP)
- Wire-protocol handshake round-trip tested with a Socket.IO client fixture
- Event log format matches `docs/protocol/event-log.md` exactly

**Estimate**: 5–8 days.

---

## Phase 3 — Executor (Node daemon) 🟢

**Purpose**: Ship the local Executor that Host dispatches tool calls to. Prove multi-process end-to-end.

**Deliverables** (in `packages/executor/`):
- `src/tools/` — one file per tool in `docs/tools.md` (read, ls, glob, grep, write, edit, bash)
- `src/tools/index.ts` — tool registry + input-schema validation (using ajv or zod)
- `src/sandbox.ts` — workspace whitelist enforcement
- `src/client.ts` — Socket.IO client to Host, handles `tool:call` / `tool:cancel`
- `src/index.ts` — entry point: `startExecutor({ host, session, workspace })`
- `bin/agent-kernel-executor.ts` — CLI

**Acceptance criteria**:
- All 7 tools have unit tests (happy path + error cases)
- Sandbox: attempting a path outside the workspace returns `EACCES: outside workspace`
- Executor connects to Host (local dev), announces tools, handles `tool:call` and returns via ACK
- End-to-end: user_message → LLM (real API) → tool_call → executor runs it → tool_result → LLM → final answer. Works over `ws://localhost:3000`.
- End-to-end (cloud): same flow with Host on a public host and Executor on a laptop behind NAT

**Estimate**: 5–7 days.

---

## Phase 4 — Dashboard (chat + inspector) 🟢

**Purpose**: The visualization layer that makes this project *look* like something. Chat on the left, inspector on the right.

**Deliverables** (in `packages/dashboard/`):
- Vite + React + Tailwind + shadcn/ui scaffolding
- `src/client/socket.ts` — Socket.IO client hooks (React hooks over Socket.IO events)
- `src/features/chat/` — chat panel: message list, input, approval buttons
- `src/features/inspector/` — inspector panel:
  - State tree viewer (JSON tree of current `AgentState`)
  - Event timeline (list of events with cursor labels)
  - Effects panel (per-event effects list)
  - Usage panel (token/cost running total)
- `src/routes/session/[id].tsx` — session route
- `src/routes/index.tsx` — session list

**Acceptance criteria**:
- Connects to Host via Socket.IO, subscribes to a session, renders live state
- Chat panel: send message, see response stream in, approve/reject tool calls
- Inspector: state tree updates on every `state:changed` event; timeline lists all events
- Diff view for `write` and `edit` tool calls before approval
- Terminal-style output for `bash` tool calls (xterm.js integration acceptable but not required for v1)
- Deployed as a static site (pnpm build → dist/)

**Estimate**: 7–10 days.

**Note**: after Phase 4, this is a demoable, screenshot-able project. Keep as release evidence.

---

## Phase 5 — Replay & Fork 🟢

**Purpose**: The unique feature. This is the "you can pause, rewind, and fork any session" moment.

**Deliverables**:
- Dashboard: session list route reads from the JSONL directory (via a Host API)
- Dashboard: session detail with **timeline scrubber** — drag to any cursor, state panel shows the state at that point
- Dashboard: **Fork** button on any event — creates a new session forking from that cursor. The forked session starts empty (waiting for user input at that state) so the user can steer differently
- Host: `client:fork` handler that creates new JSONL with fork header (see [event-log.md](protocol/event-log.md) §5)
- Snapshot writing (optional for perf): every N events, write a `snapshot` entry

**Acceptance criteria**:
- Given a completed session, scrubbing to cursor N shows the state as it was after event N
- Forking at cursor N and sending a new user message runs a **new** session whose event log starts with a fork header, and the state at cursor N matches the parent's state at cursor N
- Deleting the parent session's log file after fork does NOT break the child session (the child's header contains the initial state)

**Estimate**: 4–6 days.

**Note**: after Phase 5, the project has a genuinely differentiated capability that neither Claude Code nor Codex nor pi ships.

---

## Phase 6 — Browser Executor (WebContainer) — deferred ⚪

**Status**: intentionally out of v1 scope. The extension point is designed but the WebContainer adapter is not shipped.

**Why deferred**: the wire protocol and Socket.IO client contract already permit a browser-side executor (the executor doesn't own kernel state, only tool execution). Actually shipping a WebContainer adapter would require:

- an FS + spawn interface refactor across the 7 tools (WebContainer's API is `fs.promises`-style but posix-only, no sync variants, no realpath),
- COOP/COEP cross-origin isolation headers in the dashboard Vite config,
- StackBlitz auth token handling for the WebContainer runtime,
- browser-side manual QA (no CI story — WebContainer requires a real browser).

v1's contribution stops at "the kernel, host, and dashboard are agnostic to how tools run" — the Node executor is proof enough of that decoupling. A browser executor can be added later without changing kernel or protocol.

---

## Cross-cutting concerns (ongoing)

These aren't phases but must be maintained throughout:

- **Test coverage**: kernel 100%, host ≥80%, executor tools ≥90%
- **Docs currency**: any protocol / spec change requires the corresponding doc PR in the same commit
- **CI**: GitHub Actions running `pnpm typecheck && pnpm test && pnpm build` on PRs (set up during Phase 2)
- **Examples**: as each phase completes, add an `examples/phase-N-*.md` walkthrough (helps external readers, doubles as regression check)

---

## Post-v1 (not committed)

Ideas that don't fit in phases 1–6 but are on the mind:

- **Dashboard v1.1 — session + executor management UI** ([ADR 0012](adr/0012-dashboard-ui-redesign.md), proposed): the current two-column layout has no session list, no executor/workspace panel, no multi-Host support. Redesign proposes a Hosts / Sessions sidebar (opencode-style rail + expandable panel), a per-session toolbar (model / mode / usage / working), and create-session + executor drawer modals. Requires two additive wire-protocol events (`client:list_sessions`, `client:list_executors`) and adds `@tanstack/react-router` + `@tanstack/react-query` + shadcn/ui to the dashboard. **Design only; no code yet.**
- **Second LLM adapter**: OpenAI at minimum, ideally also a local (llama.cpp / ollama) adapter to prove provider-agnosticism
- **MCP shim**: expose the executor as an MCP server too, so `agent-kernel` can be adopted by Claude Desktop / Cursor without changing Executor code
- **Multi-executor per session**: `bash` goes to local daemon, `read`/`write` go to browser vfs, `web_fetch` goes to a third executor
- **Streaming LLM responses**: `llm_delta` event, dashboard renders tokens as they arrive
- **Kernel port to Rust**: for people who need to embed the kernel in a non-JS environment. Same spec, different impl language
- **Extension API**: a documented way to add planning/memory/subagent orchestration around the kernel, without patching the kernel itself
- **Session sharing**: publish a session (JSONL) as a public URL, viewable but not forkable without the API key. Doubles as a "share a bug repro" tool
- Cost budget enforcement: host-level threshold on `usage.costUsd`; auto-inject a cancel if exceeded. Kernel already tracks the total, host decides policy

---

## Non-goals (never)

- **Not a Claude Code / Codex competitor**. We aim to be a *reference implementation* and teaching artifact, not a product with a paid tier.
- **Not an orchestration framework**. Kernel doesn't do orchestration (see [ADR 0005](adr/0005-kernel-boundary.md)). We don't chase LangGraph / crewai's feature set.
- **Not a UI framework**. Dashboard is one artifact of one deployment. If someone wants a TUI, VS Code extension, or CLI-only front-end, they can build on top of the kernel and protocol.

---

## Current status snapshot (2026-07-04)

- Phase 0: 🟢 Complete
- Phase 1: 🟢 Complete (kernel, 23 tests)
- Phase 2: 🟢 Complete (host + LLM adapters (Anthropic + OpenAI-compatible) + JSONL log + wire protocol, 16 tests)
- Phase 3: 🟢 Complete (executor + sandbox + 7 tools + CLI, 40 tests)
- Phase 4: 🟢 Complete (dashboard React SPA, 7 tests)
- Phase 5: 🟢 Complete (replay/fork + lineage UI + wire test)
- Phase 6: ⚪ Deferred (design intact; adapter not shipped)

**Total**: 86 tests across the monorepo. Kernel → Host → Executor → Dashboard runs end-to-end. A real-LLM smoke over an OpenAI-compatible endpoint is scripted in `examples/e2e-smoke.mjs`.

**Next action** (post-v1): [ADR 0012](adr/0012-dashboard-ui-redesign.md) — Dashboard v1.1 UI redesign (session + executor management, layout, framework upgrade). Design proposed, implementation pending review of the ADR.

---

## Current status snapshot (2026-07-05)

Batch A backend work is complete through the automatic gate:

- Implemented compaction, streaming deltas, cancel-in-flight, crash recovery, permission modes, multimodal messages, MCP stub, session cwd, host-side `agent`, and background shell tools.
- Composer footer now owns status/cursor/pending/token chips and exposes manual compaction via a compact icon plus exact `/compact` command.
- Automatic gate passed: `pnpm -r typecheck`, kernel tests, host tests, executor tests.
- Manual compaction smoke passed against a real Host + Executor and headless Chrome: the Composer compact button and exact `/compact` command both emitted `client:compact` and produced `compact_replaced` JSONL entries without appending `/compact` as a user message.

Next planned work is Batch B dashboard UX: compact pressure banner, streaming render + ESC cancel, permission picker, message edit/rerun, image paste, `@file` picker, hooks, settings, rename, cwd toolbar/metadata modal.

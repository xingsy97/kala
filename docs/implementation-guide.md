# Implementation Guide

**Audience**: a code agent (or human implementer) picking up `agent-kernel` after Phase 1 and implementing Phases 2–6 from the specs in this repo.
**Assumes**: kernel v0.1 is already in `packages/kernel/`; the current implementation has since grown to 43 kernel tests with Batch A additions. This guide covers everything downstream and is older than the latest implementation notes near the end.

The docs are normative; this guide is procedural. If a doc says one thing and the guide says another, **the doc wins** — please open a PR to fix the guide.

---

## 0. Read this before touching code

**Mandatory reading, in this order:**

1. [docs/SPEC.md](SPEC.md) — normative kernel contract. **Do not modify.** You'll consume this via the already-built kernel.
2. [docs/ARCHITECTURE.md](ARCHITECTURE.md) — the 3-process shape and turn lifecycle.
3. [docs/protocol/wire-protocol.md](protocol/wire-protocol.md) — Socket.IO events between processes.
4. [docs/protocol/event-log.md](protocol/event-log.md) — JSONL file format.
5. [docs/tools.md](tools.md) — the core tools plus Batch A additions Executor/Host must expose.
6. [docs/ROADMAP.md](ROADMAP.md) — phase acceptance criteria (your definition of "done").
7. [docs/testing.md](testing.md) — what tests each layer needs.
8. [docs/adr/](adr/) — read all ADRs. They explain *why* the design is what it is; you'll be tempted to deviate, and the ADRs pre-empt those temptations.

**Estimated reading time**: 90–120 minutes. Skipping this step is the single biggest predictor of wasted work.

---

## 1. Working model

You are implementing a system with clean boundaries. **Cross a boundary in code only when the spec crosses it.**

- **Kernel** is done. You import it. You don't modify it.
- **Host** is a Node process that wraps the kernel. It does LLM calls, hosts the Socket.IO server, writes the JSONL log.
- **Executor** is a separate Node process (or WebContainer instance in Phase 6) that dials into Host and executes tool calls.
- **Dashboard** is a React SPA that dials into Host and renders live state.

Every phase adds one of these processes. Do not build ahead of the phase you're in.

---

## 2. Sequencing

The dependency graph is:

```
Phase 1 kernel  ─┬─→  Phase 2 host  ─┬─→  Phase 3 executor  ─┐
                 │                    │                        ├→  Phase 4 dashboard  ─→  Phase 5 replay/fork  ─→  Phase 6 browser executor
                 └────────────────────┴────────────────────────┘
```

Phase 2 unblocks Phase 3. Phase 3 unblocks Phase 4 (you *can* build dashboard against Phase 2 host with a stubbed executor, but the flow isn't demoable until Phase 3). Phase 5 assumes 4. Phase 6 assumes 4.

**Rule of thumb**: do not start phase N+1 until phase N passes its acceptance criteria in `docs/ROADMAP.md`.

---

## 3. Phase 2 — Host

**Goal**: turn the kernel into a running service. Real Anthropic call, headless host loop, in-memory session map, Socket.IO server.

### 3.1 Directory layout

Scaffold `packages/host/`:

```
packages/host/
├── package.json               # deps: socket.io, undici, @agent-kernel/kernel
├── tsconfig.json              # extends root tsconfig
├── src/
│   ├── index.ts               # exports: startHostServer(port, deps)
│   ├── loop.ts                # runSession(state, config, deps) → Promise<AgentState>
│   ├── llm/
│   │   ├── types.ts           # LLMAdapter interface
│   │   ├── anthropic.ts       # Anthropic Messages API adapter
│   │   ├── openai.ts          # (deferred to Phase 2.5 if time-crunched)
│   │   ├── index.ts           # provider registry
│   │   └── __fixtures__/      # recorded response bodies
│   ├── store/
│   │   ├── session.ts         # in-memory Map<sessionId, SessionHandle>
│   │   ├── log.ts             # JSONL append writer
│   │   └── replay.ts          # loadSession(path): { config, state, events }
│   ├── connection/
│   │   ├── server.ts          # Socket.IO server bootstrap
│   │   ├── dashboard.ts       # /dashboard namespace handlers
│   │   ├── executor.ts        # /executor namespace handlers
│   │   └── router.ts          # sessionId ↔ room, executor pool
│   └── config.ts              # env parsing, defaults
├── bin/
│   └── agent-kernel-host.ts   # CLI entry point
└── src/**.test.ts
```

### 3.2 Build order within Phase 2

Follow this order — each step is verifiable before you move on.

**Step 1: LLM adapter (Anthropic)**

1. Define the `LLMAdapter` interface in `llm/types.ts`:
   ```typescript
   export interface LLMAdapter {
     call(input: LLMCallInput, signal: AbortSignal): Promise<LLMCallOutput>
   }
   export interface LLMCallInput {
     model: string
     systemPrompt?: string
     messages: readonly Message[]  // from @agent-kernel/kernel
     tools: readonly ToolSchema[]
   }
   export interface LLMCallOutput {
     content: MessageContent[]
     usage: UsageDelta
   }
   ```
2. Implement `anthropic.ts` — HTTP POST to `https://api.anthropic.com/v1/messages`.
   - Translate `messages` per Anthropic Messages API shape (system prompt goes in top-level `system` field, `tool_use` / `tool_result` blocks map to Anthropic's shapes).
   - Parse the response back into `MessageContent[]` and `UsageDelta`.
3. Write unit tests with mocked HTTP (undici's `MockAgent` or `msw`). Cover:
   - happy path (text response)
   - tool_use response
   - HTTP 429 → adapter throws `LLMRateLimitError` (host maps to `llm_error` event)
   - HTTP 5xx → generic error
   - network abort → cancellation honored

**Verify**: `pnpm --filter @agent-kernel/host test src/llm/anthropic.test.ts` passes.

**Step 2: Host loop**

1. Implement `loop.ts` with signature:
   ```typescript
   export async function runSession(
     initial: AgentState,
     config: AgentConfig,
     deps: HostDeps,
     signal?: AbortSignal
   ): Promise<AgentState>
   ```
   where `HostDeps` includes `llm: LLMAdapter`, `executor: ExecutorHandle`, `log: LogWriter`, `emit: (event: WireEvent) => void`.
2. The loop is:
   ```typescript
   let state = initial
   while (!isTerminal(state.status)) {
     for (const effect of state.effects) {
       await handleEffect(effect, state, deps, signal)
       // handleEffect may dispatch an event back via step()
     }
     if (nothingHappened) break  // guard against infinite loops
   }
   return state
   ```
   In practice you'll dispatch events *as they arrive from IO*, not iterate over `state.effects`. Look at SPEC §4 for the kernel's effect semantics.

3. `handleEffect` cases:
   - `call_llm` → invoke `deps.llm.call(...)`, produce `assistant_message` event, feed back via `step`.
   - `call_tool` → invoke `deps.executor.callTool(...)` (returns a Promise<ToolResult>), produce `tool_result` event.
   - `finish` → break the loop.
   - `emit_progress` → forward to `deps.emit`.
   - `persist` → append to JSONL via `deps.log`.

4. Write integration tests with mock LLM and mock Executor. Drive a full turn, assert final state and event log content. See `docs/testing.md` §3.2 for the shape.

**Verify**: `pnpm --filter @agent-kernel/host test src/loop.test.ts` passes with mocked deps.

**Step 3: Store (session map + JSONL log)**

1. `store/log.ts`: `LogWriter { append(entry: LogEntry): Promise<void>; close(): Promise<void> }`. Append-only, one JSON per line. Use `fs.createWriteStream(path, { flags: 'a' })`.
2. `store/session.ts`: `Map<sessionId, SessionHandle>` where `SessionHandle = { state, config, log: LogWriter, subscribers: Set<Socket> }`. Session lifecycle: `create` writes header, subsequent events append.
3. `store/replay.ts`: `loadSession(path): { header: HeaderEntry, events: AgentEvent[], config: AgentConfig }` — reads JSONL, parses, returns. `fold` from kernel does the state reconstruction.

**Verify**: unit tests for round-trip (write session events → load → fold → same state). See `docs/protocol/event-log.md` §4 for the replay algorithm.

**Step 4: Connection layer**

1. `connection/server.ts`: `startHostServer(port, deps): Server`. Boots `socket.io` server, mounts both namespaces (`/dashboard`, `/executor`).
2. `connection/dashboard.ts`: handlers for the events in `docs/protocol/wire-protocol.md` §3.2 (client:user_message, client:user_approve, subscribe, etc.).
3. `connection/executor.ts`: handlers for `executor:announce`, translating incoming `tool:call` ACKs into `tool_result` events fed back into the host loop.
4. `connection/router.ts`: `sessionId → Room`. Executor announces which session it serves; Dashboard subscribes by sessionId.

Auth: for Phase 2, accept any handshake with a `token` field. Real auth is a Phase 2.5 concern.

**Verify**: contract tests using `socket.io-client` to spin up a fake dashboard + fake executor, drive a turn through the wire.

**Step 5: CLI entry**

`bin/agent-kernel-host.ts`:
- Reads env: `ANTHROPIC_API_KEY`, `PORT` (default 3000), `SESSIONS_DIR` (default `~/.agent-kernel/sessions/`).
- Instantiates `startHostServer(port, { llm, ... })`.
- Logs to stderr; nothing to stdout except structured lifecycle events.

**Acceptance criteria met when**:
- All checkboxes in `docs/ROADMAP.md` §Phase 2 are ✅.
- `pnpm --filter @agent-kernel/host test` shows ≥80% coverage.
- You can run `node packages/host/bin/agent-kernel-host.js` locally and connect from a socket.io-client REPL to send a `client:user_message`, receive `state:changed`, and see the JSONL log grow on disk.

---

## 4. Phase 3 — Executor

**Goal**: implement the original 7 core tools in `docs/tools.md` as a Node daemon that dials into Host. The current codebase also includes the Batch A tool additions documented in `docs/tools.md` §9.

### 4.1 Directory layout

```
packages/executor/
├── package.json               # deps: socket.io-client, ajv, execa
├── src/
│   ├── index.ts               # startExecutor({ host, session, workspace })
│   ├── client.ts              # Socket.IO client + reconnection
│   ├── sandbox.ts             # workspace whitelist enforcement
│   ├── tools/
│   │   ├── index.ts           # registry + schema validation
│   │   ├── read.ts
│   │   ├── ls.ts
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   ├── write.ts
│   │   ├── edit.ts
│   │   └── bash.ts
│   └── config.ts
├── bin/
│   └── agent-kernel-executor.ts
└── src/**.test.ts
```

### 4.2 Build order

**Step 1: Sandbox**

`sandbox.ts` exports `resolveWithinWorkspace(input: string, workspace: string): string` that:
- Normalizes the input path (resolves `..`, `.`).
- If absolute and inside workspace, returns absolute path.
- If relative, joins with workspace.
- Follows symlinks and rechecks (protects against symlink escape).
- If final resolved path is outside workspace, throws `EACCES: outside workspace`.

Unit tests: cover the cases in `docs/testing.md` §4.3.

**Step 2: One tool at a time**

For each tool in `docs/tools.md`:
1. Implement the handler as a pure async function taking validated input, returning `{ ok, content }`.
2. Write JSON schema for input; register in `tools/index.ts`.
3. Write tests per `docs/testing.md` §4 (happy path, missing file, permission denied, invalid schema, idempotency for write/edit, tool-specific edge cases).

Suggested order: `read` → `ls` → `glob` → `grep` → `write` → `edit` → `bash`. `bash` last because it's the trickiest (see `docs/testing.md` §4.2).

**Step 3: Client**

`client.ts`:
- Connects to Host's `/executor` namespace via `socket.io-client`.
- On connect: emits `executor:announce` with the tool list.
- Handles `tool:call` events, dispatches to the appropriate handler with schema validation, ACKs with the result.
- Reconnection: use socket.io-client's built-in reconnection; on reconnect, re-announce.

**Step 4: CLI**

`bin/agent-kernel-executor.ts`:
- Args: `--host=ws://localhost:3000`, `--session=abc`, `--workspace=/path/to/repo`.
- Announces on start; keeps running until killed.

**Acceptance criteria met when**:
- All original 7 core tools pass their unit tests; current code also tests `todowrite` and background shell behavior.
- End-to-end: `curl` or a script that acts as a dashboard drives `client:user_message: "read /tmp/x.txt"` → Host → LLM → tool_call → Executor → tool_result → LLM → final answer. All logged to JSONL.

---

## 5. Phase 4 — Dashboard

**Goal**: React SPA that renders live session state.

### 5.1 Stack decisions (already made, do not re-litigate)

- **React 18** + **Vite** (not Next.js — SPA is enough)
- **Tailwind CSS** for styling
- **shadcn/ui** for base components (Button, Input, Dialog, etc.)
- **@tanstack/react-router** for routing (or **wouter** if you want tiny)
- **socket.io-client** for wire
- **Vitest** + **@testing-library/react** for component tests
- **Playwright** for e2e

### 5.2 Directory layout

```
packages/dashboard/
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── client/
│   │   ├── socket.ts           # SocketProvider + useSocket hook
│   │   └── session.ts          # useSession(id) → { state, config, events }
│   ├── features/
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageInput.tsx
│   │   │   └── ApprovalCard.tsx
│   │   └── inspector/
│   │       ├── InspectorPanel.tsx
│   │       ├── StateTree.tsx
│   │       ├── Timeline.tsx
│   │       ├── EffectsPanel.tsx
│   │       └── UsagePanel.tsx
│   ├── routes/
│   │   ├── index.tsx           # session list
│   │   └── session.$id.tsx     # session detail
│   └── components/ui/          # shadcn/ui components
└── e2e/
    └── golden-path.spec.ts
```

### 5.3 Build order

1. **Client hooks first**: implement `useSocket` and `useSession(id)`. These wrap Socket.IO and expose reactive state (`state`, `config`, `events`, `usage`).
2. **Session route with just the state tree**: prove the wire works end-to-end. Connect, subscribe, render `state.status` and `state.cursor`.
3. **Chat panel**: message list + input. Send `client:user_message`, watch `state.messages` grow.
4. **Approval flow**: render `ApprovalCard` when `pendingCalls` is non-empty and config requires approval. Wire `client:user_approve` / `client:user_reject`.
5. **Inspector**: state tree (use `react-json-view` or hand-rolled), event timeline, effects list, usage panel.
6. **Diff view** for `write` / `edit` approvals: use `diff2html` or `react-diff-viewer`.
7. **Session list route**: fetch from a new Host HTTP endpoint (`GET /sessions`) or via a special Socket.IO event `client:list_sessions`. Add this endpoint to Host in this phase.

**Acceptance criteria**: see `docs/ROADMAP.md` §Phase 4.

---

## 6. Phase 5 — Replay & Fork

**Goal**: the differentiating feature. Timeline scrubber + fork button.

### 6.1 What to build

1. **Timeline scrubber** in `InspectorPanel`: slider from 0 to `events.length`. Dragging updates a `viewCursor` local state; the state tree renders `fold(header.initialState, events.slice(0, viewCursor), config)`.
2. **Fork button** on each event: opens a modal ("Fork from event N?"). On confirm, emits `client:fork { sessionId, cursor }`.
3. **Host handler for `client:fork`**:
   - Reads the parent session's JSONL up to `cursor`.
   - Folds to get the state at that cursor.
   - Creates a new session with a header entry containing `parentSessionId`, `parentCursor`, and the folded state as `initialState`.
   - The new session starts with no user input; waits for the dashboard to send one.
4. **Session list**: show fork lineage (indent forks under their parents).

### 6.2 Snapshotting (optional performance work)

If replay of long sessions gets slow, add snapshot writing: every N events, append a `snapshot` entry with the current state. Load algorithm becomes: find the last snapshot, fold from there.

Reference: `docs/protocol/event-log.md` §3.3 + §4.

**Acceptance criteria**: see `docs/ROADMAP.md` §Phase 5. Key test: the child session must survive parent deletion.

---

## 7. Phase 6 — Browser Executor

**Goal**: full working session in a browser tab, no local install.

### 7.1 What to build

1. **New package** `packages/executor-webcontainer/` (or a `packages/dashboard/src/webcontainer-executor/` module — pick one, be consistent).
2. Depends on `@webcontainer/api`. Boot a WebContainer instance on demand.
3. Implement the same original 7 core tools against WebContainer's `fs` API. `bash` maps to `webcontainer.spawn('bash', args)`; Batch A additions can follow after parity.
4. Instead of dialing into Host over Socket.IO, this executor lives in the same tab as the dashboard. Wire it via a shared in-memory `ExecutorChannel` on the client side — the dashboard sends `tool:call` to this local channel, which returns `tool:result` locally without a network hop.
5. **Session creation UI**: radio button "Local daemon" vs. "Browser (WebContainer)".

### 7.2 Gotchas

- WebContainer requires COOP/COEP headers on the dashboard's hosting. Configure Vite / your host.
- WebContainer has a free tier — check licensing before demo.
- Some tools behave differently in WebContainer (e.g., glob patterns, symlinks). Add per-executor conditional tests.

**Acceptance criteria**: see `docs/ROADMAP.md` §Phase 6.

---

## 8. Common pitfalls (do not step in these)

**"I'll just add a bit of orchestration to the kernel."** No. See [ADR 0005](adr/0005-kernel-boundary.md). If your feature feels like it needs kernel changes, revisit the design — 95% of the time it goes in host or executor.

**"Let me pass `tools` as part of `AgentState`."** No. See [ADR 0004](adr/0004-config-state-separation.md). Tools are in `AgentConfig`, threaded as the third arg to `step`.

**"I'll add a relay process for scaling."** No, not for v1. See [ADR 0006](adr/0006-no-relay-process.md).

**"I'll pick a different transport than Socket.IO."** No. See [ADR 0003](adr/0003-socket-io.md).

**"Tests can share a temp dir."** No. See `docs/testing.md` §7.3. Each test file is hermetic.

**"I'll mock the kernel in Host tests."** No. Kernel is a pure function with no IO. Import it, call it. Mocks are for LLM and executor.

**"I'll add retry logic in the kernel."** No. Retry is IO policy, lives in host. Kernel is pure.

**"I'll skip writing the JSONL log for now."** No — replay/fork depends on it, and it's cheap. Write it from day one.

**"Let me add a `TodoWrite` tool to the kernel's tool list."** No. Planning lives outside. See [ADR 0005](adr/0005-kernel-boundary.md).

**"I'll centralize approval logic in the kernel."** No. Kernel just yields `call_tool` effects. Host decides whether to prompt for approval before dispatch.

---

## 9. How to verify a phase is done

For each phase, run this checklist:

1. `pnpm -r typecheck` — clean, no `any` leaks.
2. `pnpm -r test` — all suites pass, coverage meets the target in `docs/testing.md`.
3. `pnpm -r build` — every package emits `dist/` with `.d.ts` files.
4. `pnpm -r lint` (once ESLint is set up) — no warnings.
5. Manual smoke test per `docs/ROADMAP.md` phase acceptance section.
6. Update `docs/ROADMAP.md`: flip status marker (⚪ → 🟡 → 🟢). Commit the doc update in the same PR.
7. If any protocol change: update the corresponding doc in `docs/protocol/` in the same PR.

---

## 10. When to ask vs. when to decide

**Decide yourself** — implementation details covered by the specs:
- Which npm packages to use for HTTP, JSON validation, testing, etc. (pick the standard ones)
- File organization within a package (as long as public exports match spec)
- Internal error class hierarchies (as long as event payloads match spec)
- Code style (Prettier config already lives at repo root)

**Ask the project owner** — anything that widens or narrows the spec:
- Adding a new tool beyond the 7 in `docs/tools.md`
- Adding a new wire event beyond `docs/protocol/wire-protocol.md`
- Changing the JSONL entry format
- Adding a runtime dep to the kernel package
- Adding a new phase, or reordering the existing ones
- Changing the deployment shape (e.g., splitting Host into microservices)

If in doubt, ask. The specs were written carefully; deviating usually costs more than it saves.

---

## 11. Style guide

- **TypeScript strict mode** everywhere. No `any`. Explicit return types on exported functions.
- **ESM only** (`"type": "module"` in every package).
- **Prefer readonly** for arguments; internal mutation is fine but yields should be readonly.
- **No default exports** — named only. Easier to grep.
- **No `enum`** — use `as const` string unions.
- **Comments**: only when the *why* is non-obvious. See CLAUDE.md if it exists.
- **Naming**: PascalCase types, camelCase functions/vars, kebab-case files.

---

## 12. When you're stuck

1. Re-read the relevant spec section. 80% of "stuck" moments dissolve.
2. Search the reference projects (`../references/pi`, `.../opencode`, `.../codex`) for how they handle the same problem. Do not copy — read for shape.
3. Read the closest ADR. If your instinct disagrees with the ADR, the ADR wrote down why the alternative was rejected.
4. Ask the project owner with a concrete question and a proposed answer. "I want to do X because Y; the spec says Z; which wins?" is a much faster question than "I'm stuck."

Good luck. The specs are meant to make this a walk. If you find them unclear, that's a spec bug — file it.

---

## 13. Implementation Update (2026-07-05)

This guide is older than the current implementation. When continuing work, treat the code plus `docs/HANDOFF-2026-07-05.md` as current for Batch A. Key deltas:

- Kernel tests are now 43; host tests 64; executor tests 60.
- Host loop supports compaction, streaming deltas, stream cancellation, approval modes, cwd routing, and host-side `agent` tool orchestration.
- Executor implements more than the original seven tools: `todowrite`, `bash_output`, `kill_shell`, and background mode for `bash`.
- MCP is deliberately only a stub.
- Dashboard Composer exposes manual compaction through the exact `/compact` slash command, which emits `client:compact` and is not appended as a user message.
- Dashboard Explorer is the top-level left rail. The workbench toolbar shows session title plus current cwd, opens a cwd edit dialog backed by `client:set_cwd`, and keeps theme/inspector controls scoped to the workbench.
- Dashboard is served by Host from `packages/dashboard/dist`; after `.tsx` edits run `pnpm --filter @agent-kernel/dashboard build` and verify through the real Host page.
- Use `@uiw/react-json-view` through `components/ui/json-block.tsx` for JSON rendering.

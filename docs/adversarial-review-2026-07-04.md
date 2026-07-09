# Adversarial Review — 2026-07-04

**Reviewer**: author-review pass focused on the kernel FSM, host loop, executor tool runners, and JSONL persistence.
**Baseline**: 86 tests passing (23 kernel + 15 host + 41 executor + 7 dashboard). `pnpm -r typecheck` clean.
**Post-fix (round 1)**: 115 tests passing (25 kernel + 37 host + 46 executor + 7 dashboard). `pnpm -r typecheck` clean. `pnpm -r build` clean.
**Post-review (round 2)**: 120 tests passing (25 kernel + 42 host + 46 executor + 7 dashboard). `pnpm -r typecheck` clean. `pnpm -r build` clean. Round 2 details in §"Round 2 — reviewer callouts" below.
**Post-review (round 3)**: 121 tests passing (25 kernel + 43 host + 46 executor + 7 dashboard). `pnpm -r typecheck` clean. `pnpm -r build` clean. Round 3 details in §"Round 3 — protocol doc drift" below.

The kernel FSM, protocol schemas, and per-tool contract tests are solid. The bugs below are all in the **host driver / executor runner / persistence layer** — i.e. the impure edges — plus a handful of latent kernel invariant leaks that only bite once state transitions are pushed off the golden path.

Each bug is filed as `B<n>`, with a concrete failure mode, a root cause, and a regression test (added to the corresponding `*.test.ts` file). The fixes land in the same PR.

---

## B1 — Kernel: `llm_error` leaks `pendingCalls`

**User-visible failure**: after an LLM 5xx during a tool-call round-trip, the kernel enters `status: 'error'` but the `pendingCalls` array still lists the in-flight tool. A dashboard rendering the state sees a "waiting to dispatch" tool with no path forward and no way to reason about the FSM. Invariant I5 (`status='error' → pendingCalls.length===0`) is violated.

**Root cause**: `onLlmError` in `packages/kernel/src/core.ts` only sets `status: 'error'` and `error`. It doesn't drop pending.

**Fix**: clear `pendingCalls` in `onLlmError`. Symmetrical with `onCancel`.

**Regression test**: `packages/kernel/src/core.test.ts` — assert `pendingCalls === []` after `llm_error` from a state that had pending calls staged.

## B2 — Kernel: `user_message` re-entry from `done` doesn't wipe residual state

**User-visible failure**: a second turn on a done session inherits any leftover `pendingCalls` or `error` from the previous turn. Under the current spec, `done` should already have `pendingCalls === []`, but B1 exposes a code path where it isn't. Defense in depth: re-entering `thinking` should always wipe the pending slate.

**Root cause**: `onUserMessage` spreads `...state` and only overrides `status` and `error`.

**Fix**: also reset `pendingCalls: []` on re-entry.

**Regression test**: seed a `done` state with a leftover pending call (simulating B1), fire `user_message`, assert `pendingCalls === []` in next state.

## B3 — OpenAI adapter: NaN usage poisons kernel `usage` totals

**User-visible failure**: some OpenAI-compatible gateways return `usage: {}` (empty object) or omit `prompt_tokens`/`completion_tokens`. The current adapter forwards `undefined`, kernel does `state.usage.inputTokens + undefined` → NaN. Every subsequent turn's `usage.*Tokens` renders as `NaN` in the dashboard; the cost tracker is bricked for the session.

**Root cause**: `parseResponse` in `packages/host/src/llm/openai.ts` does `body.usage.prompt_tokens` without a numeric guard.

**Fix**: coerce with a `numOr(v, 0)` helper. Do the same for Anthropic (`input_tokens` / `output_tokens`) since a proxy could omit them too.

**Regression test**: `openai.test.ts` — mock a response with `usage: {}` and assert the adapter returns `usage: { inputTokens: 0, outputTokens: 0 }` — never NaN, never undefined-under-a-number-field.

## B4 — `bash` tool hangs forever if spawn fails (missing bash, unreachable cwd)

**User-visible failure**: on a system where `bash` is not on `PATH`, or where `spawn` fails with `ENOENT`/`EACCES` after we've already registered our promise, `child.on('close')` never fires. The tool call sits pending until the host-side 60s tool timeout — but only if the host has a timeout wrapper. In tests (no timeout wrapper) it deadlocks forever.

**Root cause**: `packages/executor/src/tools/bash.ts` only listens for `close`. `error` events (thrown by the child process wrapper for spawn failure) are dropped on the floor.

**Fix**: register `child.on('error', ...)` that resolves the promise with an `EIO: bash spawn failed: <msg>` payload (formatted so the LLM can pattern-match, matching the `--- exit code` shape). Also check `ctx.signal.aborted` before spawn and short-circuit with a status marker if cancellation raced spawn.

**Regression test**: run bashTool with `command: 'echo x'` against an already-aborted `AbortSignal` — must not hang; must return within 100ms with a cancellation marker instead of stdout.

## B5 — `write`/`edit` ignore `AbortSignal`

**User-visible failure**: user hits "cancel" mid-execution of a large write; the file gets written anyway because the tool never checks the signal. Cancellation is a lie.

**Root cause**: tools/`write.ts` and `edit.ts` don't consult `ctx.signal`.

**Fix**: short-circuit at the top of each `run()` with `if (ctx.signal.aborted) throw new ToolError('EABORT', 'cancelled')`. Full node fs.writeFile signal support requires plumbing through `AbortController`; we do the simpler pre-check because cancellation of an in-flight `writeFile` on a small file is not useful.

**Regression test**: cancel signal before calling `writeTool.run`; assert throws `EABORT` and file was never written.

## B6 — JSONL log unrecoverable if final line is truncated

**User-visible failure**: host crashes mid-append (SIGKILL / OOM). The last line of the JSONL file is a partial JSON blob. On restart, `readSessionLog` throws `Malformed JSON at line N`, and the entire session is unloadable — every user message before the crash is dark.

The `readSessionLog` implementation even has a comment referencing this exact case ("A crash mid-write may leave the final line partial ... future improvements") but never actually does the recovery.

**Root cause**: `packages/host/src/store/log.ts` treats any parse error as fatal.

**Fix**: on parse failure, if we're on the very last line AND we've already successfully parsed the header, log a warning to stderr and skip. Any earlier corruption is still fatal (that would indicate deeper damage). This mirrors what append-only logs (Kafka, sqlite WAL, RocksDB) do.

**Regression test**: write a valid log, append a truncated JSON blob (no newline, no closing brace), call `readSessionLog`, assert it parses cleanly and returns the events before the truncation.

## B7 — Executor reconnect drops in-flight tool calls

**User-visible failure**: executor briefly disconnects (network blip) and reconnects a few hundred ms later. Any tool call that was outstanding is answered with `content: 'executor superseded by new connection'`. The LLM's next turn sees a fake "tool failed" and either retries or gives up. From the user's perspective, "the tool didn't run for no reason".

**Root cause**: `packages/host/src/connection/executor.ts` `attach()` calls `synthesizeFailure(existing, 'executor superseded by new connection')` unconditionally when a new executor connects to a session that already had one. The pending map is wiped.

**Fix**: when superseding, **keep** the pending map, transfer it to the new bind, and re-emit `tool:call` for each outstanding entry to the new socket. Only synthesize failure when the executor truly disappears (disconnect without a replacement within the tool timeout window — the existing detach path).

**Regression test**: in `client.test.ts` add a scenario:
1. Start a session where the LLM emits a tool call
2. On the first `tool:call` message, the executor deliberately drops the socket without acking
3. A new executor connects and re-answers via the redispatched `tool:call`
4. Assert the LLM saw the real result, not "superseded".

## B8 — Concurrent session-create race between dashboard/executor

**User-visible failure**: user opens the dashboard and starts the executor in parallel with a fresh (never-seen) sessionId. Both namespaces race into their `connection` handler, both call `store.load()` (which throws — no log yet), and both fall back to `store.create()`. The second create clobbers the first: two log files (different timestamps) exist on disk, only the last in-memory record wins, and any events written to the first file are orphaned.

**Root cause**: `packages/host/src/server.ts` handles the "session doesn't exist yet" case with a naive `try { load } catch { create }` per socket. There's no per-session lock.

**Fix**: hoist the create-if-missing logic into `SessionStore.ensure({ sessionId, config })`, which uses a `Map<sessionId, Promise<SessionRecord>>` to coalesce concurrent creates. Both callers await the same promise, both get the same record, only one file lands on disk.

**Regression test**: kick off two concurrent `ensure()` calls for the same sessionId; assert they resolve to the identical `SessionRecord` object and exactly one log file exists on disk.

---

## Not fixed here (deliberately)

- **A14: sticky `error` UX**: dashboard silently accepts `user_message` while the kernel is in `error` (no-op). Better UX would show "session errored, start a new one". Deferred: needs UX design, not a bug per spec.
- **A20: `tool_choice: auto` + tool-result-last on some gateways**: real interop issue but requires a per-gateway feature flag. Out of scope for this pass.
- **Executor `session:ready` handler firing on every reconnect**: fixed indirectly by B7 (redispatch instead of drop). No separate change needed to executor client for now; the client already re-announces after every ready which the host now handles gracefully.

# Round 2 — reviewer callouts

Round 2 addresses two reviewer callouts against round 1:

- **R1 — `client:cancel` never reached the executor.** The kernel dropped `pendingCalls` and marked the session `done`, but `ExecutorRegistry.cancelPending()` was never invoked from the loop, so the executor kept chewing on the interrupted tool call. This directly violated SPEC.md §Non-goals ("Host cancels IO") and wire-protocol.md §5.2. Fixed in `packages/host/src/loop.ts` by invoking `deps.tools.cancelPending(sessionId)` whenever the dispatched event is `{ kind: 'cancel' }`. The branch runs before effect fan-out so a stray `call_tool` effect can't race a still-live executor. Two loop-level unit tests plus a socket-level integration test in `server.test.ts` prove the wire path: dashboard `client:cancel` → loop cancel event → `cancelPending` → executor receives `tool:cancel` with the original callId.
- **R2 — B8 fix over-corrected and let executors create sessions.** Hoisting `ensure()` into both namespaces meant an executor connecting first to a fresh sessionId would create the session on disk, contradicting wire-protocol §2 ("dashboard-only for v1"). Reverted the executor namespace in `packages/host/src/server.ts` back to `get()/load()`-or-reject, emitting `session:error{scope='host', message='unknown_session'}` and disconnecting. Dashboard namespace still uses `ensure()`. Two `server.test.ts` cases cover the negative branch (executor for ghost session → disconnect) and the positive branch (executor for dashboard-created session → attaches cleanly).

| Layer | Baseline | Round 1 | Round 2 | Δ round 2 | Round 2 changes |
|---|---|---|---|---|---|
| Kernel | 23 | 25 | 25 | 0 | — |
| Host | 15 | 37 | 42 | +5 | `loop.ts` (R1: cancel branch), `server.ts` (R2: executor load-or-reject); new tests in `loop.test.ts` and `server.test.ts` |
| Executor | 41 | 46 | 46 | 0 | — |
| Dashboard | 7 | 7 | 7 | 0 | — |
| **Total** | **86** | **115** | **120** | **+5** | |

Every bug B1–B8 and both reviewer callouts R1/R2 have a regression test that fails against the pre-fix code and passes post-fix. Full suite runs in under 4 seconds end-to-end.

# Round 3 — protocol doc drift

The round-2 reviewer noted (without blocking on it) that `packages/shared/src/protocol.ts` declared `SessionErrorScope` as `'kernel' | 'llm' | 'executor' | 'host'` while `docs/protocol/wire-protocol.md` §3.4 still listed `'kernel' | 'llm' | 'executor' | 'core'`. The `'core'` value is a leftover from before ADR 0011 (`packages/core` → `packages/host`), never actually emitted by any runtime call site (`grep 'scope:' packages/*/src` finds only `'llm'`, `'kernel'`, `'host'`), and would silently mislead any third-party protocol implementer reading the spec.

**Fix**:

- Reified `SessionErrorScope` as a runtime const tuple `SESSION_ERROR_SCOPES = ['kernel', 'llm', 'executor', 'host'] as const` in `packages/shared/src/protocol.ts`, with the type derived from the tuple. Zero behavior change; the type is identical.
- Updated `docs/protocol/wire-protocol.md` §3.4 to match (`'core'` → `'host'`) and added per-value documentation explaining when each scope is emitted, keyed to the actual call sites in `packages/host/src/server.ts` (session lookup errors, dispatch failures, LLM adapter errors, executor registry errors).
- Added a doc-drift regression test in `packages/host/src/server.test.ts` — `describe('protocol doc drift')` reads `wire-protocol.md`, extracts the `scope` union with a regex, and asserts it equals `SESSION_ERROR_SCOPES`. Future edits to either side will trip CI, not a reviewer's side-by-side scan.

| Layer | Round 2 | Round 3 | Δ round 3 | Round 3 changes |
|---|---|---|---|---|
| Kernel | 25 | 25 | 0 | — |
| Host | 42 | 43 | +1 | new doc-drift regression test in `server.test.ts` |
| Executor | 46 | 46 | 0 | — |
| Dashboard | 7 | 7 | 0 | — |
| **Total** | **120** | **121** | **+1** | |

Files changed round 3: `packages/shared/src/protocol.ts` (reify enum as const), `docs/protocol/wire-protocol.md` (fix `'core'` → `'host'`, expand per-value docs), `packages/host/src/server.test.ts` (doc-drift regression).

---

## Round 4 — running-system verification

Rounds 1–3 established the code is correct in the small (typecheck + 121 unit tests + build). Round 4 verifies it in the large: an actual browser talking to a running host + executor over Socket.IO, all the way through an approval-gated tool call round-trip. This is the check that unit tests with mocked sockets cannot make (see the "verify frontend with real browser" convention).

**Setup**: `host` on `:3055` with `LLM_PROVIDER=openai` pointed at a real OpenAI-compatible gateway, `executor` bound to `/tmp/agent-kernel-e2e-workspace` announcing to session `demo`, `dashboard` dev server on `:5173`. Real browser: `google-chrome --headless=new --remote-debugging-port=9333` at `http://127.0.0.1:5173/?host=http://127.0.0.1:3055&sessionId=demo`. Every observation below is read out of the live DOM via CDP `Runtime.evaluate`, not out of vitest fixtures.

**Turn 1 — pre-existing (from a prior session left running on hot-reloaded code):**

- User message: `translated historical texttranslated historical texttranslated historical textpwdtranslated historical texttranslated historical texttranslated historical text`
- Kernel path: `user_message` → `call_llm` → `llm_response` (bash tool call auto-approved via config) → `call_tool` → `tool_result` → `call_llm` → `llm_response` → `finish`
- Final DOM state: `STATUS: done, CURSOR: 5, PENDING: 0, TOKENS: 1335 in / 1064 out`, executor cwd `/tmp/agent-kernel-e2e-workspace` echoed back
- Meaning: full happy path (LLM + executor + kernel + broadcast) works against a real LLM and real filesystem.

**Turn 2 — approval-gated round-trip (this round):**

- User message (typed into the composer via CDP, then Enter): `translated historical text echo translated historical texttranslated historical text kernel-verify-ok translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text`
- Observed status progression: `thinking` (~4s LLM latency) → `awaiting_approval` (approval card visible in the DOM with the full `{command: "echo kernel-verify-ok"}` payload)
- User action: CDP-clicked the `approve` button in ApprovalsPanel
- Observed status progression: `thinking` → `done` within 1s (bash `echo` completed in `duration: 0ms`)
- Final DOM state: `STATUS: done, CURSOR: 10, PENDING: 0, TOKENS: 2981 in / 1989 out`. Bash stdout `kernel-verify-ok` present in the DOM twice (once in the tool_result card, once in the assistant's follow-up message).
- Timeline cursor 6→10 shows every kernel transition inline: `user_message/call_llm` · `llm_response/request_approval` · `user_approve/call_tool` · `tool_result/call_llm` · `llm_response/finish`.
- Meaning: the approval branch (B1's neighbour — `awaiting_approval` → `user_approve` → `executing_tools` → `tool_result` → `thinking` → `done`) works end-to-end in a real browser. Token totals accumulate correctly across turns.

**One remaining UI blemish (not a kernel/host regression)**: after `user_approve`, the ApprovalsPanel still shows the approved card ("APPROVAL REQUIRED bash …") alongside the arrived tool_result. The kernel's `pendingCalls` is correctly `[]` (STATUS: done, PENDING: 0 in the state tree) — the dashboard's local approvals state is out of sync with server state after a successful approval. This is a dashboard-layer bug, not a kernel/host bug, and falls into the same class of "the dashboard is thin" observations that motivated [ADR 0012](adr/0012-dashboard-ui-redesign.md). Not fixed here; deferred to the redesign.

**Nothing found requiring revise.** No kernel state leaks, no unhandled effect kinds, no protocol drift, no crash paths, no console errors in the browser during the two-turn run. Rounds 1–3 held up under a live test.

| Verification layer | Status |
|---|---|
| `pnpm -r typecheck` | ✅ clean |
| `pnpm -r test` (121 tests) | ✅ 121 passing |
| `pnpm -r build` (all packages including dashboard `dist/`) | ✅ clean; dashboard bundle 194 KB / 62 KB gzipped |
| Real-browser session (Turn 1: auto-approved tool call) | ✅ done at cursor 5 |
| Real-browser session (Turn 2: approval-gated tool call) | ✅ done at cursor 10, approve click observed by kernel |

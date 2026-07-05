# Feature-Gap Analysis: agent-kernel vs Reference Coding Agents

_Written 2026-07-05. Sources: local checkouts under `references/` — codex, opencode, claude-code-collection, pi._

## TL;DR

agent-kernel has ~24 real feature gaps vs mature coding agents, grouped
below. The 12 "core capability" categories (compaction, slash commands,
sub-agents, memory, session resume, approval modes, MCP, diff/edit,
todos, cost, multi-model, streaming) cover the big architectural axes.
On top of those there's another ~12 quality-of-life features
(command history, `@file` refs, image paste, persistent bash, web
tools, hooks, diff preview, cancel-in-flight, etc.) that individually
are small but collectively are a lot of why the reference agents feel
"done".

Rough priority for closing the gap — top of the list is highest value
per hour, not most important overall:

1. `/cost` footer (data already exists, ~1h)
2. Command history in composer (~2h)
3. Cancel-in-flight streaming (~2h)
4. Slash-command layer (~half day)
5. `/compact` context compaction (~1 day)
6. Streaming token rendering (~1 day)
7. `@file` reference in composer (~1 day)
8. Persistent bash shell in executor (~half day)
9. Diff preview in approval cards (~half day)
10. Crash-recovery for stuck `awaiting_tool` sessions
11. MCP support in executor
12. Image content type
13. Web tools (`webfetch`, `websearch`)
14. Permission modes
15. Hooks system
16. Persistent memory / CLAUDE.md-style
17+ Sub-agent, provider fallback, settings UI, session export

---

## Per-feature comparison

### 1. Context compaction / summarization

**agent-kernel:** No compaction. Kernel tracks token usage in `state.usage`
but does not gate on context-window size. When the model runs out, requests
just fail.

- **claude-code-collection**: `maybe_compact(state, config)` runs before each
  streaming call, checks against context window, calls a compaction model.
- **pi**: Auto-compaction at a token threshold plus manual hook via extensions.
  Stores a `CompactionEntry` in the JSONL with summary + token delta so replay
  is exact.
- **codex**: Auto-compaction in the Rust core (`AutoCompactTokenLimitScope`
  in the protocol schema); CLI is a thin wrapper.
- **opencode**: Emits a `session.compacted` event so extensions can implement
  the reduction strategy of their choice.

**How `/compact` would work in agent-kernel:**

- Kernel emits a new `CompactionSuggested` observation event when
  `state.usage.inputTokens > config.contextLimit * 0.8`.
- New host tool `compact` invokes the LLM with a fixed summarizer prompt over
  the current message list, replaces `state.messages` with a single
  `system-summary` message, resets `usage`.
- Slash command `/compact` in the composer emits an executor-side action
  (`client:compact { sessionId }`) that runs the same reducer step.
- The event log records `{ kind: 'compacted', summary, replacedMessages: N,
  tokensBefore, tokensAfter }` so replay/fork is deterministic.
- Optionally auto-fire when the observation event lands, guarded by a
  config toggle. Manual first, auto second.

### 2. Slash commands

**agent-kernel:** None. Kernel is pure; host has no REPL layer. Composer is
just a textarea.

- **claude-code-collection**: 25+ commands (`/help`, `/clear`, `/model`,
  `/save`, `/load`, `/history`, `/context`, `/cost`, `/permissions`, `/memory`,
  `/skills`, `/agents`, `/mcp`, `/plugin`, `/tasks`, `/compact`).
- **pi**, **opencode**, **codex**: mostly external to core; TUI/CLI feature.

**What we need:** Composer parses leading `/`, resolves to an action either
handled in-process (`/clear` clears local state, `/model` opens the picker
already in the composer) or as a wire event (`/compact`, `/fork`, `/help`).

### 3. Sub-agent spawning

**agent-kernel:** Not supported. Kernel has no recursion mechanism.

- **claude-code-collection**: `Agent` tool spawns subagents with tracked
  nesting depth.
- Refs: mostly implemented as a special tool, not a kernel primitive.

Deferable — implement as a tool that opens a nested session bound to the
same workspace, returns its final assistant message as tool output.

### 4. Persistent memory / project memory

**agent-kernel:** None.

- **claude-code-collection**: `/memory` + `/memory consolidate`, stored in
  `~/.clawspring/memory/` and per-project.
- **codex**: Rust core has a memories module.

Fits naturally on the host: `~/.agent-kernel/memory/<workspaceId>/*.md`,
loaded as system message prefix. No kernel change required.

### 5. Session resume / branch / fork

**agent-kernel:** Fork already works (dashboard "fork from cursor" +
`session:forked` protocol event). Resume works implicitly (page reload
replays the JSONL via `server:history`). What's missing: a **UI to list
past sessions**, which the Explorer already does per-workspace, and
resume-from-crash — currently a session that dies mid-tool-call has a
pending call frozen forever.

- **pi**: `SessionManager.forkFrom(sourcePath, cwd)` with `parentId`
  tracking on every JSONL entry. We already match this shape via the
  fork protocol event.
- **codex**: `~/.codex/sessions/`, resume via `threadId`.

Gap to close: on host restart, scan sessions with `state === 'awaiting_tool'`
and either mark the pending calls failed or re-emit them. Currently the
`awaiting_tool` state persists across restart but the pending call
promise is lost.

### 6. Approval / permission modes

**agent-kernel:** Kernel marks tools with `requiresApproval`. Host gates on
that flag. There is no per-user "auto-approve safe ops" mode — every
approval-requiring call goes through the dashboard `approval:required` event.

- **claude-code-collection**: `auto` / `manual` / `accept-all` modes.
- **codex**: `--config approval_policy=auto|ask|always_deny`.
- **opencode**: Layered permission system with glob rules per tool.

Small gap. A per-session "approvals mode" enum passed through
`agent_config` would slot in cleanly.

### 7. MCP (Model Context Protocol)

**agent-kernel:** Not supported. Tool set is fixed by the executor at build
time.

- **opencode**: MCP context module, hot-reload.
- **claude-code-collection**: `/mcp` commands, stdio-based servers.

Executor-side task: accept `mcp_servers` in the config, spawn stdio
processes, add their advertised tools to the announce message.

### 8. Diff / edit tool

**agent-kernel:** `edit` tool uses exact string replacement, fails on
ambiguity unless `replace_all`. `write` tool overwrites. `read` returns
line-numbered output that matches the edit tool's expectations. This is
the Claude Code / pi pattern. **Not a gap.**

### 9. TODO tracking

**agent-kernel:** `todowrite` builtin + kernel reducer promotes `input.todos`
to `state.todos`. TodoDock in the dashboard renders them. **Not a gap.**

### 10. Cost / token metering

**agent-kernel:** `state.usage` tracks input/output tokens and cost.
Visible in the Inspector JSON view. No budget enforcement, no dedicated
`/cost` command.

Small gap: a `/cost` command or a live footer showing `$0.42 · 12k tokens`
is easy dashboard work. Budget hard-caps would need a kernel guard.

### 11. Multi-model / model routing

**agent-kernel:** Per-session model picker (already implemented) that
picks from host-advertised models. `runtime-config.ts` merges
`~/.claude/settings.json` and `~/.codex/config.toml` plus custom
providers from `~/.config/agent-kernel/config.toml`. Anthropic and OpenAI
adapters are wired.

- **pi**: `Model<T>` type + provider registry duck-types provider from
  model name.
- Refs generally have same shape as us.

**Not a gap** for basic multi-model. Deep routing (e.g., "small model
picks tools, big model writes code") is out of scope.

### 12. Streaming UX

**agent-kernel:** LLM adapters call `.stream()` and the host emits
`event:appended` after each turn is complete. There is no incremental
token stream to the dashboard — the assistant message appears all at
once when the turn finishes.

- **claude-code-collection**: Yields `TextChunk` / `ThinkingChunk` for
  live rendering.
- **pi**: Rendered in-place via TUI component model.
- **opencode**: `scrollback.surface.ts` handles it.

Gap. Would require a `token:delta` protocol event and an incremental
message renderer. Not tiny, but not architecturally awkward — the
event log stays authoritative because deltas are UI-only.

---

## 13. Additional gaps not covered by the 12-feature survey

The 12 categories above are the canonical "coding agent capabilities" axis.
When you actually sit in front of Claude Code / Codex / opencode there is
a second layer of quality-of-life features that we're missing:

- **Command history (↑ key in composer).** Claude Code, codex both have it.
  We don't. Trivial (session-local ring buffer + arrow key handler).
- **Edit / rerun last user message.** Claude Code lets you edit the last
  `user` turn and re-fire from there without a full fork. Cheaper than a
  fork for typo/rephrase.
- **`@file` reference in composer.** Type `@packages/host/src/server.ts` and
  the file's contents are auto-injected into the message. Also a fuzzy
  file-finder popup (cmd+P style).
- **Image / screenshot paste.** Claude Code and codex accept image content
  blocks. Our kernel `MessageContent` union has only `text` / `tool_call` /
  `tool_result`. Would need a new `image` variant and adapter support.
- **Persistent bash session.** Our executor spawns a fresh `bash -c` per
  `bash` tool call, so `cd`, exported env vars, and shell state don't
  persist between calls. Claude Code's bash tool keeps a long-lived shell.
  This bites users doing multi-step shell work.
- **Web tools (`webfetch` / `websearch`).** Claude Code has both built-in.
  Executor tool set right now: `bash`, `read`, `write`, `edit`, `todowrite`.
  No network access from the model without shelling out.
- **Hooks / lifecycle events** (pre-tool-use, post-tool-use, session-start,
  session-end). Claude Code has a whole hook config system. We have
  no equivalent — user can't intercept, log, or block tool calls externally.
- **Settings UI.** All config is `~/.config/agent-kernel/config.toml` +
  `~/.claude/settings.json` + `~/.codex/config.toml` edited by hand. No
  in-app settings page.
- **Manual session rename / label.** We derive the label from
  `firstUserMessage.slice(0, 40)`. No way for the user to rename a
  session for their own filing.
- **Diff preview before write / edit.** When the model calls `edit` or
  `write`, we just apply and show the result. Claude Code shows a real
  diff and (in ask mode) waits for approval. Our approval card just
  shows the raw JSON args.
- **Cancel-in-flight during LLM streaming.** We can cancel a pending
  tool call (`tool:cancel`), but there's no way to interrupt the model
  mid-token-stream. Claude Code has ESC-to-cancel.
- **Cost / rate-limit awareness.** No warning when approaching context
  window; no per-day spend cap. `state.usage` exists but no policy layer.
- **Provider fallback / retry.** If Anthropic errors out, we surface the
  error. Codex retries with exponential backoff and (with multi-provider
  config) falls back to a secondary provider. We do not.
- **Session export / share.** Claude Code can dump a session as
  markdown / JSON for sharing. We have the JSONL on disk but no
  first-class export command.

That's another ~13 items on top of the 12 numbered features — many of
them small individually, collectively they're a lot of what makes the
reference agents feel "finished".

---

## Recommended next work, in order

Grouped by cost/value ratio:

**High leverage, small effort (do first):**
1. **`/cost` and token footer** — data already in `state.usage`, just needs
   dashboard chrome. Under an hour.
2. **Command history (↑ key)** — session-local buffer + Composer keyhandler.
3. **Cancel-in-flight (ESC)** — protocol event exists conceptually, host
   just needs to abort the streaming request. ~2 hours.
4. **Slash-command layer** (`/help`, `/clear`, `/model`, `/compact`, `/cost`)
   in the composer parser. ~half a day.

**High leverage, moderate effort:**
5. **Compaction hook + `/compact`** — see §1 above. Requires new event
   kind + host tool + reducer step. ~1 day.
6. **Streaming tokens** — new `token:delta` protocol event, incremental
   renderer. Kernel/event log unaffected. ~1 day.
7. **`@file` reference in composer** — fuzzy finder + auto-inject. ~1 day.
8. **Persistent bash shell** in executor — spawn one `bash -i` per session
   and pipe commands through it. ~half a day + edge-case testing.
9. **Diff preview in approval card** — when the pending tool is `edit`
   or `write`, render a diff instead of raw JSON. ~half a day.
10. **Resume-from-crash** for `awaiting_tool` sessions on host restart.

**Structural, higher effort:**
11. **MCP in executor** — spawn stdio processes from config, merge their
    advertised tools into announce. ~2 days.
12. **Image content type** — new `MessageContent` variant, propagate through
    kernel/adapters/dashboard. ~1-2 days.
13. **Web tools** (`webfetch`, `websearch`). Straightforward once the
    request/response tool-content shape is clean.
14. **Permission modes** (`auto` / `ask` / `deny` + glob rules per tool).
15. **Hooks system.** Modeled on Claude Code — config-driven pre/post
    tool-use shell commands, session lifecycle events.
16. **Persistent memory / CLAUDE.md** — read `AGENT-KERNEL.md` from cwd +
    `~/.agent-kernel/memory/*.md` as system prompt prefix.

**Deferrable:**
17. Sub-agent tool. Rare use case, big surface area.
18. Provider fallback / retry policy. Nice-to-have.
19. Settings UI. Only matters once config surface grows.
20. Session export. Users can just cat the JSONL for now.

Everything left in the "12 core categories" that isn't listed above
(edit tool, todo tracking, session fork, multi-model config) — we
already match the reference agents.

---

## Status update (2026-07-05)

The following gaps above are now closed or partially closed in code:

- Closed: context compaction core/host path, streaming tokens, cancel-in-flight, crash recovery for pending tool calls, permission modes, image content type, sub-agent tool, session cwd, and background shell polling.
- Stubbed only: MCP config shape and `initMcp()` exist, but no MCP runtime is implemented.
- Still open for Batch B: slash command UX, compact banner, streaming render in dashboard, permission picker UI, message edit/rerun, image paste UI, `@file` picker, hooks, settings UI, session rename, cwd toolbar/metadata modal, diff preview, web tools, memory.

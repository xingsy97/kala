# Feature-Gap Analysis: agent-kernel vs Reference Coding Agents

_Written 2026-07-05. Sources: local checkouts under `references/` — codex, opencode, claude-code-collection, pi._

## TL;DR

agent-kernel is a pure reducer kernel with intentionally narrow scope: FSM state,
tool approval gating, token tracking, todo management. It defers UX, persistence,
and orchestration to the host. Compared with mature refs, the biggest missing
pieces are **context compaction**, **session resume/fork**, and **slash commands**.
Everything else is either already present in some form or is properly a
host/extension concern.

Rough priority for closing the gap:

1. Compaction hook (kernel-observable, host-decided) — **highest impact**
2. Session resume / fork (already 80% there via event log; needs a UI + protocol)
3. Slash-command layer in the dashboard (`/compact`, `/model`, `/clear`, `/help`)
4. MCP tool-server support in the executor
5. Sub-agent spawning (deferred)

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

## Recommended next work, in order

1. **Compaction hook + `/compact` slash command.** Directly addresses the
   user's specific ask. New event kind, new tool, new dashboard command
   parser. ~1 day.
2. **Streaming tokens to the dashboard.** Biggest UX win. Requires a new
   protocol event but no state-machine change. ~1 day.
3. **Slash-command layer** (`/help`, `/clear`, `/cost`, `/model` shortcut).
   Small.
4. **Resume-from-crash** for sessions stuck in `awaiting_tool` on host restart.
5. **MCP support in the executor.** Nice-to-have, decouples us from the
   fixed tool set.

Everything else (sub-agent, memory, per-session approval mode) is
deferrable behind these five.

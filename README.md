# agent-kernel

**Status**: Kernel + Host + Executor + Dashboard + Replay/Fork all shipped end-to-end. See [ROADMAP](docs/ROADMAP.md) for the current feature ledger and [FEATURE-GAPS](docs/FEATURE-GAPS.md) for the comparison vs. reference agents.

---

## Why does this exist?

Existing coding agents fall into one of two camps, and neither gives you a clean substrate to *learn from* or *reason about*:

- **Closed source**  -  Claude Code, Codex CLI ship as binaries. You can read the source-collection dumps some people have published, but there's no supported way to fork, hack, or replay a session.
- **Open source but not built to be read**  -  [opencode](https://github.com/sst/opencode) and [pi](https://github.com/earendil-works/pi) are both MIT-licensed and inspectable, but their agent loops are 3k+ LOC files interleaved with UI, provider quirks, planning, memory, and compaction. To learn from them you first have to *un-mix* the ideas from the product.

1. **Readable.** The core of it all is a pure function in [`packages/kernel/src/core.ts`](packages/kernel/src/core.ts)  -  ~350 lines  -  with types in [`types.ts`](packages/kernel/src/types.ts). If you know Redux, you know this.
2. **Model-agnostic.** The kernel doesn't know if it's talking to Anthropic, OpenAI, or DeepSeek. Provider adapters live outside.
3. **Transparent + replayable.** Every session is an append-only event log. `fold(events, initialState)` reconstructs any historical state. `fork(events, cursor, newEvents)` branches. The dashboard exposes both as first-class UI.

## What makes it structurally different?

**Physical decoupling of agent core and tool executor.**

```
   Dashboard (React SPA, served by Host from dist/)          -  nothing installed, just a URL
         -   Socket.IO
         - 
   Host (headless, public IP)                               -  runs anywhere: cloud, laptop, Lambda
      -  Kernel (pure FSM)
      -  LLM adapters (Anthropic Messages + OpenAI-compat, streaming SSE)
      -  Event log (JSONL, append-only)
      -  Compaction driver (manual `/compact` + auto on hard pressure)
      -  `agent` builtin (host-side sub-agent tool)
      -  Connection layer (Socket.IO server, workspace-routed)
         - 
         -   Socket.IO  (executor dials out  -  no inbound port needed)
         - 
   Executor (Node daemon, per workspace)                    -  runs where the files live
      -  Tools: read / ls / glob / grep / write / edit / bash /
               todowrite / web_search / bash_output / kill_shell
```

- **Kernel is a pure function**, not a class or a process. It's a library. `step(state, event, config)  -  { next, effects }`.
- **Host** owns the LLM, the event log, the compaction driver, and the Socket.IO server. It has the public IP and serves the dashboard bundle from `packages/dashboard/dist/`.
- **Executor** dials *out* to Host  -  no NAT/firewall problem. Each executor represents a **workspace** (a machine with a sandbox root); a session is bound to one workspace at create time.
- **Dashboard** is a React SPA that subscribes to a session and renders chat + inspector + replay UI.

This is not just an architectural cute  -  it means:
- You can run the kernel in the cloud and give it *your* laptop's shell without exposing any inbound port.
- The same kernel binary drives every deployment shape.
- A browser-side executor (e.g. WebContainer) is a straight drop-in: the Socket.IO client and tool contract don't change. Not shipped today  -  see [Non-goals](#non-goals).

## Shipped capabilities

Kernel / Host / Executor:

- Pure-function FSM with dispatch-table `step` ([ADR 0010](docs/adr/0010-fsm-dispatch-table.md))
- JSONL event log with header + snapshots + fork lineage; deterministic `fold` replay; crash-recovery synthetic events on load
- Anthropic Messages API + OpenAI-compat (incl. Codex endpoints) adapters, both streaming SSE
- Provider auto-import from `~/.codex/config.toml` and `~/.claude/settings.json`, merged with `~/.agent-kernel/config.json`
- Approval modes `auto` / `ask` / `deny` / `allow_all` (with `AK_ALLOW_ALL_OK=1` host env-gate for `allow_all`); sub-agents run headless with forced `allow_all` (see [ADR 0014](docs/adr/0014-subagent-approval-mode.md))
- Context pressure levels (`ok` / `soft` / `hard`) with manual `/compact` slash command and auto-compact on hard pressure
- Host-side `agent` builtin: child JSONL session under the same workspace, `maxAgentDepth` recursion guard
- Executor tool set: `read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash` (with `run_in_background`  -  `bash_output` / `kill_shell`), `todowrite`, `web_search` (built-in DuckDuckGo HTML endpoint  -  no paid API key)
- Session cwd stored in state, mutable via `client:set_cwd`  -  `cwd_changed` event; all `call_tool` effects carry cwd
- Image input (base64 or file-ref) supported in kernel + both adapters + Composer paste

Dashboard:

- Finder-style Explorer with workspaces  -  sessions, time-bucket grouping, in-place rename, workspace + session metadata modals
- Chat panel with streaming render, tool cards, approval cards (unified diff for `edit` / `write`), user message edit + fork, image paste + thumbnails, compact boundary marker
- Composer with model picker, context pressure ring, approval mode picker (with `allow_all` confirmation), `/compact` slash command, context pressure banner
- Inspector with state tree, event timeline (including compaction request details), effects, usage
- History scrubber with fork-from-any-event; background terminal panel derived from `bash` / `bash_output` / `kill_shell`
- Settings dialog covering providers (imported + user-added), per-provider model picker, default approval mode, host/port config
- Session creation dialog with workspace + cwd + provider/model selection
- Light / dark themes via Tailwind `darkMode: 'class'` and shadcn semantic tokens

## Quick tour

```bash
git clone https://github.com/OWNER/REPO
cd hub-agent/agent-kernel
pnpm install
pnpm -r build
pnpm -r test        # kernel / host / executor / dashboard suites
```

Run it end-to-end (two terminals  -  Host serves the dashboard):

```bash
# Terminal 1  -  host (LLM + event log + Socket.IO server + dashboard bundle)
export ANTHROPIC_API_KEY=sk-...
pnpm --filter @agent-kernel/host dev                   # listens on :3000, serves dashboard at /

# Terminal 2  -  executor (dials into host, provides the tools)
pnpm --filter @agent-kernel/executor exec tsx bin/agent-kernel-executor.ts \
  --host http://localhost:3000 \
  --workspace $(pwd)/examples/scratch
```

Prefer an OpenAI-compatible endpoint (self-hosted gateway, `newapi`, LiteLLM, ollama's OpenAI-shim, Codex endpoints, etc.)? Just add the provider under Settings, or drop it into `~/.agent-kernel/config.json` (or leave it in `~/.codex/config.toml`  -  Host auto-imports).

Open `http://localhost:3000`, click **New** to create a session, pick a workspace + cwd + provider/model, and start chatting. You can pause any tool call for approval, scrub the timeline, and **fork** from any cursor to explore a different path  -  the host writes a JSONL log per session so replay/fork is deterministic.

For a walkthrough of how a single turn flows through the system, see [ARCHITECTURE](docs/ARCHITECTURE.md#turn-lifecycle).

## Repository layout

```
agent-kernel/
 -  packages/
 -     -  kernel/       Pure FSM + types. Zero dependencies.   -  the heart
 -     -  host/         LLM adapters + host loop + Socket.IO server + dashboard-bundle server
 -     -  executor/     Local Node daemon (dials into host)
 -     -  dashboard/    React SPA (chat + inspector + replay UI)
 -     -  shared/       Wire protocol types shared by host/executor/dashboard
 -  docs/             Design, specs, protocols, ADRs          -  start here
 -  examples/         Minimal working examples per phase
 -  references/       (gitignored) upstream projects for study
```

## Documentation

The docs are layered by intent  -  pick your entry point:

**Just want to understand the idea?** (~15 min)
1. This README
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)  -  three processes and one full turn end-to-end

**Want to implement something on top of the kernel?** (~1 hour)
1. [docs/SPEC.md](docs/SPEC.md)  -  the *only* normative kernel contract. Types, state machine, invariants.
2. [docs/protocol/wire-protocol.md](docs/protocol/wire-protocol.md)  -  every Socket.IO event between Dashboard, Host, and Executor
3. [docs/protocol/event-log.md](docs/protocol/event-log.md)  -  the JSONL format that makes replay/fork work
4. [docs/tools.md](docs/tools.md)  -  the executor tool set

**Want to see where the project stands vs. reference agents?**
1. [docs/FEATURE-GAPS.md](docs/FEATURE-GAPS.md)  -  shipped features, deliberately-out items, and comparison table (pi / opencode / codex / claude-code)
2. [docs/ROADMAP.md](docs/ROADMAP.md)  -  shipped feature ledger + deferred items
3. [docs/testing.md](docs/testing.md)  -  test strategy at each layer, including the real-browser cross-check rule

**Curious *why* a decision was made?**
- [docs/adr/](docs/adr/)  -  one file per big decision: pure FSM, reverse-WS, Socket.IO, no relay, config/state split, kernel boundary, MCP tools, dashboard stack, provider adapters, FSM dispatch table, host/core naming, Finder layout

Per-package details live next to the code:

- [packages/kernel/README.md](packages/kernel/README.md)
- [packages/host/README.md](packages/host/README.md)
- [packages/executor/README.md](packages/executor/README.md)
- [packages/dashboard/README.md](packages/dashboard/README.md)
- [packages/shared/README.md](packages/shared/README.md)

## Non-goals

- **Not a competitor to Claude Code / Codex.** Those are products. This is a reference implementation.
- **Not an orchestration framework.** LangGraph / AutoGen / crewai do that. `agent-kernel` deliberately keeps orchestration *outside* the kernel.
- **Not opinionated about planning, memory, or subagents.** Those are extensions, not core. (Sub-agent *dispatch* is a builtin, but *strategy* isn't.)

## License

MIT. See [LICENSE](LICENSE).

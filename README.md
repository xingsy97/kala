# Agent RunLab

> An open-source coding agent runtime and experiment platform.
> The **kernel** is a pure function. Every tool call, every state transition, every LLM turn
> is an inspectable event you can **pause, rewind, and fork** from a dashboard.

**Status**: Kernel + Host + Executor + Dashboard + Replay/Fork all shipped end-to-end. See [ROADMAP](docs/planning/roadmap.md) for the current feature ledger and [FEATURE-GAPS](docs/planning/feature-gaps.md) for the comparison with other agents.

---

## Why does this exist?

Existing coding agents fall into two camps, and neither is a clean substrate to learn from or reason about:

- **Closed source** — Claude Code and Codex CLI ship as binaries. Third-party source dumps exist, but there is no supported way to fork, hack, or replay a session.
- **Open source but not built to be read** — [opencode](https://github.com/sst/opencode) and [pi](https://github.com/earendil-works/pi) are both MIT-licensed and inspectable, but the agent loops are 3k+ LOC files interleaved with UI, provider quirks, planning, memory, and compaction. To learn from them you first have to unpick the ideas from the product.

Agent RunLab takes the other approach: strip the agent loop down to a pure function readable in one sitting, and push everything else outside the kernel. Three properties, in priority order:

1. **Readable.** The core is a pure function in [`packages/kernel/src/core.ts`](packages/kernel/src/core.ts) — around 350 lines — with types in [`types.ts`](packages/kernel/src/types.ts). If you know Redux, you know this.
2. **Model-agnostic.** The kernel does not know whether it is talking to Anthropic, OpenAI, or DeepSeek. Provider adapters live outside.
3. **Transparent and replayable.** Every session is an append-only event log. `fold(events, initialState)` reconstructs any historical state; `fork(events, cursor, newEvents)` branches. The dashboard exposes both as first-class UI.

## What makes it structurally different?

**Physical decoupling of agent core and tool executor.**

```
   Dashboard (React SPA, served by Host from dist/)         ← nothing installed, just a URL
        │  Socket.IO
        ▼
   Host (headless, public IP)                              ← runs anywhere: cloud, laptop, Lambda
     ├─ Kernel (pure FSM)
     ├─ LLM adapters (Anthropic Messages + OpenAI-compat, streaming SSE)
     ├─ Event log (JSONL, append-only)
     ├─ Compaction driver (manual `/compact` + auto on hard pressure)
     ├─ `agent` builtin (host-side sub-agent tool)
     └─ Connection layer (Socket.IO server, workspace-routed)
        ▲
        │  Socket.IO  (executor dials out — no inbound port needed)
        │
   Executor (Node daemon, per workspace)                   ← runs where the files live
     └─ Tools: read / ls / glob / grep / write / edit / bash /
               todowrite / web_search / bash_output / kill_shell
```

- **Kernel is a pure function**, not a class or a process. It's a library. `step(state, event, config) → { next, effects }`.
- **Host** owns the LLM, the event log, the compaction driver, and the Socket.IO server. It has the public IP and serves the dashboard bundle from `packages/dashboard/dist/`.
- **Executor** dials *out* to Host — no NAT/firewall problem. Each executor represents a **workspace** (a machine with a sandbox root); a session is bound to one workspace at create time.
- **Dashboard** is a React SPA that subscribes to a session and renders chat + inspector + replay UI.

This is not just an architectural cute — it means:
- You can run the kernel in the cloud and give it *your* laptop's shell without exposing any inbound port.
- The same kernel binary drives every deployment shape.
- A browser-side executor (e.g. WebContainer) is a straight drop-in: the Socket.IO client and tool contract don't change. Not shipped today — see [Non-goals](#non-goals).

## Shipped capabilities

Kernel / Host / Executor:

- Pure-function FSM with dispatch-table `step` ([ADR 0010](docs/meta/adr/0010-fsm-dispatch-table.md))
- JSONL event log with header + snapshots + fork lineage; deterministic `fold` replay; crash-recovery synthetic events on load
- Anthropic Messages API + OpenAI-compat (incl. Codex endpoints) adapters, both streaming SSE
- Provider auto-import from `~/.codex/config.toml` and `~/.claude/settings.json`, merged with `~/.agent-kernel/config.json`
- Approval modes `auto` / `ask` / `deny` / `allow_all` (with `AK_ALLOW_ALL_OK=1` host env-gate for `allow_all`); sub-agents run headless with forced `allow_all` (see [ADR 0014](docs/meta/adr/0014-subagent-approval-mode.md))
- Context pressure levels (`ok` / `soft` / `hard`) with manual `/compact` slash command and auto-compact on hard pressure
- Host-side `agent` builtin: child JSONL session under the same workspace, `maxAgentDepth` recursion guard
- Executor tool set: `read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash` (with `run_in_background` → `bash_output` / `kill_shell`), `todowrite`, `web_search` (built-in DuckDuckGo HTML endpoint — no paid API key)
- Session cwd stored in state, mutable via `client:set_cwd` → `cwd_changed` event; all `call_tool` effects carry cwd
- Image input (base64 or file-ref) supported in kernel + both adapters + Composer paste

Dashboard:

- Finder-style Explorer with workspaces × sessions, time-bucket grouping, in-place rename, workspace + session metadata modals
- Chat panel with streaming render, tool cards, approval cards (unified diff for `edit` / `write`), user message edit + fork, image paste + thumbnails, compact boundary marker
- Composer with model picker, context pressure ring, approval mode picker (with `allow_all` confirmation), `/compact` slash command, context pressure banner
- Inspector with state tree, event timeline (including compaction request details), effects, usage
- History scrubber with fork-from-any-event; background terminal panel derived from `bash` / `bash_output` / `kill_shell`
- Settings dialog covering providers (imported + user-added), per-provider model picker, default approval mode, host/port config
- Session creation dialog with workspace + cwd + provider/model selection
- Light / dark themes via Tailwind `darkMode: 'class'` and shadcn semantic tokens

## Quick tour

```bash
git clone <repo-url>
cd agent-kernel
pnpm install
pnpm -r build
pnpm -r test        # kernel / host / executor / dashboard suites
```

Run it end-to-end (two terminals — Host serves the dashboard):

```bash
# Terminal 1 — host (LLM + event log + Socket.IO server + dashboard bundle)
export ANTHROPIC_API_KEY=sk-...
pnpm --filter @agent-kernel/host dev                   # listens on :3000, serves dashboard at /

# Terminal 2 — executor (dials into host, provides the tools)
pnpm --filter @agent-kernel/executor exec tsx bin/agent-kernel-executor.ts \
  --host http://localhost:3000 \
  --workspace $(pwd)/examples/scratch
```

Prefer an OpenAI-compatible endpoint (self-hosted gateway, `newapi`, LiteLLM, ollama's OpenAI-shim, Codex endpoints, etc.)? Just add the provider under Settings, or drop it into `~/.agent-kernel/config.json` (or leave it in `~/.codex/config.toml` — Host auto-imports).

Open `http://localhost:3000`, click **New** to create a session, pick a workspace + cwd + provider/model, and start chatting. You can pause any tool call for approval, scrub the timeline, and **fork** from any cursor to explore a different path — the host writes a JSONL log per session so replay/fork is deterministic.

For a walkthrough of how a single turn flows through the system, see [ARCHITECTURE](docs/architecture/overview.md#turn-lifecycle).

## Deploy from a release

Every tag under [Releases](https://github.com/OWNER/REPO/releases) publishes:

- `agent-kernel-host-<os>-<arch>[.exe]` — self-contained Agent RunLab runtime binary (bundled Node.js runtime)
- `bundle-dashboard-with-runtime.cjs` — Host runtime + embedded dashboard bundle for Node.js 22+
- `agent-kernel-executor.cjs` — Executor fallback for Node.js 22+
- `agent-kernel-dashboard-dist.tar.gz` — the frontend bundle
- `run.sh` — a `wget`-only bootstrap that downloads, verifies (SHA256), and runs a component

Set `COMPONENT` to pick what to run on this machine:

| `COMPONENT` | What runs here |
|---|---|
| `host-frontend` (default) | Host process + embedded dashboard bundle. Open a browser at `http://<this-host>:3000/`. |
| `host` | Headless host only. Deploy the frontend somewhere else. |
| `frontend` | Downloads and extracts the frontend bundle to a directory, prints its path, exits. |
| `executor` | Executor that dials into a running host. Requires `HOST_URL`. |

Typical VM deploy:

```bash
export ANTHROPIC_API_KEY=sk-...
export HOST=0.0.0.0                  # bind on all interfaces
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; wget -nv -O "$tmp" "https://github.com/OWNER/REPO/releases/latest/download/run.sh"; COMPONENT=host-frontend bash "$tmp"'
```

Executor on the machine that holds the files:

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; wget -nv -O "$tmp" "https://github.com/OWNER/REPO/releases/latest/download/run.sh"; COMPONENT=executor HOST_URL=http://<vm-ip>:3000 bash "$tmp" -- --workspace "$(pwd)/my-project"'
```

Environment variables the bootstrap and host understand:

- `HOST` / `PORT` — bind interface and port (default `127.0.0.1:3000`)
- `AGENT_KERNEL_FRONTEND_DIR` — where the frontend bundle is extracted (default: temp)
- `AGENT_KERNEL_ALLOWED_ORIGINS` — comma-separated origins allowed for cross-origin dashboards (unset = same-origin only)
- `AGENT_KERNEL_RUNTIME=auto|cjs|native` — pick runtime family
- `AGENT_KERNEL_RUN_DIR` — persistent scratch dir (default: fresh mktemp cleaned on exit)

The dashboard resolves its host endpoint from (in priority order): `?host=` URL param → Settings dialog override → build-time `VITE_AGENT_KERNEL_HOST` → same origin as the served bundle. Change it at runtime under **Settings → Connection**.

## Repository layout

```
agent-kernel/
├── packages/
│   ├── kernel/       Pure FSM + types. Zero dependencies.  ← the heart
│   ├── host/         LLM adapters + host loop + Socket.IO server + dashboard-bundle server
│   ├── executor/     Local Node daemon (dials into host)
│   ├── dashboard/    React SPA (chat + inspector + replay UI)
│   └── shared/       Wire protocol types shared by host/executor/dashboard
├── docs/             Design, specs, protocols, ADRs         ← start here
├── examples/         Minimal working examples per phase
└── references/       (gitignored) upstream projects for study
```

## Documentation

The docs are layered by intent — pick your entry point:

**Just want to understand the idea?** (~15 min)
1. This README
2. [docs/architecture/overview.md](docs/architecture/overview.md) — three processes and one full turn end-to-end

**Want to implement something on top of the kernel?** (~1 hour)
1. [docs/kernel/spec.md](docs/kernel/spec.md) — the *only* normative kernel contract. Types, state machine, invariants.
2. [docs/protocol/wire-protocol.md](docs/protocol/wire-protocol.md) — every Socket.IO event between Dashboard, Host, and Executor
3. [docs/protocol/event-log.md](docs/protocol/event-log.md) — the current JSONL format that makes replay/fork work
4. [docs/executor/tools.md](docs/executor/tools.md) — the executor tool set

**Working on session storage or context accounting?**
- [docs/host/session-log-context-persistence.md](docs/host/session-log-context-persistence.md) — the breaking v2 session-log design, including the current JSONL growth root cause and Codex/Claude Code reference formats

**Want to see where the project stands vs. reference agents?**
1. [docs/planning/feature-gaps.md](docs/planning/feature-gaps.md) — shipped features, deliberately-out items, and comparison table (pi / opencode / codex / claude-code)
2. [docs/planning/roadmap.md](docs/planning/roadmap.md) — shipped feature ledger + deferred items
3. [docs/meta/testing.md](docs/meta/testing.md) — test strategy at each layer, including the real-browser cross-check rule

**Curious *why* a decision was made?**
- [docs/meta/adr/](docs/meta/adr/) — one file per big decision: pure FSM, reverse-WS, Socket.IO, no relay, config/state split, kernel boundary, MCP tools, dashboard stack, provider adapters, FSM dispatch table, host/core naming, Finder layout

Per-package details live next to the code:

- [packages/kernel/README.md](packages/kernel/README.md)
- [packages/host/README.md](packages/host/README.md)
- [packages/executor/README.md](packages/executor/README.md)
- [packages/dashboard/README.md](packages/dashboard/README.md)
- [packages/shared/README.md](packages/shared/README.md)

## Non-goals

- **Not a competitor to Claude Code / Codex.** Those are products. This is a reference implementation.
- **Not an orchestration framework.** LangGraph / AutoGen / crewai do that. Agent RunLab deliberately keeps orchestration *outside* the kernel.
- **Not opinionated about planning, memory, or subagents.** Those are extensions, not core. (Sub-agent *dispatch* is a builtin, but *strategy* isn't.)

## License

MIT. See [LICENSE](LICENSE).

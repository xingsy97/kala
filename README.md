# agent-kernel

**Status**: Phases 1–5 shipped. Kernel + Host + Executor + Dashboard + Replay/Fork all live end-to-end, with 86 tests across the monorepo. See [ROADMAP](docs/ROADMAP.md).

---

## Why does this exist?

Existing coding agents fall into one of two camps, and neither gives you a clean substrate to *learn from* or *reason about*:

- **Closed source** — Claude Code, Codex CLI ship as binaries. You can read the source-collection dumps some people have published, but there's no supported way to fork, hack, or replay a session.
- **Open source but not built to be read** — [opencode](https://github.com/sst/opencode) and [pi](https://github.com/earendil-works/pi) are both MIT-licensed and inspectable, but their agent loops are 3k+ LOC files interleaved with UI, provider quirks, planning, memory, and compaction. To learn from them you first have to *un-mix* the ideas from the product.

1. **Readable.** The core of it all is a pure function in [`packages/kernel/src/core.ts`](packages/kernel/src/core.ts) — ~300 lines — with types in [`types.ts`](packages/kernel/src/types.ts). If you know Redux, you know this.
2. **Model-agnostic.** The kernel doesn't know if it's talking to Anthropic, OpenAI, or DeepSeek. Provider adapters live outside.
3. **Transparent + replayable.** Every session is an append-only event log. `fold(events, initialState)` reconstructs any historical state. `fork(events, cursor, newEvents)` branches. The dashboard exposes both as first-class UI.

## What makes it structurally different?

**Physical decoupling of agent core and tool executor.**

```
   Dashboard (React SPA)                                   ← nothing installed, just a URL
        │  Socket.IO
        ▼
   Host (headless, public IP)                              ← runs anywhere: cloud, laptop, Lambda
     ├─ Kernel (pure FSM)
     ├─ LLM adapter
     └─ Connection layer (Socket.IO server)
        ▲
        │  Socket.IO  (executor dials out — no inbound port needed)
        │
   Executor (Node daemon)                                  ← runs where the files live
     └─ Tool registry: read / write / edit / bash / grep / glob / ls
```

- **Kernel is a pure function**, not a class or a process. It's a library. `step(state, event, config) → { next, effects }`.
- **Host** owns the LLM, the event log, and the Socket.IO server. It has the public IP.
- **Executor** dials *out* to Host — no NAT/firewall problem.
- **Dashboard** is a React SPA that subscribes to a session and renders chat + inspector + replay UI.

This is not just an architectural cute — it means:
- You can run the kernel in the cloud and give it *your* laptop's shell without exposing any inbound port.
- The same kernel binary drives every deployment shape.
- A browser-side executor (e.g. WebContainer) is a straight drop-in: the Socket.IO client and tool contract don't change. Not shipped today — see [Non-goals](#non-goals).

## Quick tour

```bash
git clone https://github.com/<owner>/agent-kernel
cd agent-kernel
pnpm install
pnpm -r build
pnpm -r test        # 86 tests across kernel / host / executor / dashboard
```

Run it end-to-end (three terminals):

```bash
# Terminal 1 — host (LLM + event log + Socket.IO server)
export ANTHROPIC_API_KEY=sk-...
pnpm --filter @agent-kernel/host dev                   # listens on :3000

# Terminal 2 — executor (dials into host, provides the 7 tools)
pnpm --filter @agent-kernel/executor exec tsx bin/agent-kernel-executor.ts \
  --host http://localhost:3000 \
  --session demo \
  --workspace $(pwd)/examples/scratch

# Terminal 3 — dashboard (React SPA)
pnpm --filter @agent-kernel/dashboard dev              # opens http://localhost:5173
```

Prefer an OpenAI-compatible endpoint (self-hosted gateway, `newapi`, LiteLLM, ollama's OpenAI-shim, etc.)? Swap terminal 1:

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # or your gateway's /v1 root
export HOST_MODEL=gpt-4o-mini                       # optional
pnpm --filter @agent-kernel/host dev
```

Then in the dashboard, connect to `http://localhost:3000` with session id `demo`, and start chatting. You can pause any tool call for approval, scrub the timeline, and **fork** from any cursor to explore a different path — the host writes a JSONL log per session so replay/fork is deterministic.

For a walkthrough of how a single turn flows through the system, see [ARCHITECTURE](docs/ARCHITECTURE.md#turn-lifecycle).

## Repository layout

```
agent-kernel/
├── packages/
│   ├── kernel/       Pure FSM + types. Zero dependencies.  ← the heart
│   ├── host/         LLM adapter + host loop + Socket.IO server
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
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — three processes and one full turn end-to-end

**Want to implement something on top of the kernel?** (~1 hour)
1. [docs/SPEC.md](docs/SPEC.md) — the *only* normative kernel contract. Types, state machine, invariants.
2. [docs/protocol/wire-protocol.md](docs/protocol/wire-protocol.md) — every Socket.IO event between Dashboard, Host, and Executor
3. [docs/protocol/event-log.md](docs/protocol/event-log.md) — the JSONL format that makes replay/fork work
4. [docs/tools.md](docs/tools.md) — the 7 tools Executor ships

**Want to build the next phase of this project?** (or feed docs to a code agent)
1. [docs/implementation-guide.md](docs/implementation-guide.md) — procedural walkthrough of Phases 2–6, ties every spec together
2. [docs/ROADMAP.md](docs/ROADMAP.md) — what "done" means for each phase
3. [docs/testing.md](docs/testing.md) — test strategy at each layer

**Curious *why* a decision was made?**
- [docs/adr/](docs/adr/) — one file per big decision: pure FSM, reverse-WS, no relay, Socket.IO, config/state split, kernel boundary, MCP tools, dashboard stack, provider adapters, FSM dispatch table, host/core naming

Per-package details live next to the code:

- [packages/kernel/README.md](packages/kernel/README.md)
- [packages/host/README.md](packages/host/README.md)
- [packages/executor/README.md](packages/executor/README.md)
- [packages/dashboard/README.md](packages/dashboard/README.md)
- [packages/shared/README.md](packages/shared/README.md)

## Non-goals

- **Not a competitor to Claude Code / Codex.** Those are products. This is a reference implementation.
- **Not an orchestration framework.** LangGraph / AutoGen / crewai do that. `agent-kernel` deliberately keeps orchestration *outside* the kernel.
- **Not opinionated about planning, memory, or subagents.** Those are extensions, not core.

## License

MIT. See [LICENSE](LICENSE).

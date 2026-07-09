# @agent-kernel/host

The **host** for the kernel. Wraps [`@agent-kernel/kernel`](../kernel/) with everything that requires IO: LLM calls, event persistence, and the Socket.IO server that Dashboard and Executor dial into.

**Status**: implemented (Phase 2 — see [ROADMAP](../../docs/ROADMAP.md)).

---

## Responsibilities

Host is the only process with a public IP. It owns:

1. **The host loop** (`src/loop.ts`) — consumes effects from the kernel, performs IO, feeds results back as events. Terminates when the kernel reaches a terminal status.
2. **LLM adapters** (`src/llm/`) — translates `Message[]` ↔ provider-specific request/response. Anthropic first; OpenAI/DeepSeek later.
3. **Session store** (`src/store/`) — in-memory session map + append-only JSONL log per session on disk.
4. **Connection layer** (`src/connection/`) — Socket.IO server with two namespaces (`/dashboard`, `/executor`) and per-session rooms.

## What it does NOT do

- Execute tool calls — that's the Executor's job. Host dispatches `tool:call` over the wire and awaits a result.
- Render UI — that's the Dashboard's job.
- Modify the kernel — Host imports and calls `step`/`fold`; it never patches kernel internals.

## Public entry points

```typescript
import { startHostServer } from '@agent-kernel/host'

const server = await startHostServer({
  port: 3000,
  llm: /* provider registry */,
  sessionsDir: '~/.agent-kernel/sessions',
})
```

Or run standalone:

```bash
node packages/host/bin/agent-kernel-host.js
# reads ANTHROPIC_API_KEY, PORT, SESSIONS_DIR from env
```

## References

- Spec: [`docs/SPEC.md`](../../docs/SPEC.md) (kernel contract Host consumes)
- Wire: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md)
- Log: [`docs/protocol/event-log.md`](../../docs/protocol/event-log.md)
- Architecture: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- How to build this package: [`docs/implementation-guide.md`](../../docs/implementation-guide.md) §3

## Test coverage target

≥80% (per [`docs/testing.md`](../../docs/testing.md) §3). Mock the LLM at the HTTP layer, mock the Executor at the wire layer. **Do not mock the kernel** — call it directly with real state.

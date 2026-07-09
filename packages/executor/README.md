# @agent-kernel/executor

The **tool runner**. A Node daemon (Phase 3) — later also a browser WebContainer variant (Phase 6). Dials *out* to Host over Socket.IO; no inbound port required.

**Status**: not yet implemented (Phase 3 — see [ROADMAP](../../docs/ROADMAP.md)).

---

## Why "reverse-WebSocket"?

The Executor runs where the *files* live — usually behind a home router or corporate firewall — while Host lives in the cloud. So the Executor initiates the connection *outward* to Host. See [ADR 0002](../../docs/adr/0002-reverse-websocket.md).

Consequence: no port forwarding, no ngrok, no VPN. Just:

```bash
agent-kernel-executor --core=wss://your-core.fly.dev --session=abc --workspace=~/repo
```

## Responsibilities

1. **Tool registry** (`src/tools/`) — one file per tool from [`docs/tools.md`](../../docs/tools.md): `read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash`.
2. **Sandbox** (`src/sandbox.ts`) — workspace whitelist. Every path is resolved and rechecked to prevent escape via `..`, absolute paths, or symlinks.
3. **Socket.IO client** (`src/client.ts`) — connects to Host's `/executor` namespace, announces tools, handles `tool:call` events, ACKs with results.

## What it does NOT do

- Contact any LLM.
- Persist session state — Host owns the JSONL log.
- Decide whether a tool call needs user approval — that's Host+Dashboard's decision; Executor just runs what Host dispatches.

## Public entry points

```typescript
import { startExecutor } from '@agent-kernel/executor'

await startExecutor({
  core: 'wss://core.example.com',
  session: 'abc',
  workspace: '<workspace-root>',
  token: process.env.EXECUTOR_TOKEN,
})
```

## References

- Tool contracts: [`docs/tools.md`](../../docs/tools.md)
- Wire protocol: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md) §3.3
- Architecture: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- How to build this package: [`docs/implementation-guide.md`](../../docs/implementation-guide.md) §4

## Test coverage target

≥90% (per [`docs/testing.md`](../../docs/testing.md) §4). Each tool has a test file covering happy path, missing file, permission denied, invalid schema, idempotency where relevant, and tool-specific edge cases. Sandbox has its own dedicated test suite for path-escape attempts.

# @agent-kernel/executor

The **tool runner**. A Node daemon that dials *out* to Host over Socket.IO; no inbound port required.

---

## Why "reverse-WebSocket"?

The Executor runs where the *files* live — usually behind a home router or corporate firewall — while Host lives in the cloud. So the Executor initiates the connection *outward* to Host. See [ADR 0002](../../docs/adr/0002-reverse-websocket.md).

Consequence: no port forwarding, no ngrok, no VPN. Just:

```bash
agent-kernel-executor --host=http://localhost:3000 --workspace=<workspace-root>
```

## Responsibilities

1. **Tool registry** (`src/tools/`) — one file per tool from [`docs/tools.md`](../../docs/tools.md): `read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash`, `todowrite`, `web_search`, `bash_output`, `kill_shell`.
2. **Sandbox** (`src/sandbox.ts`) — workspace whitelist. Every path is resolved and rechecked to prevent escape via `..`, absolute paths, or symlinks.
3. **Background shell registry** (`src/background.ts`) — `bash --run-in-background` → `taskId`; `bash_output`; `kill_shell`.
4. **Socket.IO client** (`src/client.ts`) — dials Host's `/executor` namespace; announces `workspaceId` / `workspaceName` / `os` / `runtime` / `sandboxRoots` / tool names; handles `tool:call` / `fs:list_dirs` / cancel; auto-reconnects and re-announces.

## What it does NOT do

- Contact any LLM.
- Persist session state — Host owns the JSONL log.
- Decide whether a tool call needs user approval — that's Host + Dashboard's decision; Executor just runs what Host dispatches.
- Host the `agent` builtin — that's host-side (see [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)); it does not appear in the executor tool registry.

## Public entry points

```typescript
import { startExecutor } from '@agent-kernel/executor'

await startExecutor({
  host: 'http://localhost:3000',
  workspace: '<workspace-root>',
  token: process.env.EXECUTOR_TOKEN,
})
```

## References

- Tool contracts: [`docs/tools.md`](../../docs/tools.md)
- Wire protocol: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md)
- Architecture: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- Spec: [`docs/SPEC.md`](../../docs/SPEC.md)

## Test coverage target

≥90% (per [`docs/testing.md`](../../docs/testing.md) §4). Each tool has a test file covering happy path, missing file, permission denied, invalid schema, idempotency where relevant, and tool-specific edge cases. Sandbox has its own dedicated test suite for path-escape attempts.

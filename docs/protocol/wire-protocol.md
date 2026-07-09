# Wire Protocol

**Transport**: Socket.IO 4.x
**Serialization**: JSON (Socket.IO default)
**Status**: Normative for v1

This doc specifies every message that crosses process boundaries. If a Host/Dashboard/Executor implementation matches this doc, it interoperates.

---

## 1. Endpoints and namespaces

Host exposes a Socket.IO server at a single HTTP(S) port with two namespaces:

| Namespace | Who connects | Direction |
|---|---|---|
| `/dashboard` | Dashboard SPA | Inbound to Host |
| `/executor` | Executor (Node daemon or browser WebContainer) | Inbound to Host |

Both use the same underlying transport. Namespaces isolate the routing logic.

**Rooms**: Both namespaces use rooms named `session:<sessionId>` for per-session fan-out.

---

## 2. Handshake (both namespaces)

On connect, the client sends an authentication payload via Socket.IO's `auth` field:

```ts
type HandshakeAuth = {
  sessionId: string          // ULID; identifies the session
  role: 'dashboard' | 'executor'
  token?: string             // v1: optional. v2: JWT bearer token
  clientVersion: string      // e.g. "@agent-kernel/executor@0.1.0"
}
```

Host validates:
- `sessionId` matches an existing session OR the connection is allowed to create one (dashboard-only for v1)
- `role` matches the namespace (`role: 'executor'` MUST use `/executor`)
- `token` valid if server is configured to require auth

**On success**: server calls `socket.join(\`session:\${sessionId}\`)` and sends a `session:ready` event (see §3).

**On failure**: server disconnects with a reason string (`auth_failed`, `unknown_session`, `role_mismatch`, `version_incompatible`).

---

## 3. Common events (Host → all clients in a session room)

Host broadcasts these to any client joined to `session:<sessionId>`.

### 3.1 `session:ready`

Emitted once per client, right after handshake succeeds.

```ts
{
  sessionId: string
  cursor: number              // current event cursor of the session
  state: AgentState           // current snapshot (see SPEC §1.4)
  config: AgentConfig         // (see SPEC §1.3)
}
```

### 3.2 `state:changed`

Emitted after every kernel `step` call that mutated state.

```ts
{
  sessionId: string
  cursor: number              // = state.cursor (matches SPEC I1)
  state: AgentState
}
```

For bandwidth reasons, clients MAY subscribe to `event:appended` instead and reconstruct state locally by applying events to their last-known snapshot. v1 servers send both.

### 3.3 `event:appended`

Emitted after every kernel `step` call, including no-ops (per SPEC I1, no-ops still advance cursor).

```ts
{
  sessionId: string
  seq: number                 // = state.cursor after this event; 1-indexed
  ts: string                  // ISO 8601 timestamp of when Host applied this event
  event: AgentEvent           // the event that was applied
  effects: Effect[]           // effects the kernel emitted for this event
}
```

Dashboards use this to draw the event timeline.

### 3.4 `session:error`

Emitted when the kernel enters `status: 'error'`, or when Host's own machinery hits an unrecoverable issue.

```ts
{
  sessionId: string
  scope: 'kernel' | 'llm' | 'executor' | 'host'
  message: string
}
```

`scope` values:

- `kernel` — an invariant inside the pure FSM was violated (should be impossible in practice; treat as a bug).
- `llm` — the LLM adapter (OpenAI/Anthropic) surfaced an error we bubbled through `onLlmError`; kernel is now in `status: 'error'`.
- `executor` — the executor side of Host's registry surfaced an error (bad tool_result payload, unhandled dispatcher exception, etc.).
- `host` — Host's own machinery (session lookup, handshake validation, socket wiring). The `unknown_session` message on the executor namespace uses this scope (see §2).

---

## 4. Dashboard-specific events

### 4.1 Dashboard → Host

The dashboard's job is to inject user-originated events into the kernel.

#### `client:user_message`

```ts
{ sessionId: string; text: string }
```

Host translates to `{ kind: 'user_message', text }` and feeds to `step`.

#### `client:user_approve`

```ts
{ sessionId: string; callId: string }
```

Host → `{ kind: 'user_approve', callId }`.

#### `client:user_reject`

```ts
{ sessionId: string; callId: string; reason?: string }
```

Host → `{ kind: 'user_reject', callId, reason }`.

#### `client:cancel`

```ts
{ sessionId: string }
```

Host → `{ kind: 'cancel' }`.

#### `client:fork`

```ts
{
  sourceSessionId: string
  cursor: number              // fork after this cursor
  newSessionId?: string       // if omitted, Host generates one
}
```

Host replays the source event log up to `cursor` into a new session with `newSessionId`, then treats the new session as active. Responds with a `session:ready` for the new session (on a new room; client should `emit('subscribe', newSessionId)`).

#### `subscribe`

```ts
{ sessionId: string }
```

Explicitly join an additional session room after the initial handshake. Response: `session:ready` on success.

### 4.2 Host → Dashboard only (not executor)

#### `approval:required`

Sent when the kernel emits a `request_approval` effect. Dashboard renders a confirm UI.

```ts
{
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
}
```

Dashboard resolves via `client:user_approve` or `client:user_reject`.

#### `usage:updated`

Convenience event; a projection of the running `state.usage` after each LLM response.

```ts
{
  sessionId: string
  usage: UsageTotal           // { inputTokens, outputTokens, costUsd }
}
```

---

## 5. Executor-specific events

Executor is a pure RPC responder. It receives commands from Host, executes them, and replies. It never originates state-changing events.

### 5.1 Executor → Host (on connect)

#### `executor:announce`

Sent by executor after `session:ready`. Declares its capabilities.

```ts
{
  sessionId: string
  executorId: string          // client-generated stable id
  tools: string[]             // tool names this executor implements
  workingDir?: string         // for logging/display only
  runtime: 'node' | 'browser-webcontainer' | 'other'
  runtimeVersion: string
}
```

Host stores the mapping `sessionId → executor(s)`. v1 accepts one executor per session; a second `executor:announce` for the same session replaces the first.

### 5.2 Host → Executor

#### `tool:call`

Sent when the kernel emits a `call_tool` effect and Host has an executor connected for the session.

```ts
{
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  timeoutMs?: number          // Host's soft deadline. Executor SHOULD respect it.
}
```

**Reply**: executor MUST reply via Socket.IO ACK **or** via `executor:tool_result`. ACK is preferred (better error handling):

```ts
// Ack payload:
{
  callId: string
  ok: boolean
  content: string             // stringified result / error
}
```

Host translates the reply into `{ kind: 'tool_result', callId, ok, content }` and feeds to `step`.

#### `tool:cancel`

Sent when the kernel emits a `cancel` event and pending calls need to be interrupted.

```ts
{ sessionId: string; callId: string }
```

Executor SHOULD attempt to interrupt the running tool. Executor MUST reply (via ACK or `executor:tool_result`) even if the tool had already completed — reply with `ok: false, content: 'cancelled'` in the ambiguous case.

### 5.3 Executor → Host (outside of a tool:call response)

#### `executor:tool_result`

Alternative to Socket.IO ACK. Useful when a tool completes long after the initial `tool:call` (streaming tools, long bash commands).

```ts
{
  sessionId: string
  callId: string
  ok: boolean
  content: string
}
```

#### `executor:progress` (optional, v2)

Streaming progress for long-running tools. Not required in v1.

```ts
{
  sessionId: string
  callId: string
  chunk: string
}
```

Host forwards to Dashboard as `tool:progress`.

---

## 6. Message routing summary

| Origin | Message | Target |
|---|---|---|
| Dashboard | `client:user_message` | Host (kernel) |
| Dashboard | `client:user_approve` | Host (kernel) |
| Dashboard | `client:user_reject` | Host (kernel) |
| Dashboard | `client:cancel` | Host (kernel) |
| Dashboard | `client:fork` | Host (kernel + storage) |
| Dashboard | `subscribe` | Host (routing) |
| Executor | `executor:announce` | Host (routing) |
| Executor | ACK to `tool:call` | Host (kernel) |
| Executor | `executor:tool_result` | Host (kernel) |
| Host | `session:ready` | Dashboard OR Executor |
| Host | `state:changed` | All in room |
| Host | `event:appended` | All in room |
| Host | `session:error` | All in room |
| Host | `approval:required` | Dashboard only |
| Host | `usage:updated` | Dashboard only |
| Host | `tool:call` | Executor only |
| Host | `tool:cancel` | Executor only |

---

## 7. Error handling

### 7.1 Auth failure

Host disconnects the socket immediately with `{ reason: string }`. Client MUST NOT retry the same handshake without changing auth.

### 7.2 Tool call timeout

If executor does not reply to `tool:call` within `timeoutMs` (default: **60000ms**, configurable per session):
- Host synthesizes `{ kind: 'tool_result', callId, ok: false, content: 'tool call timed out after Xms' }` and feeds to kernel
- Kernel proceeds as if the tool failed
- If executor eventually replies, the reply is discarded (its callId is no longer in `pendingCalls`; kernel treats as no-op)

### 7.3 Executor disconnected while calls pending

Host detects via Socket.IO `disconnect`. For every pending `call_tool` targeting the disconnected executor:
- Synthesize `tool_result(ok=false, content='executor disconnected')`
- Feed to kernel

The session moves forward. When executor reconnects (with same `sessionId`), it re-announces and resumes.

### 7.4 Dashboard disconnected

No kernel action needed. On reconnect and re-subscribe, Host sends `session:ready` with current state. If the dashboard wants recent events for its timeline, it MAY send `subscribe` with a `sinceCursor` field (v2).

### 7.5 LLM error

`llm_error` events happen inside Host (not from clients). Kernel enters `error` status; Host broadcasts `session:error` with `scope: 'llm'`. Clients decide UX (typically show a retry button that emits a fresh `user_message`).

---

## 8. Reconnection semantics

Socket.IO handles TCP-level reconnection. On reconnect:

1. Client re-sends handshake auth (Socket.IO does this automatically if `reconnection: true`).
2. Server calls `socket.join('session:...')` again.
3. Server emits `session:ready` with current state.
4. If client has a stale `cursor`, it can compare with `session:ready.cursor` and decide whether to fetch missing events via a `history:query` (v2).

**v1 keeps it simple**: after reconnect, clients treat their state as fresh from `session:ready`. Timeline reconstruction on reconnect is a v2 concern.

---

## 9. Versioning and backward compatibility

The `clientVersion` field in handshake auth lets Host reject clients too old to speak the current protocol. Version bumps:

- **Patch** (e.g. `0.1.0` → `0.1.1`): documentation fixes, no wire change
- **Minor**: add new event kinds. Old clients ignore unknown events
- **Major**: remove or repurpose existing events. Old clients rejected at handshake

Server exposes its protocol version in the `session:ready` payload (v2 field: `protocolVersion`).

---

## 10. Full type definitions

Wire protocol types live in `packages/shared/src/protocol.ts` and are imported by `core`, `executor`, and `dashboard`. Any change to this doc MUST update `packages/shared/src/protocol.ts` in the same PR.

**Import example**:

```ts
import type {
  HandshakeAuth,
  SessionReadyEvent,
  ToolCallMessage,
  ToolResultAck,
} from '@agent-kernel/shared'
```

---

## 11. Example: full session flow

```
Dashboard connects:
  → HandshakeAuth { sessionId: 's1', role: 'dashboard', clientVersion: '0.1.0' }
  ← session:ready { sessionId: 's1', cursor: 0, state: {…}, config: {…} }

User types "hi":
  → client:user_message { sessionId: 's1', text: 'hi' }
  ← event:appended { seq: 1, event: { kind: 'user_message', text: 'hi' }, effects: [{ kind: 'call_llm', ... }] }
  ← state:changed { cursor: 1, state: {status: 'thinking', …} }

Host calls Anthropic; response contains a tool_call for 'read':
  ← event:appended { seq: 2, event: { kind: 'llm_response', message: {…}, usage: {…} }, effects: [{ kind: 'call_tool', callId: 'c1', name: 'read', … }] }
  ← state:changed { cursor: 2, state: {status: 'executing_tools', pendingCalls: [{callId: 'c1', status: 'dispatched'}]} }

  (Executor was already announced. Host emits tool:call to it, waits for ACK.)

Executor replies via ACK:
  { callId: 'c1', ok: true, content: 'file contents…' }
  ← event:appended { seq: 3, event: { kind: 'tool_result', callId: 'c1', ok: true, content: '...' }, effects: [{ kind: 'call_llm', ... }] }
  ← state:changed { cursor: 3, state: {status: 'thinking', pendingCalls: []} }

Host calls Anthropic again; plain text answer:
  ← event:appended { seq: 4, event: { kind: 'llm_response', message: {…} }, effects: [{ kind: 'finish' }] }
  ← state:changed { cursor: 4, state: {status: 'done'} }
  ← usage:updated { usage: { inputTokens: 352, outputTokens: 94, costUsd: 0 } }
```

This session yields 4 lines in the JSONL event log (see [event-log.md](event-log.md) §3).

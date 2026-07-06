# Wire Protocol

**Transport**: Socket.IO 4.x
**Serialization**: JSON (Socket.IO default)
**Status**: Normative.

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
  role: 'dashboard' | 'executor'
  sessionId?: string         // required for `dashboard`; MUST be absent for `executor`
  token?: string             // v1: optional. v2: JWT bearer token
  clientVersion: string      // e.g. "@agent-kernel/executor@0.1.0"
}
```

Host validates:
- Dashboard connections MUST carry a `sessionId` (the session they subscribe to). It matches an existing session OR the connection is allowed to lazy-create one on first user message.
- Executor connections MUST NOT carry a `sessionId`  -  an executor is a daemon that serves any session whose `workspaceName` matches its own (see  - 5).
- `role` matches the namespace (`role: 'executor'` MUST use `/executor`)
- `token` valid if server is configured to require auth

**On success (dashboard)**: server calls `socket.join(\`session:\${sessionId}\`)` and sends a `session:ready` event (see  - 3).

**On success (executor)**: connection is accepted; the executor MUST then emit `executor:announce` ( - 5.1) to become routable. No `session:ready` is sent  -  executor rooms are joined lazily when Host receives `tool:call` traffic for a matching session.

**On failure**: server disconnects with a reason string (`auth_failed`, `unknown_session`, `role_mismatch`, `version_incompatible`, `missing_session_id`).

---

## 3. Common events (Host  -  all clients in a session room)

Host broadcasts these to any client joined to `session:<sessionId>`.

### 3.1 `session:ready`

Emitted once per client, right after handshake succeeds.

```ts
{
  sessionId: string
  cursor: number              // current event cursor of the session
  state: AgentState           // current snapshot (see SPEC  - 1.4)
  config: AgentConfig         // (see SPEC  - 1.3)
  parentSessionId?: string    // for forked sessions
  parentCursor?: number       // fork point on the parent
  workspaceId?: string        // routing key  -  the workspace this session is bound to ( - 5.1). Undefined for legacy sessions predating the field.
  workspaceName?: string      // display label for the workspace, snapshotted at session-create time
  selectedModel?: string      // per-session model override, if one has been set
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
  llmTrace?: LLMTrace         // optional provider-level trace for llm_response
}
```

Dashboards use this to draw the event timeline. `llmTrace` is metadata on
the log entry, not a kernel event and not part of `AgentState`. It is present
only for LLM responses recorded by hosts that capture provider traces. The
trace includes the final provider request URL, redacted headers, request body,
response status, and either the raw response body or a compact streaming
summary. Authorization secrets MUST be redacted before persistence.

**Extended event kinds**: `event.kind` may be `compact_replaced`,
`approval_mode_changed`, or `cwd_changed` in addition to the base v0.1 union.
`compact_replaced` events carry the summarizer `request` (`model`,
`systemPrompt`, `messages`, `tools`), a `trigger` of `manual` or `auto`, and
optional `responseUsage`, so history can show the exact compact LLM request
and result side by side.

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

- `kernel`  -  an invariant inside the pure FSM was violated (should be impossible in practice; treat as a bug).
- `llm`  -  the LLM adapter (OpenAI/Anthropic) surfaced an error we bubbled through `onLlmError`; kernel is now in `status: 'error'`.
- `executor`  -  the executor side of Host's registry surfaced an error (bad tool_result payload, unhandled dispatcher exception, etc.).
- `host`  -  Host's own machinery (session lookup, handshake validation, socket wiring). The `unknown_session` message on the executor namespace uses this scope (see  - 2).

---

## 4. Dashboard-specific events

### 4.1 Dashboard  -  Host

The dashboard's job is to inject user-originated events into the kernel.

#### `client:user_message`

```ts
{
  sessionId: string
  text: string
  mode?: 'steer' | 'queue'
  content?: MessageContent[]
}
```

Host translates to `{ kind: 'user_message', text, content? }` and feeds to
`step` when the session is idle. `mode: 'steer'` is the default: during an
active turn the host cancels the current stream if needed and promotes the
message at the front of the next safe delivery boundary. `mode: 'queue'` holds
the message until the current turn finishes, then promotes queued messages in
FIFO order. Queue state is surfaced with `server:message_queue`; dashboards
must render pending message previews instead of showing only a count.

#### `client:user_approve`

```ts
{ sessionId: string; callId: string }
```

Host  -  `{ kind: 'user_approve', callId }`.

#### `client:user_reject`

```ts
{ sessionId: string; callId: string; reason?: string }
```

Host  -  `{ kind: 'user_reject', callId, reason }`.

#### `client:cancel`

```ts
{ sessionId: string }
```

Host  -  `{ kind: 'cancel' }`. Also aborts the in-flight LLM stream if any.

#### `client:cancel_stream`

```ts
{ sessionId: string }
```

Abort the in-flight LLM call *without* leaving the FSM. Any streamed text so
far becomes the final assistant message with a `[cancelled]` suffix, so the
event log always sees a complete `llm_response`. No-op if nothing is
streaming. Wired to the dashboard ESC key during a `thinking` turn.

#### `client:compact`

```ts
{ sessionId: string }
```

Ask the host to summarize the current transcript with the summarizer LLM and
replace the message list with the summary. Emitted from the exact `/compact`
input  -  the dashboard does **not** append `/compact` as a `user_message`. Host
records a `compact_replaced` event carrying the summarizer request, trigger
(`manual`), summary text, replaced count, and token deltas.

#### `client:set_approval_mode`

```ts
{ sessionId: string; mode: 'auto' | 'ask' | 'deny' | 'allow_all' }
```

Host  -  `{ kind: 'approval_mode_changed', mode }`. `allow_all` is refused
unless the host was started with `AK_ALLOW_ALL_OK=1`.

#### `client:set_cwd`

```ts
{ sessionId: string; cwd: string }
```

Change the session's current working directory. Host validates the path
against the bound executor's sandbox before dispatching
`{ kind: 'cwd_changed', cwd }`. Subsequent `tool:call` payloads carry the new
`cwd`.

#### `client:set_model`

```ts
{ sessionId: string; model: string }
```

Override the model used for this session's LLM calls. Host echoes back
`session:model_changed` so all dashboards on the room show the new picker
value.

#### `client:rename_session`

```ts
{ sessionId: string; label: string }
```

Set (or clear, with an empty string) the operator-defined display label for
this session. Host appends a metadata entry to the JSONL log and broadcasts a
refreshed `server:sessions` payload so every dashboard picks up the new
label. When cleared, `SessionSummary.label` becomes undefined and the
Explorer falls back to `firstUserMessage`.

#### `client:delete_session`

```ts
{ sessionId: string }
```

Host removes the session from its in-memory map and unlinks the JSONL log
file. Broadcasts `server:session_deleted` and a refreshed `server:sessions`
listing. The socket is disconnected  -  dashboards subscribed to the room must
navigate away or open a new session.

#### `client:create_session`

```ts
{
  sessionId?: string          // Host generates a ULID if omitted
  workspaceId?: string        // executor to bind to
  workspaceName?: string      // display label snapshot
  cwd?: string                // initial working directory
  systemPrompt?: string
}
```

Host creates a fresh JSONL log with the header populated. If `cwd` is
provided it is validated against the executor's sandbox roots before it
becomes the session's `initialCwd` / initial `state.cwd`. Responds with
`session:ready` for the new sessionId; the dashboard MUST `emit('subscribe',
newSessionId)` after receiving the reply.

#### `client:list_dirs`

```ts
{
  requestId: string
  workspaceId: string         // executor to ask
  path?: string               // directory to list; defaults to first sandbox root
}
```

Powers the new-session Finder-style directory picker. Host forwards to the
executor as `fs:list_dirs` ( - 5.2) and returns the reply as `server:dir_list`.
Keyed by `workspaceId` because no session exists yet.

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

#### `client:list_executors`

```ts
{}
```

Request the currently-attached executors on this Host. Response: `server:executors` on the same socket.

#### `client:list_sessions`

```ts
{}
```

Request the sessions currently on this Host (JSONL logs under the Host's session directory). Response: `server:sessions`.

#### `client:load_history`

```ts
{
  sessionId: string
  sinceCursor?: number        // if omitted, return the full log from cursor 1
}
```

Request the historical timeline for a session. Response: `server:history` with the log entries. Dashboard fires this on `session:ready` so the timeline survives page reloads.

### 4.2 Host  -  Dashboard only (not executor)

#### `session:token_delta`

Streaming text token forwarded straight from the LLM adapter. UI-only  - 
dashboards concatenate deltas into a partial assistant row for the current
`thinking` turn. The event log is still authoritative through the final
`llm_response`; if a client misses deltas the timeline reconstructs the same
message from the log.

```ts
{
  sessionId: string
  text: string                 // one delta chunk
}
```

#### `session:model_changed`

Broadcast after Host applies a `client:set_model`. Dashboards use it to
sync the model picker across tabs viewing the same session.

```ts
{
  sessionId: string
  model: string
}
```

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

#### `server:message_queue`

Sent whenever the host's per-session delivery queue changes, and once after a
dashboard subscribes so reconnects show the current pending deliveries.

```ts
{
  sessionId: string
  pending: number
  items: Array<{
    id: string
    text: string
    mode: 'steer' | 'queue'
    createdAt: string
  }>
}
```

`pending` is a convenience mirror of `items.length`. `mode: 'steer'` items are
front-of-queue steering updates created while a turn was active; `mode: 'queue'`
items are follow-ups that wait until the active turn is done.

Dashboard resolves via `client:user_approve` or `client:user_reject`.

#### `usage:updated`

Convenience event; a projection of the running `state.usage` after each LLM response.

```ts
{
  sessionId: string
  usage: UsageTotal           // { inputTokens, outputTokens, costUsd }
}
```

#### `server:executors`

Response to `client:list_executors`.

```ts
{
  executors: Array<ExecutorAnnounce & { attachedAt: string }>
}
```

Each entry is the announcement payload the executor sent, plus the ISO-8601 timestamp Host recorded when the executor attached. Older executors omit the `hostname` / `os` / `ipAddresses` / `pid` / `startedAt` fields  -  the Dashboard falls back to `executorId` in that case.

#### `server:executor_changed`

Broadcast (not response-scoped) whenever an executor attaches, detaches, or re-announces. Executors are daemons  -  a change affects all sessions whose `workspaceName` matches or previously matched this executor.

```ts
// attached | updated:
{
  change: 'attached' | 'updated'
  executorId: string
  executor: ExecutorAnnounce & { attachedAt: string }
}
// detached:
{
  change: 'detached'
  executorId: string
  // no `executor` field  -  the executor is gone
}
```

`updated` fires when the same executor re-announces with different capabilities (e.g., after a reconnect).

#### `server:sessions`

Response to `client:list_sessions`. Also re-broadcast after
`client:rename_session` and `client:delete_session` so every dashboard's
Explorer stays in sync without individually re-issuing the list request.

```ts
{
  sessions: Array<{
    sessionId: string
    createdAt: string          // from JSONL header
    lastEventAt?: string       // ts of the last event line, if any
    eventCount: number
    parentSessionId?: string   // set if this session was forked
    workspaceId?: string       // routing key  -  matches an executor's announced workspaceId ( - 5.1). Undefined for legacy sessions.
    workspaceName?: string     // display label captured at session-create time. Not authoritative; the live executor's `workspaceName` is what the dashboard shows when one is attached.
    executorId?: string        // reserved for v2 (Host doesn't record which executor produced a tool_result in v1)
    status?: AgentState['status']  // last snapshot's status, if a snapshot exists
    currentCwd?: string        // folded `state.cwd`, if any. Displayed under the session row and used as the workbench cwd fallback before the live snapshot arrives.
    firstUserMessage?: string  // first ~120 chars of the first user_message; used as row label when no operator label is set
    label?: string             // operator-set display label from `client:rename_session`; takes precedence over `firstUserMessage`
  }>
}
```

Host derives these fields by reading each session's JSONL header + scanning events. The scan is `O(events)` per session; if a Host tracks many sessions this endpoint may want caching, but v1 reads on demand.

#### `server:history`

Response to `client:load_history`.

```ts
{
  sessionId: string
  entries: EventAppendedEvent[]   // same shape as live event:appended
}
```

Every entry has the same shape as a live `event:appended` payload  -  Dashboard can feed them into its timeline state the same way. Entries are ordered by `seq` ascending. Dashboard dedups by `seq` in case a live `event:appended` overlaps the tail of history.

#### `server:dir_list`

Response-scoped reply to `client:list_dirs`. Dashboard uses this to populate the new-session Finder-style directory picker before a session exists, so the request is keyed by `workspaceId` instead of `sessionId`.

```ts
{
  requestId: string
  workspaceId: string
  path: string              // resolved directory path that was listed, or the requested path on error
  roots: string[]           // executor sandbox roots visible to the picker
  entries: Array<{
    name: string
    path: string
  }>
  error?: string
}
```

#### `server:session_deleted`

Fires once after `client:delete_session` completes. Dashboards watching the
deleted session close their view and navigate away.

```ts
{ sessionId: string }
```

#### HTTP `GET /models`

Returns the host's current model registry. Models come from
`~/.claude/settings.json`, `~/.codex/config.toml`, legacy env fallback, and
manual entries in `~/.config/agent-kernel/models.json`.

```ts
type ModelInfo = {
  id: string
  label: string
  provider: string
  providerId?: string
  source?: 'claude-settings' | 'codex-config' | 'env' | 'manual'
  contextWindow?: number
}

{
  models: ModelInfo[]
  defaultModel: string
}
```

#### HTTP `GET /settings`

Returns a sanitized settings snapshot. API keys and helper command output are
never serialized. Provider credentials are still owned by the underlying Claude
Code / Codex / environment config; dashboard writes are limited to manual model
ids under existing providers.

```ts
{
  providers: Array<{
    id: string                // e.g. "anthropic", "newapi"
    label: string
    wire: 'anthropic' | 'openai'
    source?: 'claude-settings' | 'codex-config' | 'env' | 'manual'
    baseUrl?: string
    models: ModelInfo[]
  }>
  defaultModel: string
  paths: {
    claudeSettings: string
    codexConfig: string
    manualModels: string
    hooksConfig: string
    sessionsDir: string
  }
  hooks: Array<{ event: string; command: string; match?: string }>
  mcp: { supported: false; note: string }
}
```

#### HTTP `POST /settings/models`

Adds or updates a manual model id bound to an existing provider endpoint, then
returns the same payload as `GET /settings`.

```ts
{
  providerId: string
  id: string
  label?: string
  contextWindow?: number
}
```

#### HTTP `DELETE /settings/models?providerId=<id>&id=<model>`

Deletes a manual model entry, if present, then returns the same payload as
`GET /settings`. Auto-discovered models from Claude Code / Codex / env config
are read-only in this endpoint.

`ModelInfo.contextWindow` combined with `AgentConfig.contextLimit` drives the
Composer context usage ring. `ModelInfo.source` lets the dashboard distinguish
auto-discovered entries from manual ones.

---

## 5. Executor-specific events

Executor is a pure RPC responder. It receives commands from Host, executes them, and replies. It never originates state-changing events. **An executor is a daemon**: one process serves N sessions. It has no session binding at connect time; Host routes each `tool:call` to it based on the session's `workspaceName` (see  - 5.1).

### 5.1 Executor  -  Host (on connect)

#### `executor:announce`

Sent by executor immediately after the handshake succeeds. Declares the workspace this executor represents plus its capabilities and machine metadata (used by the Dashboard's Workspaces column).

```ts
{
  executorId: string          // client-generated stable id (usually a ULID)
  workspaceId: string         // REQUIRED. Stable ULID minted on the executor's first launch and persisted (default `~/.agent-kernel/workspace-id`). Sessions bind to this in their JSONL header (see event-log.md  - 3); Host routes `tool:call` by matching `session.workspaceId` against a live announce. Never renamed  -  a lost or regenerated id detaches the machine's existing sessions, which is why the executor refuses to boot with a corrupted id file.
  workspaceName: string       // REQUIRED. Human-readable display label. Free to change via `--name`  -  routing goes by workspaceId, not this. Falls back to `os.hostname()` when the operator doesn't pass a name.
  tools: string[]             // tool names this executor implements
  sandboxRoots?: string[]     // optional filesystem jail(s). Empty / omitted = executor trusts whole machine (defers to OS user permissions).
  workingDir?: string         // for logging/display only; NOT part of the workspace identity.
  runtime: 'node' | 'browser-webcontainer' | 'other'
  runtimeVersion: string
  // Machine metadata  -  all optional. An older executor that doesn't
  // populate these still works; the Dashboard falls back to executorId.
  hostname?: string           // os.hostname()
  os?: 'linux' | 'darwin' | 'win32' | 'other'  // normalized os.platform()
  ipAddresses?: string[]      // non-loopback, non-link-local IPv4/IPv6
  pid?: number                // process.pid
  startedAt?: string          // ISO-8601, executor process boot time
}
```

A workspace is a machine, not a directory. Two executor processes with the same `workspaceId` (rare  -  same user, same machine, same id file) are treated as replicas. `workspaceName` is display-only and free to change; if the same executor re-announces with a new name, the Dashboard picks up the new label but existing sessions stay bound via `workspaceId`.

Host stores the attach in a registry keyed by `executorId`. A second `executor:announce` from the same executorId replaces the first entry and fires `server:executor_changed { change: 'updated' }` ( - 4.2).

### 5.2 Host  -  Executor

#### `fs:list_dirs`

Host forwards `client:list_dirs` to the executor currently attached for the requested `workspaceId`. The executor resolves the requested path through its sandbox and returns directory entries only, sorted by name. The ACK payload is the same `DirListResult` shape emitted back to Dashboard as `server:dir_list`.

```ts
{
  requestId: string
  workspaceId: string
  path?: string
}
```

If `path` is omitted, executor lists its first sandbox root, falling back to `process.cwd()` when no roots are configured.

#### `tool:call`

Sent when the kernel emits a `call_tool` effect and Host has an executor connected for the session.

```ts
{
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string                // session's current working directory, copied from state.cwd. Executor merges it into the tool input as the default cwd.
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

Executor SHOULD attempt to interrupt the running tool. Executor MUST reply (via ACK or `executor:tool_result`) even if the tool had already completed  -  reply with `ok: false, content: 'cancelled'` in the ambiguous case.

### 5.3 Executor  -  Host (outside of a tool:call response)

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
| Dashboard | `client:cancel_stream` | Host (LLM adapter) |
| Dashboard | `client:compact` | Host (kernel) |
| Dashboard | `client:set_approval_mode` | Host (kernel) |
| Dashboard | `client:set_cwd` | Host (kernel) |
| Dashboard | `client:set_model` | Host (routing) |
| Dashboard | `client:rename_session` | Host (storage) |
| Dashboard | `client:delete_session` | Host (storage) |
| Dashboard | `client:create_session` | Host (storage) |
| Dashboard | `client:fork` | Host (kernel + storage) |
| Dashboard | `client:list_executors` | Host (routing) |
| Dashboard | `client:list_sessions` | Host (storage) |
| Dashboard | `client:list_dirs` | Host  -  Executor (`fs:list_dirs`) |
| Dashboard | `client:load_history` | Host (storage) |
| Dashboard | `subscribe` | Host (routing) |
| Executor | `executor:announce` | Host (routing) |
| Executor | ACK to `tool:call` | Host (kernel) |
| Executor | `executor:tool_result` | Host (kernel) |
| Host | `session:ready` | Dashboard OR Executor |
| Host | `session:token_delta` | Dashboard only |
| Host | `session:model_changed` | Dashboard only |
| Host | `state:changed` | All in room |
| Host | `event:appended` | All in room |
| Host | `session:error` | All in room |
| Host | `approval:required` | Dashboard only |
| Host | `usage:updated` | Dashboard only |
| Host | `server:executors` | Dashboard only (response) |
| Host | `server:executor_changed` | Dashboard only (broadcast) |
| Host | `server:sessions` | Dashboard only (response + broadcast) |
| Host | `server:session_deleted` | Dashboard only (broadcast) |
| Host | `server:history` | Dashboard only (response) |
| Host | `server:dir_list` | Dashboard only (response) |
| Host | `tool:call` | Executor only |
| Host | `tool:cancel` | Executor only |
| Host | `fs:list_dirs` | Executor only |

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

Host detects via Socket.IO `disconnect`. For every pending `call_tool` the disconnected executor was serving:
- Synthesize `tool_result(ok=false, content='executor disconnected')`
- Feed to kernel

The session moves forward. When a fresh executor announces with a matching `workspaceId` (typically the same daemon reconnecting after a restart  -  the persisted id file makes this stable), Host resumes routing to it for that workspace's sessions.

### 7.4 Dashboard disconnected

No kernel action needed. On reconnect and re-subscribe, Host sends `session:ready` with current state. Dashboard fires `client:load_history` after `session:ready` to rebuild the timeline (see  - 4.1). It MAY pass `sinceCursor` to limit the response to entries the tab hasn't seen.

### 7.5 LLM error

`llm_error` events happen inside Host (not from clients). Kernel enters `error` status; Host broadcasts `session:error` with `scope: 'llm'`. Clients decide UX (typically show a retry button that emits a fresh `user_message`).

---

## 8. Reconnection semantics

Socket.IO handles TCP-level reconnection. On reconnect:

1. Client re-sends handshake auth (Socket.IO does this automatically if `reconnection: true`).
2. Server calls `socket.join('session:...')` again.
3. Server emits `session:ready` with current state.
4. Dashboard fires `client:load_history` with the last seen `cursor` (or none, for a fresh tab). Host responds with `server:history`, and Dashboard merges the entries into its timeline (dedup by `seq`).

Executors don't need timeline replay on reconnect  -  they only care about `pendingCalls`, which Host redispatches from its in-memory registry.

---

## 9. Versioning and backward compatibility

The `clientVersion` field in handshake auth lets Host reject clients too old to speak the current protocol. Version bumps:

- **Patch** (e.g. `0.1.0`  -  `0.1.1`): documentation fixes, no wire change
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
   -  HandshakeAuth { sessionId: 's1', role: 'dashboard', clientVersion: '0.1.0' }
   -  session:ready { sessionId: 's1', cursor: 0, state: { - }, config: { - } }

User types "hi":
   -  client:user_message { sessionId: 's1', text: 'hi' }
   -  event:appended { seq: 1, event: { kind: 'user_message', text: 'hi' }, effects: [{ kind: 'call_llm', ... }] }
   -  state:changed { cursor: 1, state: {status: 'thinking',  - } }

Host calls Anthropic; response contains a tool_call for 'read':
   -  event:appended { seq: 2, event: { kind: 'llm_response', message: { - }, usage: { - } }, effects: [{ kind: 'call_tool', callId: 'c1', name: 'read',  -  }] }
   -  state:changed { cursor: 2, state: {status: 'executing_tools', pendingCalls: [{callId: 'c1', status: 'dispatched'}]} }

  (Executor was already announced. Host emits tool:call to it, waits for ACK.)

Executor replies via ACK:
  { callId: 'c1', ok: true, content: 'file contents - ' }
   -  event:appended { seq: 3, event: { kind: 'tool_result', callId: 'c1', ok: true, content: '...' }, effects: [{ kind: 'call_llm', ... }] }
   -  state:changed { cursor: 3, state: {status: 'thinking', pendingCalls: []} }

Host calls Anthropic again; plain text answer:
   -  event:appended { seq: 4, event: { kind: 'llm_response', message: { - } }, effects: [{ kind: 'finish' }] }
   -  state:changed { cursor: 4, state: {status: 'done'} }
   -  usage:updated { usage: { inputTokens: 352, outputTokens: 94, costUsd: 0 } }
```

This session yields 4 lines in the JSONL event log (see [event-log.md](event-log.md)  - 3).

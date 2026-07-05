# Architecture

**Status**: Normative for topology & responsibilities. Wire-level details live in [protocol/wire-protocol.md](protocol/wire-protocol.md); kernel-level details in [SPEC.md](SPEC.md).

---

## 1. The three processes

`agent-kernel` deploys as **three cooperating processes**. All three can run on one machine for local development; in production the split matters.

```
   ┌────────────────────────────────────────────────────────────────┐
   │  DASHBOARD  (React SPA — pure static, no backend)              │
   │    ─ Chat panel       ─ Inspector panel      ─ Replay UI       │
   └───────────────────────────┬────────────────────────────────────┘
                               │  Socket.IO (namespace: /dashboard)
                               ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  HOST  (Node.js, has public IP)                                │
   │                                                                │
   │    ┌──────────────────────┐   ┌──────────────────────┐         │
   │    │ Kernel               │   │ LLM Adapter          │         │
   │    │ (pure FSM step)      │   │ (Anthropic/OpenAI/…) │         │
   │    └──────────────────────┘   └──────────────────────┘         │
   │    ┌──────────────────────┐   ┌──────────────────────┐         │
   │    │ Host loop            │   │ Event log (JSONL)    │         │
   │    │ (consumes effects,   │   │  ~/.agent-kernel/    │         │
   │    │  dispatches events)  │   │   sessions/*.jsonl   │         │
   │    └──────────────────────┘   └──────────────────────┘         │
   │    ┌──────────────────────────────────────────────────┐        │
   │    │ Connection layer (Socket.IO server)              │        │
   │    │   namespaces:  /dashboard   /executor            │        │
   │    │   rooms:       session:<id>                      │        │
   │    └──────────────────────────────────────────────────┘        │
   └────────────────────────────┬───────────────────────────────────┘
                                │  Socket.IO (namespace: /executor)
                                │  ← executor dials OUT to host
                                ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  EXECUTOR  (Node daemon  OR  Browser WebContainer)             │
   │    ┌──────────────────────────────────────────────────┐        │
   │    │ Tool registry: read / write / edit / bash /      │        │
   │    │                grep / glob / ls                  │        │
   │    └──────────────────────────────────────────────────┘        │
   │    ┌──────────────────────────────────────────────────┐        │
   │    │ Sandbox (working directory whitelist)            │        │
   │    └──────────────────────────────────────────────────┘        │
   └────────────────────────────────────────────────────────────────┘
```

---

## 2. Process responsibilities

### 2.1 Kernel (library, not a process)

Lives inside Host as `@agent-kernel/kernel`. Pure function `step(state, event, config) → { next, effects }`. See [SPEC.md](SPEC.md).

**Not a process.** Do not deploy the kernel separately. It is a ~300 LOC pure-function library that Host imports.

### 2.2 Host

The only process with a **public IP** (or at least, reachable inbound by dashboard and executor).

**Responsibilities**:
- Own the kernel's `AgentState` for each active session (in-memory Map keyed by `sessionId`)
- Drive the FSM: pull events off an input queue, call `step`, dispatch resulting effects, feed responses back as events
- Talk to LLM providers via the LLM Adapter (translate `call_llm` effect → provider request → `llm_response` / `llm_error` event)
- Persist events to a JSONL log (append per `step` result)
- Broadcast state and events to subscribed dashboards; dispatch `call_tool` effects to a session's executor
- Serve two Socket.IO namespaces: `/dashboard` and `/executor`, rooms `session:<id>`

**Non-goals**:
- Does not implement tools directly (executor does)
- Does not host the Dashboard (that's a static SPA)
- Does not know about specific providers deeply — the LLM Adapter abstracts them

### 2.3 Executor

Lives close to the files it needs to touch. Dials **out** to Host via Socket.IO. Never accepts inbound connections.

**Two forms**:

1. **Local Node daemon**: user runs `agent-kernel-executor --host wss://host.example.com --session <id>`. Has access to a whitelisted working directory. Runs `bash`, `read`, `write`, etc. against the real filesystem.
2. **Browser WebContainer**: dashboard hosts an in-page executor via [WebContainer API](https://webcontainers.io/). Same tool implementations, but the filesystem is an in-memory vfs. Enables the "demo with just a URL" experience.

**Responsibilities**:
- On connect, `announce` its capabilities (which tool names it implements)
- Wait for `call_tool` messages, execute them, reply with `tool_result` (ok + content)
- Handle `cancel` messages targeting a specific `callId`

**Non-goals**:
- No LLM knowledge
- No agent state
- No approval logic (approval happens in kernel via `request_approval` effect)

### 2.4 Dashboard

React SPA. Pure static assets. Deployed to Vercel / GitHub Pages / any object storage.

**Responsibilities**:
- Connect to Host via Socket.IO (`/dashboard` namespace) with a `sessionId` and role
- Show the chat transcript, the inspector, the event timeline, the replay/fork UI
- Send user events (`user_message`, `user_approve`, `user_reject`, `cancel`) to Host

**Non-goals**:
- Never talks to Executor directly
- Never talks to LLM providers directly
- Never runs tool code

---

## 3. Turn lifecycle

The clearest way to understand the system is to trace one end-to-end turn.

**Scenario**: User asks "Read `/tmp/notes.md` and tell me what's in it."

### 3.1 Sequence diagram

```
Dashboard          Host (loop + kernel)               LLM               Executor
    │                        │                         │                    │
    │ ── user_message ─────► │                         │                    │
    │                        │ step(idle, user_message)                     │
    │                        │   → status: thinking                         │
    │                        │   → effect: call_llm                         │
    │ ◄─ state:thinking ──── │                                              │
    │                        │ ── request(messages, tools) ───────────────► │
    │                        │                                              │
    │                        │ ◄──── response(text? tool_calls?) ────────── │
    │                        │ step(thinking, llm_response)                 │
    │                        │   → append assistant msg (with tool_call)    │
    │                        │   → pending: [read/dispatched]               │
    │                        │   → status: executing_tools                  │
    │                        │   → effect: call_tool                        │
    │ ◄─ state:exec ──────── │                                              │
    │                        │ ── call_tool(read, {path: /tmp/notes.md}) ─────────────► │
    │                        │                                                          │
    │                        │ ◄─────────────── tool_result(ok, "…contents…") ───────── │
    │                        │ step(executing, tool_result)                 │
    │                        │   → append tool msg                          │
    │                        │   → pending: []                              │
    │                        │   → status: thinking                         │
    │                        │   → effect: call_llm                         │
    │ ◄─ state:thinking ──── │                                              │
    │                        │ ── request(messages incl. tool_result) ────► │
    │                        │                                              │
    │                        │ ◄──── response("The file says…") ─────────── │
    │                        │ step(thinking, llm_response)                 │
    │                        │   → append assistant msg (text only)         │
    │                        │   → status: done                             │
    │                        │   → effect: finish                           │
    │ ◄─ state:done ──────── │                                              │
```

### 3.2 Event log after this turn

The event log (see [event-log.md](protocol/event-log.md)) records every `step` input. For the above turn:

```jsonl
{"seq":1,"ts":"...","event":{"kind":"user_message","text":"Read /tmp/notes.md and tell me what's in it."}}
{"seq":2,"ts":"...","event":{"kind":"llm_response","message":{"role":"assistant","content":[{"type":"tool_call","callId":"c1","name":"read","input":{"path":"/tmp/notes.md"}}]},"usage":{"inputTokens":142,"outputTokens":38}}}
{"seq":3,"ts":"...","event":{"kind":"tool_result","callId":"c1","ok":true,"content":"..."}}
{"seq":4,"ts":"...","event":{"kind":"llm_response","message":{"role":"assistant","content":[{"type":"text","text":"The file says…"}]},"usage":{"inputTokens":210,"outputTokens":56}}}
```

**Given these four events + the session's `AgentConfig`, `fold` reproduces the exact final state.** This is the replayability guarantee.

### 3.3 Adding an approval gate

If the user had asked "Delete `/tmp/notes.md`" and the `bash` tool has `requiresApproval: true`, the middle of the sequence becomes:

```
    │                        │ step(thinking, llm_response with tool_call bash)
    │                        │   → pending: [bash/awaiting_approval]
    │                        │   → status: awaiting_approval
    │                        │   → effect: request_approval
    │ ◄─ state:awaiting_approval + approval UI ─
    │
    │ ── user_approve ─────► │
    │                        │ step(awaiting_approval, user_approve)
    │                        │   → pending: [bash/dispatched]
    │                        │   → status: executing_tools
    │                        │   → effect: call_tool
    │                        │ ── call_tool(bash) ───────────────────► executor
```

`user_reject` is symmetric but synthesizes a `tool_result(ok=false, content=reason)` and skips the executor round-trip.

---

## 4. Data flow patterns

### 4.1 Effects are commands, events are facts

- **Effect** (`call_llm`, `call_tool`, `request_approval`, `finish`, `emit_error`): kernel says "I need this to happen".
- **Event** (`llm_response`, `tool_result`, `user_approve`, `user_reject`): host says "this happened".

Every effect that changes downstream state produces at least one event that feeds back into the kernel. Effects that don't produce events (`finish`, `emit_error`) are pure notifications — nothing else to do.

### 4.2 Broadcast vs. dispatch

- **Broadcast to Dashboard** (`state:changed`, `event:appended`): Host pushes state updates to all dashboards subscribed to a session. One-to-many.
- **Dispatch to Executor** (`call_tool`, `cancel`): Host sends to exactly one executor for the session. Uses Socket.IO ACK to correlate the response with the `callId`.

### 4.3 Multi-executor (future)

A session may have multiple executors — e.g. a local daemon for `bash` and a browser vfs for `read`/`write`. Routing happens by tool name → executor mapping, tracked in Host.

**Not in v1**. The protocol has room for it (`executorId` in `tool_call` payload), but v1 supports one executor per session.

---

## 5. Failure modes and recovery

| What fails | Detection | Recovery |
|---|---|---|
| LLM API returns 5xx / timeout | LLM Adapter | Emit `llm_error` event → kernel → `error` status. Host may replace state (retry policy is host-owned) |
| Tool execution throws | Executor | Reply with `tool_result(ok=false, content=<error>)`. Kernel treats as normal tool result |
| Executor disconnects mid-call | Socket.IO ACK timeout | Host synthesizes `tool_result(ok=false, content="executor disconnected")` |
| Dashboard disconnects | Socket.IO reconnect | On reconnect, Host sends the full current state + a stream of events since last-seen `cursor` |
| Host crashes | External (systemd / process manager) | Restart. Replay from JSONL event log to reconstruct in-memory state |
| Kernel bug | Would surface as an invariant violation in tests | Fix, ship, replay is safe because event log is unchanged |

**Guarantee**: as long as the event log survives, the session survives. Nothing else is authoritative.

---

## 6. Storage model

### 6.1 Sessions on disk

```
~/.agent-kernel/
├── config.json                        # user config: default provider, tokens, executor URL
└── sessions/
    ├── 2026-07-04T17-30-15_s1.jsonl   # per-session event log
    ├── 2026-07-04T18-01-02_s2.jsonl
    └── snapshots/
        └── s1_cursor_100.json         # optional state snapshots for fast replay
```

**Naming**: `<iso-timestamp>_<sessionId>.jsonl`. Sortable by creation time. Session IDs are host-generated ULIDs.

**Snapshots**: purely a performance optimization. A snapshot is a JSON dump of `AgentState` at a given cursor. Replay can start from the nearest snapshot instead of the beginning of the log. Deleting snapshots is always safe.

### 6.2 What's in memory

Host keeps a `Map<sessionId, { state: AgentState, config: AgentConfig }>` for active sessions. Inactive sessions may be evicted; a fresh `user_message` triggers a load-from-log.

---

## 7. Local vs cloud deployment

The topology is the same. What changes is **who has the public IP**.

**Local dev** (everything on your laptop):
- Host listens on `localhost:3000`
- Executor connects to `ws://localhost:3000/executor`
- Dashboard served at `http://localhost:5288` (vite dev, `/socket.io` proxied to host), connects to `ws://localhost:3000/dashboard`
- One `pnpm dev` starts all three.

**Cloud + local executor** (the differentiating deployment):
- Host deployed to Fly.io / Railway, reachable at `wss://host.example.com`
- Executor runs on your laptop, dials out: `agent-kernel-executor --host wss://host.example.com --session <id>`
- Dashboard hosted static (Vercel), served at `https://app.example.com`, connects to `wss://host.example.com/dashboard`
- The laptop needs **no inbound port**. It creates the outbound WS. This is the NAT/firewall workaround baked in.

**Full cloud** (demo with just a URL):
- Host + Dashboard as above
- Executor runs in the browser via WebContainer, no local install
- Only meaningful for demos / disposable sandboxes

---

## 8. Design decisions cross-reference

Every non-obvious topology choice above has an ADR:

| Choice | ADR |
|---|---|
| Kernel as pure reducer | [ADR 0001](adr/0001-pure-reducer.md) |
| Executor dials out to Host (reverse-WS) | [ADR 0002](adr/0002-reverse-websocket.md) |
| Socket.IO over raw WS / gRPC / SSE | [ADR 0003](adr/0003-socket-io.md) |
| Config separated from state | [ADR 0004](adr/0004-config-state-separation.md) |
| Planning / memory / subagents outside kernel | [ADR 0005](adr/0005-kernel-boundary.md) |
| No independent relay process in v1 | [ADR 0006](adr/0006-no-relay-process.md) |

---

## 9. Implementation Update (2026-07-05)

Batch A is implemented in the running codebase:

- Host streams LLM deltas as `session:token_delta` and supports cancel-in-flight via `client:cancel_stream`. The log still records one final `llm_response`.
- Host handles manual/auto compaction by summarizing with the LLM and recording `compact_replaced`.
- Store load recovers stuck pending tool calls after host restart by appending synthetic failed `tool_result` events.
- Approval mode lives in kernel state and is changed by `client:set_approval_mode`; host guards `allow_all` with `AK_ALLOW_ALL_OK=1`.
- Image content is supported in kernel types, Anthropic/OpenAI adapters, and dashboard rendering.
- `agent` is a host-side builtin tool that creates a child JSONL session, runs it in the same workspace, and returns the child assistant text to the parent.
- MCP is currently a stub only: `McpServerConfig` plus `initMcp()` returning no tools.
- Session cwd is changed by `client:set_cwd`, stored as `state.cwd`, and passed to executor tool calls.
- Background shell is executor-owned: `bash { run_in_background: true }` starts a task, `bash_output` polls logs, and `kill_shell` stops it.
- Dashboard state chips moved from Inspector into the Composer footer.

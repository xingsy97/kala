# MCP Runtime Integration Design

**Status**: planned, not yet implemented
**Owner**: TBD

---

## 1. What is MCP?

Model Context Protocol is Anthropic's standard for attaching third-party tools to LLM applications. In this project, the executor would act as the MCP client. It starts MCP server subprocesses over stdio, speaks JSON-RPC 2.0, calls `tools/list` to discover available tools, and invokes a tool through `tools/call`.

The ecosystem already includes official and community servers for filesystem, git, sqlite, postgres, memory, fetch, Slack, Notion, Jira, Linear, GitHub, GitLab, Google Drive, and similar integrations.

The value of MCP is leverage: one runtime integration lets users add many ecosystem capabilities without writing each integration by hand.

---

## 2. Why Runtime Support Is Deferred

This project already covers most coding-agent workflows with built-in tools: `read`, `write`, `edit`, `bash`, `grep`, `web_search`, `todo_graph`, and `agent`. MCP's strongest marginal value is in non-local integrations such as Slack, Notion, and Jira. Those are useful, but they are not the core reference coding-agent path.

This document exists because the design choices are already settled. Future implementation should follow the checklist below rather than reopen the architecture discussion.

---

## 3. Architecture

The MCP client belongs in the executor, not the host.

```text
Dashboard ──Socket.IO──> Host ──tool:call──> Executor ──stdio──> MCP server
                                 ▲             ▲
                                 │             └─ builtin tools live here too
                                 └─ kernel only sees normal tool effects/results
```

Reasons:

- MCP servers are usually local processes. They belong beside filesystem tools.
- A cloud-hosted host spawning user-local processes would violate the reverse-WebSocket architecture.
- MCP tools and built-in tools use the same `tool:call` path. Host, kernel, and dashboard do not need to know that a tool came from MCP.
- Executor and MCP subprocesses share lifecycle. If the executor exits, it terminates its MCP children. If an MCP server crashes, only that executor's MCP tool set is affected.

---

## 4. Locked Design Decisions

### 4.1 Configuration source: executor CLI and environment

MCP server declarations live next to executor sandbox roots, through CLI arguments or environment variables.

Example CLI shape:

```bash
agent-kernel-executor \
  --host http://localhost:3000 \
  --sandbox-root /workspace/project \
  --mcp filesystem='npx -y @modelcontextprotocol/server-filesystem /workspace/project' \
  --mcp git='npx -y @modelcontextprotocol/server-git --repository /workspace/project'
```

Example environment shape:

```bash
MCP_SERVERS="filesystem=npx -y @modelcontextprotocol/server-filesystem /workspace/project;git=npx -y @modelcontextprotocol/server-git --repository /workspace/project"
```

Secrets are passed through the server command, for example `--mcp linear='npx -y @linear/mcp-server --token=$LINEAR_TOKEN'`. The executor treats the command as configuration and does not parse or broker the secret itself.

Why this belongs in executor config:

- MCP server lifecycle is tied to executor lifecycle.
- Kernel config and wire protocol stay clean.
- Multiple executors on one machine can expose different MCP servers.
- Per-session dynamic server start/stop can be added later through a wire event if absolutely needed, but the default path is startup-time configuration.

### 4.2 Naming conflicts: prefix every MCP tool

Every MCP tool announced by an MCP server is prefixed as `<server_name>__<tool_name>`.

Examples:

- MCP server `filesystem` declares `read_file` and `write_file`; executor announces `filesystem__read_file` and `filesystem__write_file`.
- MCP server `git` declares `commit` and `diff`; executor announces `git__commit` and `git__diff`.
- Built-in `read` remains `read`.

Use `__` rather than `.`, `/`, or `:` because model provider tool-name constraints generally fit `[A-Za-z0-9_-]+` better than path-like separators.

The prefixing layer is implemented in the executor. The executor prefixes names after `tools/list`, stores wrapped tools in its registry, and strips the prefix before routing `tools/call` back to the right MCP client. Host, kernel, and dashboard see only the final tool name.

This avoids collision errors when users add new MCP servers.

### 4.3 Approval: same policy as built-ins

MCP tools use the same `approvalMode` as built-in tools.

| approvalMode | Built-in behavior | MCP behavior |
|---|---|---|
| `auto` | no approval | no approval |
| `ask` | ask every call | ask every call |
| `deny` | disallow calls | disallow calls |
| `allow_all` | no approval, guarded by `AK_ALLOW_ALL_OK=1` | no approval, guarded by `AK_ALLOW_ALL_OK=1` |

Do not add an MCP-specific approval tier. The server-trust decision happens when the operator starts the executor with `--mcp`. Runtime approval is a per-call confirmation and should not branch by source.

Built-in `edit` and `write` can show diffs because the runtime understands their semantics. Generic MCP tools should show `{ tool_name, input_json }` in approval UI because the executor cannot know whether a server-specific call mutates external state. Operators should use `ask` for dangerous MCP servers such as writable databases.

---

## 5. Dependency Choice

Use the official TypeScript SDK client pieces from `@modelcontextprotocol/sdk`, especially `Client` and `StdioClientTransport`.

Reasons:

- MCP protocol details continue to evolve, including capability negotiation and versioning.
- Stdio framing, initialize handshake, notifications, and request classification are easy to get subtly wrong.
- The dependency is isolated to `packages/executor`; host, dashboard, and kernel are unaffected.
- A minimal handwritten implementation would be short initially but more expensive to maintain.

---

## 6. Runtime Lifecycle

### Startup

Executor startup adds one phase before `executor:announce`:

1. Parse MCP server declarations from CLI/env.
2. Spawn each server subprocess.
3. Run MCP initialize handshake.
4. Call `tools/list`.
5. Prefix tool names.
6. Register built-in tools plus MCP tools.
7. Announce the combined tool catalog.

### Shutdown

Executor `close()`, SIGTERM, or process exit should:

1. Close all MCP clients.
2. Send SIGTERM to subprocesses.
3. Send SIGKILL to subprocesses still running after a grace period.
4. Close the socket.

### Server crash

If an MCP server exits unexpectedly:

1. Any in-flight call for that server fails with an explicit error.
2. That server's tools are removed from the registry.
3. Executor re-announces its tool catalog.
4. The server is not automatically restarted; the operator should see the failure and decide whether to restart the executor.

### Slow start

Initialization should have a timeout, for example 30 seconds per server. A slow MCP server should be skipped without blocking other MCP servers or built-in tools.

---

## 7. Error Handling

- `tools/call` server error -> failed tool result with an `MCPERR`-style message.
- `tools/call` timeout -> failed tool result with an explicit timeout message.
- User cancellation -> discard the MCP result from the host/dashboard perspective. Do not rely on MCP cancellation notifications because many servers do not support them reliably.

Timeout defaults should be conservative and eventually configurable per tool/server. Avoid hardcoding a global executor timeout that affects long-running legitimate work.

---

## 8. Non-Goals

Do not implement these in the first runtime integration:

- MCP sampling, where the server calls back into our LLM.
- MCP resources or prompts primitives.
- SSE or HTTP streaming transports.
- Dynamic MCP server add/remove during one executor lifetime.
- Custom credential brokerage.
- Forwarding MCP progress notifications to dashboard.

---

## 9. Implementation Checklist

- [ ] Add `@modelcontextprotocol/sdk` to `packages/executor/package.json`.
- [ ] Add `packages/executor/src/mcp/client.ts` exporting `startMcpClients({ servers })`.
- [ ] Implement tool-name prefixing and reverse routing.
- [ ] Merge built-in and MCP tools in executor startup.
- [ ] Add `--mcp <name>=<cmd>` repeatable CLI parsing.
- [ ] Add `MCP_SERVERS` env parsing.
- [ ] Add fixture MCP server tests for `tools/list` and `tools/call`.
- [ ] Test name collision handling.
- [ ] Test server crash cleanup and re-announce.
- [ ] Test executor shutdown terminates subprocesses.
- [ ] Surface MCP tool origin in executor metadata if dashboard needs to group tools later.
- [ ] Update executor README and tool documentation.

---

## 10. Boundary Rule

MCP is an executor capability. Kernel events, kernel state, and host session semantics should remain unchanged. From the agent protocol perspective, an MCP tool call is just another tool call.

# ADR 0007: Tools use MCP-compatible schemas

**Status**: accepted
**Date**: 2026-07-04

## Context

Every coding-agent project defines its own tool schema: input shape, output shape, error convention, discovery mechanism. Historically these were bespoke — Claude Code's tools look nothing like Codex's, which look nothing like opencode's.

In late 2024 Anthropic published the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), a JSON-Schema-based standard for describing tools and a transport-agnostic call convention (`tools/list`, `tools/call`). It's now supported natively by Claude Desktop, Claude Code, and a growing list of clients (Cursor, Zed, some IDE plugins).

For `agent-kernel`, this raised a question: define our own tool schema, or align with MCP?

## Decision

**Tool input/output schemas conform to MCP conventions.** Specifically:

- Tool schemas in [`docs/executor/tools.md`](../../executor/tools.md) are expressed as JSON Schema, matching MCP's `Tool` type.
- The Executor's `tool:call` / `tool:result` semantics (name + arguments in, structured content out) map 1-to-1 onto MCP's `tools/call` semantics.
- **Transport is our own** — Socket.IO over the reverse-WebSocket described in [ADR 0002](0002-reverse-websocket.md), not MCP's stdio or SSE transports. We're MCP-compatible at the *schema* layer, not the wire layer.

Consequence: it should be a small amount of adapter code (not a rewrite) to expose the Executor as an MCP server for stdio clients, or to consume third-party MCP servers as if they were Executor tools.

## Alternatives considered

**Invent our own schema.**

*Rejected*. Nothing to gain, real costs: users can't easily reuse tools they've already written for MCP; we can't easily consume the growing ecosystem of MCP servers; the project has to justify a bespoke standard.

**Adopt MCP fully, transport included** (stdio / SSE).

*Rejected*. MCP's stdio transport is not a good fit for the browser-executor scenario (WebContainer, [ADR 0002](0002-reverse-websocket.md)); its SSE transport doesn't handle reconnection as cleanly as Socket.IO ([ADR 0003](0003-socket-io.md)). We keep our own transport and only adopt what buys us ecosystem — the schema.

**Adopt MCP but hide it as an implementation detail.**

*Rejected*. The interoperability is worth surfacing. Someone reading `docs/executor/tools.md` benefits from noticing "these are MCP tools" — it makes the shape obvious and the ecosystem accessible.

## Consequences

**Good**:
- Executor can, with a small stdio adapter, be launched by any MCP client (Claude Desktop, Cursor, VS Code). We haven't built the shim in v1, but the design leaves it as a one-file addition, not a redesign.
- Third-party MCP servers can be plugged in as tool providers with a thin translation layer at the Executor.
- Documenting tools is less work — we point at MCP's spec for the schema conventions instead of re-deriving them.
- "This is MCP-compatible" is a legible signal in a competitive landscape where interop matters.

**Bad**:
- We inherit MCP's design decisions, some of which are quirky (e.g., content blocks vs. plain strings for tool output). We express those choices in our schemas even where a simpler shape would suffice.
- If MCP evolves in a breaking way, `agent-kernel` has a small compatibility problem to track. Mitigation: pin to a stated MCP version in `docs/executor/tools.md` and only bump deliberately.

## Verification

- `docs/executor/tools.md` §Tool schemas is expressed in JSON Schema matching MCP's `Tool` type.
- If a future PR introduces a tool with a bespoke schema shape that doesn't fit MCP, that PR should either (a) round-trip the shape through MCP conventions or (b) update this ADR with an argued exception.

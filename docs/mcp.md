# MCP Runtime Integration Design
  
  **Status**: planned, not yet implemented
  **Owner**: TBD
  
  ## 1. What is MCP?
  
  Model Context Protocol is a standard for attaching third-party tools to an LLM application. In this project, the executor would act as an MCP client. It starts MCP server subprocesses over stdio, speaks JSON-RPC 2.0, calls `tools/list`, and invokes tools through `tools/call`.
  
  MCP has official and community servers for filesystem, git, sqlite, postgres, memory, fetch, Slack, Notion, Jira, Linear, GitHub, GitLab, Google Drive, and similar integrations. The value is that one runtime integration can unlock many external capabilities without writing each integration by hand.
  
  ## 2. Why Runtime Support Is Deferred
  
  The current built-in tool surface already covers most coding-agent workflows: `read`, `write`, `edit`, `bash`, `grep`, `web_search`, `todowrite`, and `agent`. MCP is most valuable for non-local integrations, which are not the core reference use case for this project today.
  
  This document exists because the major design decisions are already settled. Future implementation should follow the checklist rather than reopen the architecture discussion.
  
  ## 3. Architecture Fit
  
  The MCP client belongs in the executor, not the host. MCP servers are usually local processes and naturally sit beside filesystem tools. Letting a cloud-hosted host spawn local user processes would break the reverse-WebSocket architecture. From host, kernel, and dashboard perspectives, MCP tools are just extra executor-announced tool names.
  
  ## 4. Locked Design Decisions
  
  ### Configuration Source
  
  MCP servers are configured through executor CLI arguments or environment variables, next to sandbox roots. They do not belong in kernel config or the wire protocol. Each executor owns its own MCP server set.
  
  ### Tool Naming
  
  Every MCP tool name is prefixed as `<server_name>__<tool_name>`. For example, `filesystem` server tool `read_file` becomes `filesystem__read_file`. Built-in tools keep their names. The executor strips the prefix when routing calls back to the correct MCP client.
  
  ### Approval
  
  MCP tools use the same approval mode as built-in tools. `auto`, `ask`, `deny`, and `allow_all` have the same meaning for both sources. The trust decision for connecting a server happens at executor startup; per-call approval is a separate runtime confirmation.
  
  ## 5. Dependency Choice
  
  Use the official TypeScript SDK client pieces from `@modelcontextprotocol/sdk`, specifically `Client` and `StdioClientTransport`. The dependency belongs only in `packages/executor`.
  
  ## 6. Lifecycle
  
  Startup parses server declarations, spawns each subprocess, initializes the MCP client, reads `tools/list`, prefixes tool names, and announces built-ins plus MCP tools. Shutdown closes clients and terminates subprocesses, with a forced kill after a grace period.
  
  If a server crashes during a call, the in-flight call fails, that server's tools are removed from the registry, and the executor re-announces its updated tool list. Slow initialization should time out without blocking other servers or built-in tools.
  
  ## 7. Error Handling
  
  Server errors become failed tool results. Timeouts become explicit timeout failures. Cancellation discards the result from the dashboard/host perspective; most MCP servers cannot be reliably cancelled mid-call.
  
  ## 8. Non-Goals
  
  Do not implement MCP sampling, resources, prompts, HTTP/SSE transports, dynamic server add/remove, custom credential brokerage, or dashboard forwarding of MCP progress notifications in the first runtime implementation.
  
  ## 9. Implementation Checklist
  
  Add the SDK dependency to executor, implement `startMcpClients`, prefix and register MCP tools, merge them into `startExecutor`, add CLI/env parsing, add fixture MCP server tests, cover crash and shutdown behavior, surface MCP support metadata, update dashboard settings visibility, and update executor/tool documentation.
  
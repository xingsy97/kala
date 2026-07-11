# Feature Gap Analysis: agent-kernel vs Reference Coding Agents
  
  This document compares `agent-kernel` with local reference checkouts under `references/`, including pi, opencode, codex, claude-code-collection, and azure-code-agent-hub-pr879. It records what exists, what is missing, and what is intentionally out of scope.
  
  ## 1. Implemented Capabilities
  
  - Context compaction: host-owned token pressure tracking, LLM summarization, deterministic `messages_replaced` events, artifacts for compaction request/response/report, manual `/compact`, pressure UI, and hard/preflight compaction.
  - Sub-agent dispatch: `agent` is a host-side built-in tool that opens child JSONL sessions in the same workspace and returns the child assistant result as the parent `tool_result`.
  - Session resume and fork: fork creates independent JSONL logs; resume replays history and repairs interrupted approval/tool/thinking states.
  - Approval modes: `auto`, `ask`, `deny`, and `allow_all`, with an environment guard for `allow_all`.
  - Precise edit tooling: exact string replacement, `replace_all`, and approval diff rendering for `edit` and `write`.
  - TODO tracking: `todowrite` remains a normal executor tool; dashboard derives Tasks UI from trace data.
  - Token and context accounting: usage tracking and context pressure UI without displaying monetary cost.
  - Multi-model support: Anthropic Messages API and OpenAI-compatible adapters, imported provider/model lists, and dashboard model management.
  - Streaming UX: SSE token deltas, dashboard incremental rendering, and cancellation.
  - Built-in web search: executor-side DuckDuckGo HTML search with bounded snippets.
  - Image input: image message content, provider adapters, dashboard thumbnails, and paste support.
  - User-message edit and rerun: edit opens a fork from the selected cursor.
  - Session rename and metadata dialogs.
  - Session creation UI with workspace selection, Finder-style cwd picker, and model selection.
  - Session cwd editing with executor-side sandbox validation.
  - Background shell support through normal `bash`, `bash_output`, and `kill_shell` tool results.
  - Light/dark theme support.
  - Host hooks for pre/post tool and session lifecycle commands.
  - Anthropic extended thinking and prompt caching support.
  - Three-layer memory: session, workspace, and global scopes through one `memory` tool.
  
  ## 2. Explicit Non-Goals
  
  The project does not currently target command-history navigation, fuzzy `@file` selection, monetary-cost footer display, extra slash commands, multi-provider fallback, TUI/IDE integrations, plugin APIs, implicit CLAUDE.md injection, a separate `web_fetch` tool, SaaS multi-user platformization, or end-to-end encryption of live kernel state.
  
  ## 3. Planned Work
  
  ### MCP Runtime
  
  The design is settled but implementation is deferred. MCP server configuration belongs to executor CLI/environment configuration, tool names are prefixed as `<server_name>__<tool_name>`, MCP tools use the same approval mode as built-ins, and the official `@modelcontextprotocol/sdk` client should be used in the executor package only.
  
  ### Core Boundary Cleanup
  
  The kernel should remain a pure reducer, host should own orchestration and policy, executor should own tool execution, and dashboard should observe and present state. Large dashboard composition files should continue to split into smaller hooks and components. Provider HTTP trace data should remain metadata/debug data rather than reducer state.
  
  ## 4. Comparison Notes
  
  The project is strong on pure reducer boundaries, reverse executor connectivity, JSONL event logs, fork/replay, approval modes, sub-agents, context compaction, image input, themes, hooks, extended thinking, prompt caching, and scoped memory. MCP runtime is still deferred.
  
  ## 5. Reference Audit Notes
  
  Potential future ideas include structured provider failover errors, head-and-tail tool-result truncation, preemptive compaction for large tool results, host-side loop detection, and typed turn retry state. Persistent sub-agent registries and multi-provider advisor loops are not currently aligned with this project's replay-focused, self-hosted coding-agent scope.
  
# Feature-Gap translated historical texttranslated historical text: agent-kernel vs translated historical texttranslated historical texttranslated historical texttranslated historical text Agent

_translated historical texttranslated historical texttranslated historical texttranslated historical text: 2026-07-06。translated historical texttranslated historical texttranslated historical texttranslated historical text: `references/` translated historical texttranslated historical texttranslated historical texttranslated historical text checkout —— pi、opencode、codex、claude-code-collection、azure-code-agent-hub-pr879。_

## translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text)

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text:

### 🔥 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

1. **websearch translated historical texttranslated historical text**(translated historical texttranslated historical text #147)—— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,**translated historical texttranslated historical text Serper**。
2. **Hooks translated historical texttranslated historical text** —— #130
3. **Extended thinking** —— #80
4. **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text** —— #152
5. **Diff translated historical texttranslated historical text** —— #148
6. **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text + translated historical texttranslated historical text** —— #127
7. **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text UI** —— #126
8. **translated historical texttranslated historical texttranslated historical texttranslated historical text UI** —— #128
9. **Compact translated historical texttranslated historical texttranslated historical texttranslated historical text**(B1 translated historical texttranslated historical text)

### ❓ translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

- **Prompt caching**(#149)—— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- **Settings UI**(#131)—— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- **webfetch**(#147 translated historical texttranslated historical texttranslated historical texttranslated historical text)—— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text websearch。

### 💤 translated historical texttranslated historical texttranslated historical texttranslated historical text

- translated historical texttranslated historical texttranslated historical texttranslated historical text ↑ translated historical text(#146)
- `@file` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(#129)
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(#132)
- translated historical texttranslated historical texttranslated historical texttranslated historical text footer(#151)
- Batch B gate(#134)
- translated historical text workspace E2E(#100)
- translated historical texttranslated historical text slash commands
- MCP translated historical texttranslated historical texttranslated historical text
- translated historical text provider fallback
- TUI、IDE translated historical texttranslated historical text、OAuth、translated historical texttranslated historical text API
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text / CLAUDE.md translated historical texttranslated historical text

---

## translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

### 1. websearch(translated historical texttranslated historical text API translated historical text)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** executor translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `websearch(query, limit?)`,translated historical text
LLM translated historical texttranslated historical texttranslated historical texttranslated historical text。**translated historical texttranslated historical text Serper**(Serper translated historical texttranslated historical texttranslated historical text API key)。translated historical texttranslated historical texttranslated historical texttranslated historical text API,translated historical texttranslated historical text
DuckDuckGo translated historical text Instant Answer API translated historical text HTML translated historical texttranslated historical text。translated historical texttranslated historical text top N translated historical text `{ title, url,
snippet }` translated historical texttranslated historical texttranslated historical text LLM。

**translated historical texttranslated historical text:** translated historical texttranslated historical texttranslated historical text `packages/executor/src/tools/websearch.ts`,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,
`requiresApproval: false`。translated historical text `fetch` translated historical text DuckDuckGo,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。executor
`announce` translated historical texttranslated historical texttranslated historical text tools translated historical texttranslated historical text。

**translated historical texttranslated historical text:** translated historical texttranslated historical text 15s,limit translated historical texttranslated historical text 5 translated historical texttranslated historical text 10;translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text 500 translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical text;translated historical texttranslated historical texttranslated historical texttranslated historical text `{ ok: false, content: 'error message' }` translated historical text LLM translated historical texttranslated historical texttranslated historical text。

### 2. Hooks translated historical texttranslated historical text(#130)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** translated historical texttranslated historical texttranslated historical text `~/.config/agent-kernel/config.toml` translated historical texttranslated historical texttranslated historical text"translated historical text
translated historical texttranslated historical text X translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text Y translated historical texttranslated historical text"。translated historical texttranslated historical texttranslated historical texttranslated historical text: `pre_tool_use`、`post_tool_use`、
`session_start`、`session_end`。host translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text hook translated historical texttranslated historical text,spawn translated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text
stdin translated historical text JSON payload,translated historical text stdout translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `pre_tool_use` translated historical texttranslated historical texttranslated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical text(host translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text tool_result translated historical texttranslated historical text)。translated historical texttranslated historical text git hooks。

**translated historical texttranslated historical text:**
- `~/.config/agent-kernel/config.toml` translated historical texttranslated historical texttranslated historical texttranslated historical text `[[hooks]]` translated historical texttranslated historical texttranslated historical text。
- `runtime-config.ts` translated historical texttranslated historical text hooks translated historical texttranslated historical texttranslated historical texttranslated historical text runtime config。
- host loop translated historical texttranslated historical text `dispatchTool` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text hook translated historical texttranslated historical texttranslated historical text,`createSession` /
  `closeSession` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical text hook translated historical texttranslated historical texttranslated historical text spawn translated historical texttranslated historical texttranslated historical text,stdin translated historical text JSON,15s translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text hook translated historical texttranslated historical text。

### 3. Extended thinking(#80)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** Anthropic translated historical text `thinking` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `type: 'thinking'`
translated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical text)。adapter translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `state.messages`,kernel translated historical texttranslated historical texttranslated historical text opaque
content translated historical texttranslated historical text。UI translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

**translated historical texttranslated historical text:**
- `packages/kernel/src/types.ts` translated historical text `ThinkingContent` translated historical text `MessageContent` union。
- `packages/host/src/llm/anthropic.ts` translated historical texttranslated historical texttranslated historical texttranslated historical text `thinking: {type: 'enabled',
  budget_tokens: N}`(translated historical texttranslated historical text);SSE translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `content_block_start` translated historical text `type: 'thinking'`
  translated historical text `content_block_delta` translated historical text `thinking_delta`,translated historical texttranslated historical texttranslated historical text `ThinkingContent` translated historical texttranslated historical texttranslated historical texttranslated historical text assistant message。
- `packages/dashboard/src/features/chat/ChatPanel.tsx` translated historical text `ThinkingBlock`,translated historical texttranslated historical texttranslated historical texttranslated historical text。

### 4. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(#152)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** JSONL translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text、in-flight streams)
translated historical texttranslated historical texttranslated historical texttranslated historical text。host translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `assistant` translated historical texttranslated historical texttranslated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical text `tool_result` / translated historical texttranslated historical texttranslated historical text `user`,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `thinking` translated historical texttranslated historical texttranslated historical text。

**translated historical texttranslated historical text:**
- `packages/host/src/store/log.ts` translated historical text replay translated historical texttranslated historical text:translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `thinking` translated historical text
  translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `llm_response` translated historical texttranslated historical texttranslated historical text `tool_result` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
  `[interrupted]` translated historical texttranslated historical texttranslated historical text `llm_response` translated historical texttranslated historical texttranslated historical text FSM translated historical texttranslated historical text `ready`。
- translated historical texttranslated historical texttranslated historical text map translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `session:subscribe` translated historical texttranslated historical texttranslated historical texttranslated historical text。

### 5. Diff translated historical texttranslated historical text(#148)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** LLM translated historical texttranslated historical text `edit` translated historical text `write` translated historical text,approval translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
JSON。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical text LLM translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text unified diff,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text diff。

**translated historical texttranslated historical text:**
- `packages/dashboard/src/features/inspector/PendingCallCard.tsx`(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)
  translated historical texttranslated historical text tool name translated historical text `edit` / `write` translated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical texttranslated historical text
  `client:read_file` translated historical texttranslated historical text —— translated historical texttranslated historical texttranslated historical text executor `read` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text),translated historical text `diff`
  npm translated historical text(translated historical texttranslated historical text unified-diff translated historical text)translated historical texttranslated historical text hunks,translated historical texttranslated historical texttranslated historical texttranslated historical text diff。
- translated historical texttranslated historical text: translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### 6. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text + translated historical texttranslated historical text(#127)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** hover translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text user translated historical texttranslated historical text → translated historical texttranslated historical texttranslated historical texttranslated historical text → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
textarea → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text fork translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text fork translated historical texttranslated historical texttranslated historical texttranslated historical text user translated historical texttranslated historical text。

**translated historical texttranslated historical text:** `packages/dashboard/src/features/chat/ChatPanel.tsx` translated historical text user translated historical texttranslated historical texttranslated historical texttranslated historical text hover
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text inline textarea。translated historical texttranslated historical texttranslated historical text fire `client:fork { sessionId, cursor,
seedMessage }`(translated historical texttranslated historical texttranslated historical texttranslated historical text fork translated historical texttranslated historical text)。

### 7. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text UI(#126)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** Composer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text/popover translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
`auto | ask | deny | allow_all`。translated historical text `allow_all` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical text `client:set_approval_mode`。

**translated historical texttranslated historical text:** `packages/dashboard/src/features/chat/Composer.tsx` footer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
Select translated historical text Popover translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `session.state.approvalMode` translated historical text。

### 8. translated historical texttranslated historical texttranslated historical texttranslated historical text UI(#128)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text Ctrl+V,translated historical texttranslated historical texttranslated historical texttranslated historical text `image/*` translated historical texttranslated historical texttranslated historical texttranslated historical text,
translated historical text base64 translated historical texttranslated historical texttranslated historical text image content block,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text X translated historical texttranslated historical text。

**translated historical texttranslated historical text:** Composer translated historical text `onPaste` handler,translated historical texttranslated historical text `clipboardData.items` translated historical text `image/*`,
translated historical texttranslated historical text base64,translated historical texttranslated historical texttranslated historical texttranslated historical text attachments state。translated historical texttranslated historical texttranslated historical texttranslated historical text attachments translated historical texttranslated historical text
`user_message.content` translated historical texttranslated historical texttranslated historical text `image` content block。

### 9. Compact translated historical texttranslated historical texttranslated historical texttranslated historical text(B1 translated historical texttranslated historical text)

**translated historical texttranslated historical text feature translated historical texttranslated historical texttranslated historical text:** translated historical texttranslated historical text `session.state.contextPressureLevel`,`soft` translated historical texttranslated historical text
Composer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text compact"translated historical text"translated historical texttranslated historical text compact"translated historical texttranslated historical text;
`hard` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text compact"。

**translated historical texttranslated historical text:** translated historical texttranslated historical texttranslated historical text `packages/dashboard/src/features/chat/ContextPressureBanner.tsx`,
translated historical text `app.tsx` translated historical texttranslated historical texttranslated historical text Composer translated historical texttranslated historical text。

---

## translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)

### 1. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text / translated historical texttranslated historical text —— DONE

kernel translated historical texttranslated historical text token translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical text `state.contextPressureLevel`;host translated historical texttranslated historical text LLM translated historical texttranslated historical text
translated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `compact_replaced` translated historical texttranslated historical texttranslated historical texttranslated historical text replay/fork。translated historical texttranslated historical text `/compact` translated historical text
compact translated historical texttranslated historical texttranslated historical texttranslated historical text;translated historical texttranslated historical texttranslated historical texttranslated historical text idle translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。**translated historical texttranslated historical text:** Compact translated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical text)。

### 2. Slash translated historical texttranslated historical text —— PARTIAL

Composer translated historical texttranslated historical texttranslated historical text `/compact`。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text `/model`。translated historical texttranslated historical text slash commands
translated historical texttranslated historical texttranslated historical texttranslated historical text。

### 3. translated historical text agent translated historical texttranslated historical text —— DONE

host translated historical text `agent` translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical text workspace translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical text `maxAgentDepth` translated historical texttranslated historical text
translated historical texttranslated historical text,translated historical texttranslated historical text agent translated historical texttranslated historical text assistant translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text agent translated historical text tool_result translated historical texttranslated historical text。

### 4. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text / translated historical texttranslated historical texttranslated historical texttranslated historical text —— translated historical texttranslated historical text

translated historical texttranslated historical texttranslated historical texttranslated historical text。

### 5. translated historical texttranslated historical text resume / fork —— DONE(translated historical texttranslated historical texttranslated historical text #152)

Fork translated historical texttranslated historical text(`session:forked` translated historical texttranslated historical text)。Resume translated historical texttranslated historical text `server:history` translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical text
`awaiting_tool` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `tool_result` translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical text in-flight translated historical text
translated historical texttranslated historical texttranslated historical text #152。

### 6. Approval / translated historical texttranslated historical texttranslated historical texttranslated historical text —— DONE(translated historical texttranslated historical text)、translated historical texttranslated historical texttranslated historical text(UI translated historical text #126)

kernel translated historical texttranslated historical text `approvalMode`(`auto` | `ask` | `deny` | `allow_all`)。host translated historical text
`allow_all` translated historical texttranslated historical texttranslated historical text `AK_ALLOW_ALL_OK=1` translated historical texttranslated historical text。

### 7. MCP —— STUB ONLY,translated historical texttranslated historical text

`McpServerConfig` translated historical text `initMcp()` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical text。

### 8. Diff / edit translated historical texttranslated historical text —— DONE(UI translated historical texttranslated historical texttranslated historical text #148)

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text + `replace_all` translated historical texttranslated historical text,translated historical texttranslated historical text Claude Code / pi translated historical texttranslated historical text。UI translated historical texttranslated historical text diff
translated historical texttranslated historical texttranslated historical text #148。

### 9. TODO translated historical texttranslated historical text —— DONE

`todowrite` translated historical texttranslated historical texttranslated historical texttranslated historical text,kernel translated historical text `input.todos` translated historical texttranslated historical texttranslated historical text `state.todos`,TodoDock translated historical texttranslated historical text。

### 10. translated historical texttranslated historical text / token translated historical texttranslated historical text —— DONE(footer translated historical texttranslated historical texttranslated historical texttranslated historical text)

`state.usage` translated historical texttranslated historical texttranslated historical texttranslated historical text/translated historical texttranslated historical text token translated historical texttranslated historical texttranslated historical text。Composer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text token。$ translated historical texttranslated historical text
footer translated historical texttranslated historical texttranslated historical texttranslated historical text。

### 11. translated historical texttranslated historical texttranslated historical text / translated historical texttranslated historical texttranslated historical texttranslated historical text —— DONE

Composer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。Anthropic translated historical text OpenAI adapter translated historical texttranslated historical text。translated historical text provider
fallback translated historical texttranslated historical texttranslated historical texttranslated historical text。

### 12. translated historical texttranslated historical text UX —— DONE

Anthropic + OpenAI adapter translated historical texttranslated historical texttranslated historical text,`session:token_delta` translated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text ESC translated historical texttranslated historical text。

---

## translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text(translated historical texttranslated historical texttranslated historical text)

### Prompt caching(#149)—— translated historical texttranslated historical texttranslated historical texttranslated historical text

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### Settings UI(#131)—— translated historical texttranslated historical texttranslated historical texttranslated historical text

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### webfetch(#147 translated historical texttranslated historical texttranslated historical texttranslated historical text)—— translated historical texttranslated historical text

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text websearch。webfetch translated historical texttranslated historical text SSRF / translated historical texttranslated historical texttranslated historical text / translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text,translated historical texttranslated historical texttranslated historical texttranslated historical text。

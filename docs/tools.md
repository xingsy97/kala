# v1 Tool Set

**Status**: Normative for the original v1 executor core, with Batch A additions listed in §9.
Every executor bundled in this repo MUST implement the seven core tools below plus the implemented additions in §9. Third-party executors MAY implement a subset (declared via `executor:announce.tools` — see [wire-protocol.md](protocol/wire-protocol.md)).

---

## 0. Design principles

1. **Take the intersection of leading agents first.** The seven core tools below are the intersection of Claude Code / opencode / codex / pi's tool sets. Batch A adds small, explicitly documented extensions where the product now depends on them.
2. **Approval-gate only what can lose data.** Read-only tools never require approval. Write / mutate tools always require approval. This is the *default*; runtime config MAY override.
3. **JSON Schema as the input contract.** Executor validates input against the schema before running. Failure → `ok: false, content: <validation error>`.
4. **Output is always a string.** Structured data is JSON-stringified. This keeps the wire protocol dumb and the kernel string-only.
5. **Deterministic errors.** All error strings begin with a stable prefix (`ERROR: `, `EACCES: `, `ENOENT: `, etc.) so LLMs can pattern-match.

---

## 1. Tool summary table

| Name | Purpose | Approval | Category |
|---|---|---|---|
| `read` | Read a file | ❌ | Read-only |
| `ls` | List directory | ❌ | Read-only |
| `glob` | Find files by pattern | ❌ | Read-only |
| `grep` | Content search | ❌ | Read-only |
| `write` | Overwrite entire file | ✅ | Mutating |
| `edit` | Precise string replace | ✅ | Mutating |
| `bash` | Execute shell command; can start background tasks with `run_in_background` | ✅ | Mutating |
| `todowrite` | Replace the session todo list | ❌ | Planning state |
| `agent` | Spawn a host-side child agent session | ❌ | Host builtin |
| `bash_output` | Poll background shell task output | ❌ | Background shell |
| `kill_shell` | Stop a background shell task | ✅ | Background shell |

---

## 2. Per-tool specifications

### 2.1 `read`

Read a UTF-8 text file. For binary or huge files, prefer `bash` with `head` / `xxd`.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Absolute path" },
    "offset": { "type": "integer", "minimum": 0, "description": "0-indexed line to start from" },
    "limit": { "type": "integer", "minimum": 1, "description": "Max lines to read (default: 2000)" }
  },
  "required": ["path"]
}
```

**Output**: file contents, prepended with `cat -n`-style line numbers starting at `offset + 1`, one line per source line. Lines are joined by `\n`.

**Errors** (returned as `ok: false, content: <string>`):
- `ENOENT: no such file: <path>`
- `EACCES: permission denied: <path>`
- `EISDIR: path is a directory (use ls): <path>`
- `E2BIG: file exceeds size limit (<n> bytes); use offset/limit or bash+head`

**Sandbox**: `path` MUST resolve inside the executor's working directory whitelist. Reject with `EACCES: outside workspace` otherwise.

### 2.2 `ls`

List directory contents.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "hidden": { "type": "boolean", "default": false }
  },
  "required": ["path"]
}
```

**Output**: newline-separated entries. Each entry: `<name>[/]` (trailing `/` for directories). Sorted lexicographically.

**Errors**:
- `ENOENT`, `EACCES`, `ENOTDIR: not a directory: <path>`

### 2.3 `glob`

Find files by glob pattern.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "e.g. **/*.ts" },
    "cwd": { "type": "string", "description": "Working directory (defaults to workspace root)" }
  },
  "required": ["pattern"]
}
```

**Output**: newline-separated absolute paths, sorted by mtime descending (newest first) — most useful for "what did I edit recently". If sorting by mtime is not practical, sort lexicographically and document.

**Cap**: at most **1000** matches returned. If more exist, append a final line: `... and <n> more (refine pattern)`.

**Errors**:
- `EINVAL: invalid glob pattern: <pattern>`

### 2.4 `grep`

Content search, ripgrep-style.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Regex pattern (POSIX ERE or Rust regex)" },
    "path": { "type": "string", "description": "File or directory to search (defaults to workspace root)" },
    "glob": { "type": "string", "description": "Optional file glob filter, e.g. '*.ts'" },
    "output_mode": {
      "type": "string",
      "enum": ["files_with_matches", "count", "content"],
      "default": "files_with_matches"
    },
    "case_insensitive": { "type": "boolean", "default": false }
  },
  "required": ["pattern"]
}
```

**Output**: depends on `output_mode`:
- `files_with_matches`: newline-separated paths
- `count`: `<path>:<count>` per line
- `content`: `<path>:<line-num>:<line-content>` per line

**Cap**: 1000 lines. Append `... and N more matches (refine pattern or use output_mode=count)`.

**Errors**:
- `EINVAL: invalid regex: <pattern>` — include underlying regex error message
- `ENOENT: path not found`

### 2.5 `write`

Overwrite an entire file. Creates parent directories if missing.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "content": { "type": "string" }
  },
  "required": ["path", "content"]
}
```

**Output**: `Wrote <n> bytes to <path>` (or `Created <path> with <n> bytes` if the file didn't exist).

**Errors**:
- `EACCES: permission denied`
- `EACCES: outside workspace`
- `EISDIR: path is a directory: <path>`
- `E2BIG: content exceeds size limit`

**Approval**: `requiresApproval: true`. Approval flow is kernel + dashboard's job (see SPEC §4.4).

### 2.6 `edit`

Precise string replace within a file. Idempotency comes from the strictness of matching.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "old_string": {
      "type": "string",
      "description": "Text to find. MUST be unique in the file unless replace_all=true."
    },
    "new_string": {
      "type": "string",
      "description": "Replacement text."
    },
    "replace_all": {
      "type": "boolean",
      "default": false,
      "description": "If true, replace every occurrence. If false, error unless old_string is unique."
    }
  },
  "required": ["path", "old_string", "new_string"]
}
```

**Output**: `Replaced <n> occurrence(s) in <path>`.

**Errors**:
- `ENOENT: file does not exist (use write to create): <path>`
- `EAMBIG: old_string matches <n> times; set replace_all=true or provide more context` (when `replace_all=false` and match count ≠ 1)
- `ENOTFOUND: old_string not found in <path>`
- `EACCES` / `EISDIR` as usual

**Approval**: `requiresApproval: true`.

**Sandbox**: same path resolution as `write`.

### 2.7 `bash`

Execute a shell command. Most powerful, most dangerous.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string" },
    "cwd": { "type": "string", "description": "Working directory (defaults to workspace root)" },
    "timeoutMs": { "type": "integer", "minimum": 100, "default": 30000 }
  },
  "required": ["command"]
}
```

**Output**: stdout + stderr concatenated, with a trailing status line:

```
<stdout>
<stderr>
--- exit code: <n>, duration: <ms>ms
```

If the command was killed by timeout: append `--- killed after <timeoutMs>ms (timeout)`.

**Errors**:
- `EINVAL: command is empty`
- `EACCES: cwd outside workspace`
- Executor MUST return `ok: true` if the process ran, regardless of exit code. Non-zero exit is data, not an executor error. `ok: false` is reserved for cases where the executor could not run the command at all.

**Approval**: `requiresApproval: true`.

**Sandbox**:
- `cwd` MUST resolve inside the workspace whitelist
- Executor SHOULD (but MAY not, for v1) drop dangerous env vars, prevent network access, or block certain commands. v1 relies on the workspace whitelist + user approval as the safety layer.

---

## 3. Sandbox and workspace whitelist

Every executor starts with a **workspace whitelist**:
- Node daemon: `--workspace <path>` (may be repeated for multiple roots)
- Browser WebContainer: implicit (the in-memory vfs is the whitelist)

**Path resolution rule**: For any tool that accepts a `path`, the executor MUST:
1. If the path is not absolute, resolve it against the **first workspace root** (not `process.cwd()`). LLM-supplied relative paths like `.` or `sub/file.txt` always mean "inside the workspace".
2. Resolve to an absolute canonical path (follow symlinks).
3. Verify the result is under one of the whitelisted roots.
4. If not, return `EACCES: outside workspace`.

Reading through symlinks that point outside the workspace is a data leak — the resolution MUST catch it.

---

## 4. Tool discovery

Executor announces its capabilities on connect (see wire-protocol §5.1). The `tools` field is a subset of the seven names above. Host's `AgentConfig` for the session lists the schemas — Host is responsible for making sure the LLM only sees tools the executor can actually run.

If an executor announces a tool with a name that clashes with an existing v1 tool but different semantics, that's a bug. v1 does not support namespaced tool names; v2 may add MCP-server-style prefixes.

---

## 5. MCP compatibility

The tool schemas above are MCP-compatible: they follow JSON Schema draft-07, and the input surface matches the MCP `tools/call` request format. This means:

- An `agent-kernel` executor can be adapted into an MCP server (stdio transport) with a thin wrapper.
- MCP tools from third parties (e.g. GitHub, Slack integrations) can be adapted **into** an `agent-kernel` executor via the same wrapper in reverse.

Details of the MCP shim live in `packages/executor/src/mcp/` (planned for post-v1). The point of listing this here is: **do not design tool schemas in a way that closes the door on MCP interop.**

---

## 6. Adding new tools (in v1)

Two ways:

**Executor-side (host-registered):** Executor implements the tool, adds it to `executor:announce.tools`, and provides an inputSchema out-of-band. Host does not automatically pick this up in v1 — Host's `AgentConfig` is currently configured at session start.

**Config-side:** User provides a full `ToolSchema` in the config file used at session creation. Executor MUST already implement that tool name.

**v2 plan**: dynamic tool registration via a `session:reconfig` protocol event that updates `AgentConfig` mid-session. For v1, config is immutable per session.

---

## 7. Testing tools

Each tool has a test file at `packages/executor/src/tools/<name>.test.ts` with cases for:
- Happy path
- Missing file / directory
- Path outside workspace
- Schema violation (missing required field, wrong type)
- (For `write` / `edit`) Idempotency / rewrite scenarios
- (For `bash`) Timeout, non-zero exit, killed process

Tools are pure functions of (input, filesystem) → (output). Tests use tmpdir fixtures. See [testing.md](testing.md) for the general strategy.

---

## 8. Deliberately excluded from v1

These are attractive but not in v1:

| Tool | Why not v1 |
|---|---|
| `web_fetch` | Adds network egress concerns. Punt to v2 as an optional extension. |
| `web_search` | Same. Also needs a provider (Brave / Serper / …), adds ops cost. |
| `todo_read` | `todowrite` is implemented; a separate read tool is unnecessary because state carries `todos`. |
| third-party `subagent` / `task` executors | `agent` is implemented as a host-side builtin, not an executor-side recursive primitive. |
| `memory` / `remember` | Persistence layer for cross-session context, own subsystem. |

Explicit exclusion is a feature: the "seven core tools" boundary is what lets the kernel stay tiny.

---

## 9. Implementation Update (2026-07-05)

The bundled tool surface is now larger than the original seven-tool v1 document:

- `todowrite` is a builtin executor tool and a reducer special case. Successful results promote `input.todos` into `state.todos`.
- `agent` is declared as a tool schema but runs inside Host, not Executor. It creates a child session in the same workspace and returns the child assistant text.
- `bash` accepts `run_in_background: true`. It returns `{"taskId":"...","note":"started"}` immediately.
- `bash_output` reads background task logs by `task_id`; input supports `offset`, `block`, and `timeout_ms`.
- `kill_shell` stops a background task by `task_id`.
- Dashboard shows background shell tasks in a Background terminal panel by deriving task state from ordinary `bash`, `bash_output`, and `kill_shell` tool calls/results in the timeline.
- `cwd` can be controlled at session level (`state.cwd`) and is passed to tool dispatch. Tool-level `cwd` remains supported for compatibility.
- MCP currently has a placeholder `initMcp()` and `McpServerConfig`; it does not spawn servers or add runtime tools yet.

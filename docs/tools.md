# Tool Set

**Status**: Normative for the executor tool surface.
Every executor bundled in this repo MUST implement the tools below. Third-party executors MAY implement a subset (declared via `executor:announce.tools`  -  see [wire-protocol.md](protocol/wire-protocol.md)).

---

## 0. Design principles

1. **Take the intersection of leading agents first.** The core tools below are the intersection of Claude Code / opencode / codex / pi's tool sets, plus small explicitly-documented additions where the product depends on them.
2. **Approval-gate only what can lose data.** Read-only tools never require approval. Write / mutate tools always require approval. This is the *default*; runtime config MAY override.
3. **JSON Schema as the input contract.** Executor validates input against the schema before running. Failure  -  `ok: false, content: <validation error>`.
4. **Output is always a string.** Structured data is JSON-stringified. This keeps the wire protocol dumb and the kernel string-only.
5. **Deterministic errors.** All error strings begin with a stable prefix (`ERROR: `, `EACCES: `, `ENOENT: `, etc.) so LLMs can pattern-match.

---

## 1. Tool summary table

| Name | Purpose | Approval | Category |
|---|---|---|---|
| `read` | Read a file |  -  | Read-only |
| `ls` | List directory |  -  | Read-only |
| `glob` | Find files by pattern |  -  | Read-only |
| `grep` | Content search |  -  | Read-only |
| `write` | Overwrite entire file |  -  | Mutating |
| `edit` | Precise string replace |  -  | Mutating |
| `bash` | Execute shell command; can start background tasks with `run_in_background` |  -  | Mutating |
| `todowrite` | Replace the session todo list |  -  | Planning state |
| `web_search` | DuckDuckGo HTML search |  -  | Network |
| `agent` | Spawn a host-side child agent session |  -  | Host builtin |
| `bash_output` | Poll background shell task output |  -  | Background shell |
| `kill_shell` | Stop a background shell task |  -  | Background shell |

`todowrite` is both an executor tool and a reducer special case: successful results promote `input.todos` into `state.todos`. `agent` is declared as a tool schema but runs inside Host, not Executor  -  it creates a child JSONL session in the same workspace and returns the child assistant text.

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

**Output**: newline-separated absolute paths, sorted by mtime descending (newest first). If sorting by mtime is not practical, sort lexicographically and document.

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
- `EINVAL: invalid regex: <pattern>`  -  include underlying regex error message
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

**Approval**: `requiresApproval: true`. Approval flow is kernel + dashboard's job (see SPEC  - 4.4).

### 2.6 `edit`

Precise string replace within a file.

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
- `EAMBIG: old_string matches <n> times; set replace_all=true or provide more context`
- `ENOTFOUND: old_string not found in <path>`
- `EACCES` / `EISDIR` as usual

**Approval**: `requiresApproval: true`.

**Sandbox**: same path resolution as `write`.

### 2.7 `bash`

Execute a shell command. Most powerful, most dangerous. Supports background tasks.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string" },
    "cwd": { "type": "string", "description": "Working directory (defaults to session cwd, or workspace root)" },
    "timeoutMs": { "type": "integer", "minimum": 100, "default": 30000 },
    "run_in_background": { "type": "boolean", "default": false, "description": "If true, spawn and return a taskId immediately without waiting" }
  },
  "required": ["command"]
}
```

**Output**:
- Foreground: stdout + stderr + trailing `--- exit code: <n>, duration: <ms>ms` (or `--- killed after <timeoutMs>ms (timeout)`).
- Background: JSON `{"taskId":"...","note":"started"}`.

**Errors**:
- `EINVAL: command is empty`
- `EACCES: cwd outside workspace`
- Executor MUST return `ok: true` if the process ran, regardless of exit code. Non-zero exit is data, not an executor error.

**Approval**: `requiresApproval: true`.

**Session cwd**: `CallToolEffect` includes an optional `cwd` field copied from `state.cwd`; when the tool input omits `cwd` the executor uses the session cwd, falling back to the workspace root.

### 2.8 `todowrite`

Replace the session's todo list.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "content": { "type": "string" },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
        },
        "required": ["id", "content", "status"]
      }
    }
  },
  "required": ["todos"]
}
```

**Output**: `Updated <n> todos`.

**Reducer behavior**: the kernel's `onToolResult` special-cases this tool name  -  when `ok: true`, it promotes `pendingCall.input.todos` into `state.todos`. No new event kind is required.

### 2.9 `web_search`

Search the web via DuckDuckGo. No API key required.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "minLength": 1 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
  },
  "required": ["query"]
}
```

**Output**: JSON `{"results": [{"title": string, "url": string, "snippet": string}]}`. Snippets are truncated to 500 characters. If DuckDuckGo returns no results, `results` is an empty array.

**Errors** (`ok: false, content: <string>`):
- `web_search timed out after 15000ms`
- `web_search failed: <http status>`
- `web_search failed: <error message>`

**Approval**: `requiresApproval: false`.

**Implementation**: `packages/executor/src/tools/websearch.ts` hits `https://html.duckduckgo.com/html/?q=<query>` and parses the anchor/snippet HTML. No Serper / Brave / Google API key is used.

### 2.10 `agent` (host builtin)

Spawn a child agent session and return its final assistant text.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "prompt": { "type": "string" },
    "tools": { "type": "array", "items": { "type": "string" } },
    "model": { "type": "string" }
  },
  "required": ["prompt"]
}
```

**Output**: the child session's final assistant text, or an error if the child ended in a non-`done` status.

**Approval**: `requiresApproval: false`. The child inherits the parent's `approvalMode` from `AgentState.cwd`/`approvalMode`, so gated tools inside the child still respect the parent's approval settings.

**Depth guard**: `AgentConfig.maxAgentDepth` (default 3) caps recursive spawning; deeper calls fail with `agent depth exceeded`.

The `agent` tool is declared in the config's tool list but never dispatched to the executor  -  Host intercepts it in `performCallTool`.

### 2.11 `bash_output`

Poll a background shell task's logs.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "task_id": { "type": "string" },
    "offset": { "type": "integer", "minimum": 0 },
    "block": { "type": "boolean", "default": false },
    "timeout_ms": { "type": "integer", "minimum": 100, "default": 5000 }
  },
  "required": ["task_id"]
}
```

**Output**: the log slice since `offset`, plus task status trailer.

### 2.12 `kill_shell`

Stop a background shell task by id.

**Schema**:
```json
{
  "type": "object",
  "properties": {
    "task_id": { "type": "string" }
  },
  "required": ["task_id"]
}
```

**Approval**: `requiresApproval: true`.

---

## 3. Sandbox and workspace whitelist

Every executor starts with a **workspace whitelist**:
- Node daemon: `--workspace <path>` (may be repeated for multiple roots) or empty (trust whole machine)
- Browser WebContainer: implicit (the in-memory vfs is the whitelist)

**Path resolution rule**: For any tool that accepts a `path`, the executor MUST:
1. If the path is not absolute, resolve it against the **session `cwd`** if set, otherwise the **first workspace root**. LLM-supplied relative paths like `.` or `sub/file.txt` always mean "inside the workspace".
2. Resolve to an absolute canonical path (follow symlinks).
3. Verify the result is under one of the whitelisted roots.
4. If not, return `EACCES: outside workspace`.

Reading through symlinks that point outside the workspace is a data leak  -  the resolution MUST catch it.

**Session cwd**: `state.cwd` (mutated by `cwd_changed` events, or seeded from the create-session dialog) is passed via the effect's `cwd` field to each `tool:call`. Executors merge it into the tool input as the default working directory.

---

## 4. Tool discovery

Executor announces its capabilities on connect (see wire-protocol  - 5.1). The `tools` field is a subset of the names above. Host's `AgentConfig` for the session lists the schemas  -  Host is responsible for making sure the LLM only sees tools the executor can actually run.

If an executor announces a tool with a name that clashes with an existing tool but different semantics, that's a bug. Namespaced tool names are not supported yet.

---

## 5. MCP compatibility

The tool schemas above are MCP-compatible: they follow JSON Schema draft-07, and the input surface matches the MCP `tools/call` request format. An `agent-kernel` executor can be adapted into an MCP server (stdio transport) with a thin wrapper; third-party MCP tools can be adapted into an executor via the same wrapper in reverse.

The MCP shim is currently a stub: `SessionConfig.mcpServers` and `initMcp()` accept configuration but do not spawn servers or add runtime tools. The point of documenting this here is that **tool schemas are designed not to close the door on MCP interop.**

---

## 6. Adding new tools

Two ways:

**Executor-side:** Executor implements the tool, adds it to `executor:announce.tools`, and provides an inputSchema out-of-band. Host does not automatically pick this up  -  Host's `AgentConfig` is configured at session start.

**Config-side:** User provides a full `ToolSchema` in the config file used at session creation. Executor MUST already implement that tool name.

Dynamic mid-session tool registration is not supported; config is immutable per session.

---

## 7. Testing tools

Each tool has a test file at `packages/executor/src/tools/<name>.test.ts` covering:
- Happy path
- Missing file / directory
- Path outside workspace
- Schema violation (missing required field, wrong type)
- (For `write` / `edit`) idempotency / rewrite scenarios
- (For `bash`) timeout, non-zero exit, killed process, background start/poll/kill
- (For `web_search`) mocked DuckDuckGo HTML fixtures

Tools are pure functions of `(input, filesystem, network)`  -  `(output)`. Tests use tmpdir fixtures and `nock`/`msw` for HTTP. See [testing.md](testing.md) for the general strategy.

---

## 8. Deliberately excluded

| Tool | Why |
|---|---|
| `web_fetch` | Adds network egress concerns beyond `web_search`. Design for SSRF/allowlist/length caps not yet done; punt to a future release. |
| `todo_read` | `todowrite` is implemented; state already carries `todos`. |
| third-party `subagent` / `task` executors | `agent` is a host-side builtin, not an executor-side recursive primitive. |
| `memory` / `remember` | Persistence layer for cross-session context is a separate subsystem. |
| Third-party MCP servers at runtime | Configuration accepted, runtime not implemented yet. |

Explicit exclusion is a feature: keeping the tool surface tight is what lets the kernel stay small.

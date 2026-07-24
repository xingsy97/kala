# Tool Set

**Status**: Normative for the executor tool surface.

Every bundled executor MUST implement the tools below. Third-party executors MAY implement a subset declared through `executor:announce.tools`.

## Design Principles

1. Tool names use explicit `snake_case` identifiers.
2. Read-only tools never require approval. File mutation tools always require approval by default.
3. JSON Schema is the input contract.
4. Tool output is still a string on the wire. Structured output is JSON-stringified.
5. Mutating file tools share one mutation engine for path resolution, text decoding, exact replacement validation, patch parsing, diff generation, stale guards, and per-file locks.
6. Error strings keep stable prefixes such as `EINVAL:`, `ENOENT:`, `EACCES:`, `EAMBIG:`, and `ENOTFOUND:`.

## Tool Summary

| Name | Purpose | Approval | Category |
|---|---|---|---|
| `read_file` | Read one text file | No | Read-only |
| `read_files` | Read multiple text files with batcat-style sections | No | Read-only |
| `ls` | List directory entries | No | Read-only |
| `glob` | Find files by glob pattern | No | Read-only |
| `grep` | Search file contents | No | Read-only |
| `write_file` | Create or fully overwrite one text file | Yes | Mutating |
| `replace_in_file` | One exact string replacement in one file | Yes | Mutating |
| `replace_many_in_file` | Multiple exact string replacements in one file | Yes | Mutating |
| `apply_file_patch` | Apply patch-format file mutations | Yes | Mutating |
| `bash` | Execute shell command; supports background mode | Yes | Mutating |
| `bash_output` | Poll background shell output | No | Background shell |
| `kill_shell` | Stop a background shell task | Yes | Background shell |
| `todowrite` | Replace the session todo list | No | Planning |
| `memory` | List, read, write, or delete memory entries | No | Memory |
| `websearch` | Web search | No | Network |
| `webfetch` | Fetch a web page | No | Network |
| `agent` | Spawn a host-side child agent | No | Host builtin |

`read`, `write`, and `edit` are not part of the bundled executor surface anymore.

## File Read Tools

### `read_file`

Reads one UTF-8 text file. Output is line-numbered with tab-separated line numbers.

```json
{
  "type": "object",
  "required": ["path"],
  "properties": {
    "path": { "type": "string" },
    "offset": { "type": "integer", "minimum": 0 },
    "limit": { "type": "integer", "minimum": 1 }
  }
}
```

Example output:

```text
1\talpha
2\tbeta
```

### `read_files`

Reads several UTF-8 text files in one call. Use this when related implementation, interface, and test files are already known.

```json
{
  "type": "object",
  "required": ["files"],
  "properties": {
    "files": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "required": ["path"],
        "properties": {
          "path": { "type": "string" },
          "offset": { "type": "integer", "minimum": 0 },
          "limit": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "max_bytes": { "type": "integer", "minimum": 1, "maximum": 1000000 }
  }
}
```

Example output:

```text
===== src/a.ts =====
1\timport ...

===== src/b.ts =====
20\texport ...
```

The default combined output cap is 200 KB; the hard cap is 1 MB.

## File Mutation Result

`write_file`, `replace_in_file`, `replace_many_in_file`, and `apply_file_patch` return a JSON string with this shape:

```json
{
  "ok": true,
  "summary": "Applied 2 replacement(s) in /repo/src/a.ts",
  "files": [
    {
      "path": "/repo/src/a.ts",
      "operation": "modified",
      "additions": 2,
      "deletions": 1,
      "diff": "--- /repo/src/a.ts\n+++ /repo/src/a.ts\n@@ ...",
      "bytes_before": 1200,
      "bytes_after": 1220,
      "replacements": [{ "index": 0, "count": 1 }]
    }
  ],
  "warnings": []
}
```

`diff` means the actual unified diff caused by the tool execution. It is not the `apply_file_patch` input.

## File Mutation Tools

### `write_file`

Creates or fully overwrites one UTF-8 text file.

```json
{
  "type": "object",
  "required": ["path", "content"],
  "properties": {
    "path": { "type": "string" },
    "content": { "type": "string" }
  }
}
```

### `replace_in_file`

Applies one exact string replacement in one text file.

```json
{
  "type": "object",
  "required": ["path", "old_string", "new_string"],
  "properties": {
    "path": { "type": "string" },
    "old_string": { "type": "string" },
    "new_string": { "type": "string" },
    "replace_all": { "type": "boolean", "default": false }
  }
}
```

When `replace_all` is false, `old_string` must match exactly once.

### `replace_many_in_file`

Applies several exact string replacements to one text file in order. The file is committed once only if every edit succeeds.

```json
{
  "type": "object",
  "required": ["path", "edits"],
  "properties": {
    "path": { "type": "string" },
    "edits": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["old_string", "new_string"],
        "properties": {
          "old_string": { "type": "string" },
          "new_string": { "type": "string" },
          "replace_all": { "type": "boolean", "default": false }
        }
      }
    }
  }
}
```

### `apply_file_patch`

Applies a patch-format mutation to files. A patch can add, update, delete, or move files, and it may touch one file or many files.

```json
{
  "type": "object",
  "required": ["patch"],
  "properties": {
    "patch": { "type": "string" }
  }
}
```

Patch format:

```text
*** Begin Patch
*** Add File: path
+new line
*** Update File: path
@@
 context line
-old line
+new line
*** Delete File: path
*** Update File: old-path
*** Move to: new-path
*** End Patch
```

Update hunks use strict context. Missing or ambiguous context fails.

## Mutation Protection Rules

- Text mutations preserve UTF-8 BOM and the file's dominant line ending where possible.
- Directories, likely binary files, and files above the text size cap are rejected.
- Exact replacements fail on missing or ambiguous `old_string` unless `replace_all=true`.
- `replace_many_in_file` is all-or-nothing for the target file.
- Commit compares loaded bytes with bytes immediately before write and rejects stale writes.
- Per-file locks serialize cooperating mutations inside one executor process.
- Design target: `replace_in_file` and `replace_many_in_file` should require a prior full `read_file` or `read_files`; the current wire protocol still needs a durable read-state field before runtime enforcement can be complete.

## Other Tools

`ls`, `glob`, `grep`, `bash`, `bash_output`, `kill_shell`, `todowrite`, `memory`, `websearch`, `webfetch`, and host builtin `agent` keep their existing schemas and behavior except that docs and prompts should refer to the renamed file tools above.

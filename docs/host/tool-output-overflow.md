# Tool-output overflow

**Status**: implemented.

## 1. Why

Today, every `tool_result` — no matter how large — lands in `state.messages` verbatim. Two visible failure modes today:

1. **A single `grep` that hits 200 KB of matches burns 50k tokens** on the next LLM turn. Auto-compact eventually rescues the session, but the offending turn already paid the price.
2. **A `read` of a 5 MB text file** technically works (we cap the file at 5 MB and let it through) but is almost never the right thing to send to the model — the agent wanted the *shape* of the file, not the bytes.

Auto-compact addresses the *cumulative* context problem. It does nothing for the *per-turn* blowup: one giant `tool_result` in a single turn can single-handedly push the session across the hard threshold, and the compact fires *after* the LLM call that already saw the full result.

Opencode's fix: cap in-history tool output size, spill overflow to a separate file, keep a short preview + pointer in the message. This doc adapts that pattern for agent-kernel's kernel/host/executor split.

## 2. What we build

### 2.1 Overflow model

Every `tool_result` payload is measured (UTF-8 byte length) at the executor before it crosses the wire. Two thresholds:

- **`inline` (default 32 KB, 400 lines)**: below this, no change. Result flows into `state.messages` exactly as today.
- **`overflow` (above `inline`)**: the executor writes the full payload to disk under a per-session overflow directory, and returns a *head+tail preview* + a pointer. The kernel sees only the preview.

### 2.2 Storage layout

```
<workspaceRoot>/.agent-kernel/overflow/
  <sessionId>/
    <callId>.txt         ← full tool output, UTF-8
```

- Files are written by the executor (it's the process that already has the full bytes).
- Files are read by:
  - the dashboard, via a new `client:read_overflow` message that acks with the full content
  - subsequent tool calls (agent asks `read` to open the overflow file itself)
- Files are pruned when the session's JSONL log is deleted through a best-effort
  executor RPC.
- Fork clones the overflow directory through a best-effort executor RPC.
  Independent sessions do not share overflow files, since deleting one session's
  log should not corrupt another's message history.

### 2.3 Preview shape

The message content the LLM sees:

```
{first roughly N/2 lines of output}
[... omitted lines ...]
{last roughly N/2 lines of output}

--- output truncated: 8712 / 45210 lines, 268134 / 1418072 bytes stored at overflow://call_01J6...
--- use `read { path: '<workspaceRoot>/.agent-kernel/overflow/<sessionId>/<callId>.txt' }` to read more
```

- `previewLines` default: 400. The budget is split between head and tail so the
  model sees command setup plus terminal failures or summaries.
- The `overflow://` URI is opaque to the LLM — it's a marker for the dashboard, not a resolvable scheme. The concrete file path is what the LLM acts on.
- If a tool produced structured JSON (e.g. `web_search`), we still overflow whole-string; we do not truncate inside a JSON value and risk producing invalid JSON. The `previewLines` guarantee is best-effort — if the first line already exceeds `inline` (single-line JSON blob), we fall back to a byte-truncated preview.

### 2.4 Which tools get overflow

**Applied universally by the executor client** (`packages/executor/src/client.ts`), not per-tool. The executor already wraps every tool run in `runOne`; the wrapping layer checks `Buffer.byteLength(content, 'utf8')` and applies overflow before emitting `executor:tool_result`. Tools stay ignorant.

**Exemptions:**

- `todowrite` — output is a short ack, never overflows.
- `memory` write/delete operations — ack strings.
- `bash_output` — the caller is polling for the *next* chunk; if a poll returns overflow-sized data, that's a real problem worth surfacing (bash output is already capped at 1 MB inside `bash.ts`).

Every other tool participates. Nothing declares opt-out — thresholds are large enough that "expected" small outputs are never affected.

### 2.5 Overflow *inside* the executor process

The executor already has a per-tool `MAX_BYTES` on `read` (5 MB) and `MAX_OUTPUT` on `bash` (1 MB). Those stay — they protect the executor from memory blow-up before we ever get to overflow. The overflow layer sits *after* the tool has produced its (already-capped) string.

Concretely:

- `read` still refuses 5 MB+ files up front. That's fine.
- A `bash` output that fills its 1 MB internal cap and exceeds the overflow threshold (32 KB) → overflow spills 1 MB to disk, preview shows first 400 lines. Correct.
- `grep` with no internal cap can produce arbitrary output. Overflow catches it.

## 3. Wire protocol changes

One new dashboard→host message; no kernel event changes; no executor-side changes to the tool_result shape (the string is just truncated before it goes on the wire).

```typescript
// Dashboard → Host
export type ClientReadOverflow = {
  requestId: string
  sessionId: string
  callId: string
}

// Host → Dashboard (ack pattern like fs:read_file)
export type OverflowContentsResult = {
  requestId: string
  sessionId: string
  callId: string
  content?: string
  size?: number
  error?: string
}
```

Host resolves the overflow file path from `<workspaceRoot>/.agent-kernel/overflow/<sessionId>/<callId>.txt`, applies sandbox rules (workspace-scoped read), returns the bytes. Enforces a max response size (default 4 MB) matching `fs:read_file`.

Kernel: no changes. `state.messages` still contains the truncated preview; the reducer never has to know about the on-disk file.

## 4. Kernel invariants (unchanged)

Because the overflow file is executor-side state, not kernel state:

- `fold(events, initialState)` remains deterministic. Given the same JSONL, you get the same state. The overflow file is just a side artifact.
- `fork` copies the overflow directory but nothing in the reducer depends on its existence — if the file goes missing, the preview text is still authoritative.
- Replay from an old JSONL without the overflow directory still works. Users get the preview; the "read more" pointer will fail if they follow it, which is a degraded but not broken experience.

## 5. Executor implementation surface

New module: `packages/executor/src/tools/overflow.ts`.

Exports:

```typescript
export type OverflowConfig = {
  inlineBytes: number      // default 32768
  previewLines: number     // default 400
  overflowDir: string      // <workspaceRoot>/.agent-kernel/overflow
}

export type OverflowResult = {
  content: string          // what goes on the wire
  overflowed: boolean
  fullBytes: number        // original size, for telemetry
}

export async function maybeOverflow(
  full: string,
  ctx: { sessionId: string, callId: string, config: OverflowConfig },
): Promise<OverflowResult>
```

Wired in `client.ts` between the tool runner and the `executor:tool_result` emit. `sessionId` and `callId` come from `payload`.

The overflow directory is created lazily on first use. Missing directory = no overflow yet.

## 6. Configuration

Executor CLI flags + env, matching how `sandboxRoots` is done today:

```
--overflow-inline-bytes <n>   Default 32768. 0 disables overflow.
--overflow-preview-lines <n>  Default 400.
```

Or env: `AK_OVERFLOW_INLINE_BYTES`, `AK_OVERFLOW_PREVIEW_LINES`.

Kernel / host do not see these knobs. They travel with the executor.

## 7. Dashboard changes

- ChatPanel's tool card renders the truncated preview inline (as today for normal results). When `overflowed: true` is detected (marker string in the content, or metadata on the result — see §8), the card shows a "View full output" button that fires `client:read_overflow` and inlines the response in a modal.
- Modal shows content with syntax hints (best-effort) and a "Copy" button. No structural editing; this is a viewer.

No changes to the message-flow UI. The preview is already a normal `tool_result`.

## 8. Detecting overflow in the dashboard

Two options considered:

1. **String sniffing.** Dashboard parses the preview for the `--- output truncated:` marker.
2. **Metadata carried alongside.** Extend `EventAppendedEvent` to include per-tool metadata like `overflow: { callId, bytes }`.

**We ship option 1.** The marker string is a stable ASCII sentinel produced by the overflow layer. Sniffing is O(1) (last 200 chars of the content) and requires no protocol change.

Downside: a user's actual tool output could contain the exact marker string. This is a false-positive risk we accept — the marker is intentional and unusual (`overflow://`), and the worst case is a bogus "View full output" button that fails to load the file, showing an error toast.

## 9. What we deliberately drop from opencode's design

- **No LSP-style per-tool `contentPart` protocol.** Opencode has a full "parts" system so tools can emit richer structures (rich text, expandable sections). We stick with strings; overflow is a monotone byte cap, not a rendering layer.
- **No CDN / remote storage.** Files live on the executor's disk. Dashboard fetches through the host, not directly from the executor. This preserves the "host is the only public surface" property.
- **No compression.** Overflow files are UTF-8 text. gzip would save 60% for typical logs but adds a decompress step for every `read`; the cost/benefit doesn't pay off at expected volumes.

## 10. Cleanup

- Session deletion (existing `client:delete_session` path): before unlinking the JSONL log, host asks the owning workspace executor to remove `<overflow>/<sessionId>/`.
- Executor startup: no cleanup. Stale overflow dirs cost disk, not correctness. Users can `rm -rf .agent-kernel/overflow` at any time.
- Fork: host asks the owning workspace executor to copy `<overflow>/<parent>/` → `<overflow>/<child>/`.

## 11. Testing plan

- **Executor:** unit tests for `maybeOverflow`:
  - Content under inline threshold: unchanged, `overflowed: false`.
  - Content over inline threshold: file written, content is preview + marker.
  - Preview always truncates at line boundary except when a single line exceeds threshold.
  - Missing sessionId/callId → error propagates (invariant, shouldn't happen from real callers).
- **Client wiring test:** feed the executor a tool that returns 100 KB → assert overflow file exists, wire result contains marker + first 400 lines.
- **Host:** `client:read_overflow` returns file bytes; lifecycle RPCs copy/delete session overflow directories on fork/delete; all executor-side path resolution stays under the sandbox.
- **Dashboard:** ChatPanel renders the "View full output" button when marker is present. Modal fetches and displays content.

## 12. Migration

- No data migration needed — this is executor-side only.
- Old JSONL logs never had overflow files. Any pointer in their message history that survives (unlikely; they predate the feature) would point at a missing file. Dashboard handles the missing-file case with a clear error.

## 13. Non-goals

- Structured (non-string) tool results. Kernel is deliberately string-only; introducing content parts is a much larger change.
- Streaming tool output. Overflow spills after the tool completes; incremental streaming (à la `bash_output`) is already handled by the polling loop.
- Cross-session sharing of overflow files. Deliberately isolated per session.

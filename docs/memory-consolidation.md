# Memory consolidation (two-phase)

**Status**: design accepted, implementation in progress.
**Depends on**: three-tier memory ([`tools.md`](tools.md)  - 2.10, [`FEATURE-GAPS.md`](FEATURE-GAPS.md)  - 1.22).

## 1. Why

The current memory system exposes three scopes (`session` / `workspace` / `global`) that the agent writes to *on impulse*: whatever the LLM decides is worth remembering in this turn gets a `memory_write` call. That is fine as a working notepad but has two failure modes:

1. **Duplication.** Two sessions in the same workspace independently learn the same fact and write it under two slightly different keys. Nothing prunes.
2. **Signal decay.** A one-off observation from a wrong branch gets stored with the same weight as a stable user preference reinforced across ten sessions. Nothing consolidates.

Codex's memory pipeline solves this by splitting write time from consolidation time:

- **Phase 1 (per-session extract).** After a session terminates, an LLM reads the rollout and produces a *structured* record  -  preferences, reusable knowledge, failures, references  -  as one file in a staging area. Never edits earlier rollouts. Empty output is valid ("this session had no durable signal").
- **Phase 2 (workspace consolidate).** A separate LLM reads the accumulated staging files for a workspace, merges duplicates, drops stale entries, and rewrites the workspace-scope `MEMORY.md` index + individual memory files. Runs lazily, coalesced across sessions.

We ship a **reduced version** of that pipeline  -  one that fits agent-kernel's single-user, file-only footprint (no state DB, no leases, no consolidation git baseline). The rest of this doc defines exactly what we ship and what we deliberately drop.

## 2. What we build

### 2.1 Storage layout

```
<workspace>/.agent-kernel/memory/
  MEMORY.md                                  -  index (existing; unchanged surface)
  <key>.md                                   -  agent-authored files (existing)
  .staging/
    <session-id>.md                          -  Phase-1 output, one per rollout
    .last-consolidated-at                    -  Phase-2 watermark (ISO-8601)
```

- `MEMORY.md` and `<key>.md` under `memory/` stay exactly as they are today. `memory_read` / `memory_write` / `memory_delete` continue to work.
- `.staging/` is Phase-1's output. Phase-2 consumes and prunes it. Users can `rm -rf .staging` at any point without corrupting anything else.
- `.last-consolidated-at` is Phase-2's opaque watermark. Missing = "never consolidated"; presence bounds "how far back Phase-2 needs to look."

Global scope (`~/.agent-kernel/memory/`) mirrors the same layout for cross-workspace memories. Session scope has no on-disk footprint and is out of scope for consolidation  -  session memory dies with the session.

### 2.2 Phase 1  -  per-session extract

**When it runs.** Immediately after `state.status` transitions to `done` for the first time in a session that has produced at least one `tool_result` and does not already have a staging file. Never runs for:

- ephemeral sub-agent sessions (they inherit the parent's memory and re-consolidating from a helper turn would double-count signal)
- sessions with fewer than N messages (default N=4; a single Q&A rarely has durable signal)
- sessions whose config has `memoryConsolidation: false`

**What it does.** Spawns a host-internal LLM call  -  same pathway as `compaction.ts`, not a sub-agent  -  with:

- system prompt: [`Phase1SystemPrompt`](#61-phase1-system-prompt) (adapted from codex)
- messages: the session's `state.messages` (filtered to skip system-prompt echoes and image blocks)
- tools: none (Phase-1 doesn't take actions)
- expected output: a single JSON object matching [`Phase1Output`](#62-phase1-output-schema)

The output is written to `<workspace>/.agent-kernel/memory/.staging/<session-id>.md`. The file's frontmatter carries `sessionId`, `generatedAt`, and `sourceEventsHash` (a stable hash of the rollout that produced it  -  lets Phase-2 detect "this session was re-forked and its rollout changed").

Empty JSON (`{"raw_memory":"","rollout_summary":"","rollout_slug":""}`) is a valid outcome; we still write the file so Phase-2 knows this session was seen and skips it. The file is one line: `# empty`.

**Failure handling.** If the LLM call fails, times out, or returns unparseable JSON, we log a warning and do not write a staging file. The next Phase-1 opportunity (e.g. a fork of this session that runs to done) will retry.

### 2.3 Phase 2  -  workspace consolidate

**When it runs.** On a `client:consolidate_memory` request from the dashboard (manual button), or lazily when Phase-1 runs and detects staging file count above a threshold (default 8). Never runs mid-turn; requires the caller's session to be at rest.

**Coalescing.** Only one Phase-2 job may be in flight per workspace at a time. A second request while one is running is a no-op  -  the running one already sees the newest staging files.

**What it does.**

1. Read every staging file under `.staging/`.
2. Read every existing `<key>.md` under the workspace memory root (that isn't in `.staging/`).
3. Load [`Phase2SystemPrompt`](#63-phase2-system-prompt) with the current memory files and staging files inlined.
4. Ask the LLM to emit a list of *file operations* against the memory root, in the same JSON-per-op shape the executor tools already use (`write { key, content }`, `delete { key }`). No free-form text output.
5. Apply the operations under a lock (per workspace):
   - Every `write` writes atomically via a temp file + rename.
   - Every `delete` unlinks.
   - Both update `MEMORY.md`'s index automatically (see  - 2.4).
6. On success: unlink every staging file that was seen, write `.last-consolidated-at`, broadcast `memory:consolidated`.
7. On failure: leave staging files intact so the next run retries the same input.

The LLM's output schema is validated (`op` is one of `write` / `delete` / `keep`; `key` matches `/^[a-zA-Z0-9_-]{1,64}$/`). Invalid ops are dropped with a warning; the rest still apply. This mirrors how we treat malformed tool inputs elsewhere  -  the reducer never trusts unstructured LLM output.

### 2.4 `MEMORY.md` maintenance

Today `MEMORY.md` is agent-authored  -  the agent writes it directly like any other memory key. Nothing enforces that it stays in sync with `<key>.md` files.

Post-consolidation, Phase-2 owns `MEMORY.md`. It:

- reads each surviving `<key>.md` file
- extracts the `description:` frontmatter field
- rewrites `MEMORY.md` as `- [Title](key.md)  -  description`, one line per key
- keeps the file below 200 lines (truncates by dropping least-recently-updated keys)

Agent-authored writes to `MEMORY.md` still work between Phase-2 runs (session-scope agents don't know consolidation is coming), and Phase-2 overwrites them. This is fine  -  `MEMORY.md` is an index, not memory content, so no signal is lost.

## 3. Wire protocol changes

Two new events, one new client message. All additive; nothing existing changes.

```typescript
// Dashboard  -  Host
export type ClientConsolidateMemory = {
  workspaceId: string
}

// Host  -  Dashboard (broadcast to all dashboard connections in a workspace)
export type MemoryConsolidatedEvent = {
  workspaceId: string
  stagedConsumed: number  // how many staging files were folded in
  filesWritten: number
  filesDeleted: number
  at: string  // ISO-8601
}

export type MemoryStagedEvent = {
  workspaceId: string
  sessionId: string
  slug: string
  at: string
}
```

No kernel events. The kernel is unchanged  -  consolidation happens entirely outside the pure reducer, same way `compaction.ts` sits outside it.

## 4. Configuration

Added to `~/.agent-kernel/config.json` (already exists for providers / hooks):

```json
{
  "memoryConsolidation": {
    "enabled": true,
    "minMessages": 4,
    "phase2Threshold": 8
  }
}
```

Off-switch is `enabled: false`. Config missing = defaults above. Per-session opt-out via config knob; nothing per-tool.

## 5. What we deliberately drop from codex's design

- **No state DB.** Filesystem is the source of truth. Watermark is a single file. Lease handling is a `.consolidating` lockfile with a PID and a timeout, not a DB row.
- **No parallel Phase-1 workers.** One session ends, one Phase-1 call fires. Total throughput is bounded by "how often you finish sessions," which is already low.
- **No git baseline / phase2_workspace_diff.md.** We reconcile in-place. Users who want history run `git init` in `.agent-kernel/memory/` themselves.
- **No usage/rank scoring, no `max_unused_days` pruning.** Phase-2 asks the LLM to prune; we don't second-guess it with heuristics. If users want to force-prune, they `rm` the file.
- **No sub-agent for Phase-2.** Direct host LLM call, same as `compaction.ts`. Sub-agents cost extra tokens and hide the operation from the event log we already have.
- **No per-rollout `rollout_summary` file.** Codex keeps three artifacts (raw_memory, rollout_summary, rollout_slug); we keep exactly one: the raw memory extract. The summary is redundant with the JSONL log we already have.

Rationale: the pipeline exists to make memory *more useful*, not to accumulate a second observability plane. Keep the surface small.

## 6. Prompts

### 6.1 Phase-1 system prompt

Verbatim (short version of codex's stage_one_system.md):

```
You are a Memory Extraction Agent. Read the conversation above and produce
one durable memory record that will help future sessions in the same
workspace.

Return a single JSON object with keys:
  raw_memory (string): the memory content, in Markdown. Include:
    - user preferences the user reinforced or corrected;
    - reusable procedural knowledge (specific commands, file paths, fix recipes)
      that took the agent effort to figure out;
    - failures and how to avoid them.
  rollout_slug (string): a filesystem-safe kebab-case slug summarising the
    session. <= 60 chars. Example: "wire-up-vitest-alias-resolution".
  discard (boolean): true if the session had no durable signal worth saving.
    When true, other fields may be empty strings.

Rules:
  - Do not invent facts. Only extract what happened.
  - Do not copy large tool outputs verbatim. Quote at most 200 chars.
  - Redact secrets: replace tokens/keys with [REDACTED_SECRET].
  - Prefer user quotes over agent summaries when capturing preferences.
  - If the session was pure Q&A or exploration with no adopted conclusion,
    set discard=true.

Reply with ONLY the JSON object. No prose, no markdown fences.
```

### 6.2 Phase-1 output schema

```typescript
type Phase1Output = {
  raw_memory: string
  rollout_slug: string
  discard: boolean
}
```

Written to disk as Markdown with frontmatter:

```markdown
---
sessionId: 01J...
generatedAt: 2026-07-06T13:04:00.000Z
sourceEventsHash: sha256-...
slug: wire-up-vitest-alias-resolution
discard: false
---

{raw_memory}
```

### 6.3 Phase-2 system prompt

```
You are a Memory Consolidation Agent. You are given:
  1. Existing memory files for a workspace (`<key>.md` with frontmatter).
  2. Newly-staged extracts from finished sessions (unstructured Markdown).

Your job: fold the staged extracts into the existing files. Merge
duplicates, split unrelated topics into separate files, delete entries
that have been superseded, and keep every unique durable signal.

Output a JSON array of operations. Each operation is one of:

  { "op": "write", "key": "<slug>", "description": "<one-line>",
    "type": "user|feedback|project|reference", "content": "<full markdown>" }
  { "op": "delete", "key": "<slug>" }
  { "op": "keep", "key": "<slug>" }  // no change; opt-in explicit no-op

Rules:
  - Keys match /^[a-zA-Z0-9_-]{1,64}$/.
  - Prefer editing over creating: if a staged extract adds signal to an
    existing file, write the merged content under the existing key.
  - Delete entries that have been contradicted by new signal, or that
    have been split into multiple more-specific keys.
  - Every existing file must appear in the output as `write`, `delete`,
    or `keep`. Files without an op are treated as `keep`.

Reply with ONLY the JSON array. No prose.
```

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Phase-1 LLM call errors | No staging file. Next session-done retries independently. |
| Phase-1 returns malformed JSON | Log warning; skip. Same as above. |
| Phase-2 LLM call errors | Staging files preserved; `.last-consolidated-at` unchanged. Next trigger retries the same input. |
| Phase-2 returns an op with invalid key | That op dropped; other ops applied. Warning logged. |
| Host crashes mid Phase-2 apply | Lockfile has stale PID; next start detects and reclaims. Some ops applied, some not  -  Phase-2 is idempotent (staging files not consumed until success), so the next run reconciles. |
| Two workspaces share the same memory root | Not supported. Each workspace's `.agent-kernel/memory/` is single-writer. |

## 8. Testing plan

- **Kernel:** no changes, no tests.
- **Host:** new module `host/src/memory-consolidation.ts` with unit tests:
  - Phase-1 fires exactly once per session-done (idempotent).
  - Phase-1 skips ephemeral / short / opted-out sessions.
  - Phase-2 coalescing: two concurrent triggers  -  one run.
  - Phase-2 apply is atomic under lockfile.
  - Malformed LLM output  -  partial apply.
- **Executor:** no changes.
- **Dashboard:** manual "Consolidate memory" button in Inspector's Memory tab. New event surfaced as a toast.

## 9. Open questions (won't block v1)

- Should Phase-2 run for global scope? Currently workspace-only. Global memory grows slower and cross-workspace signal is harder to reason about.
- Should we expose Phase-1 output shape to `agent`-builtin sub-agents for structured hand-off? Deferred  -  Phase-1 is not on the sub-agent hot path.

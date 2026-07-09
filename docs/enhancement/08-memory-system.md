# Memory System

Status: provenance/index implemented; retrieval pipeline incomplete
Priority: 8
Last reviewed against implementation: 2026-07-09

## Why This Matters

Agent memory matters for repeated work: project conventions, user preferences,
past fixes, and durable facts. Bad memory is dangerous because stale or
untrusted memories silently poison context. A production memory design needs
provenance, scope, scoring, decay, and inspectability.

## Design Principle

Memory should be retrieved and assembled by host-side context engineering. The
kernel may record memory tool events, but it should not own ranking, embedding,
or long-term storage policy.

## Memory Types

Use explicit scopes:

- Session memory: facts useful within one session.
- Workspace memory: project conventions and commands.
- User memory: stable user preferences.
- Eval memory: disabled by default for benchmarks unless explicitly testing
  memory behavior.

Each memory record should include content, scope, source session/event, created
time, updated time, confidence, and tombstone status.

## Retrieval Pipeline

1. Build query from active user turn and current task metadata.
2. Filter by scope and workspace.
3. Retrieve candidates by lexical and vector search.
4. Rerank with recency, source reliability, and task relevance.
5. Fit selected memories into a budget partition.
6. Add memory contribution metadata to message assembly trace.

Implemented host-side lexical retrieval prototype:

```bash
agent-kernel-host enhancement memory retrieve \
  --root-dir runs/memory \
  --workspace-root /path/to/workspace \
  --include-global \
  --query "typescript imports" \
  --max-tokens 2048 \
  --max-hits 8
```

`retrieveMemory` reuses `buildMemoryIndex` so tombstoned notes are excluded, then
tokenizes the query and scores each active note by lexical overlap, with small
recency (30-day half-life) and confidence boosts. Results are fitted into an
explicit token budget and written as a `memory-retrieval.json` artifact under
the run directory. The output records `usedTokens`, `droppedForBudget`, and
low-cardinality reason codes (`empty_query`, `no_active_memories`,
`no_lexical_matches`, `budget_dropped_hits`, `hits_selected`). It does not
mutate kernel state or inject memories into prompts — dashboards and eval
runners can inspect which memories the host *would* include.

## Write Policy

Avoid automatic memory writes for every message. Good candidates:

- Explicit user preference.
- Repeated project command or convention verified by tool output.
- Stable repository-specific fact.
- Correction from user after agent mistake.

Memory writes should be visible and reversible in dashboard.

Implemented memory index export:

```bash
agent-kernel-host enhancement memory index \
  --root-dir runs/memory \
  --workspace-root /path/to/workspace \
  --include-global
```

The command reads workspace/global `.agent-kernel/memory/*.md` files, extracts
frontmatter such as `name`, `description`, `type`, `source`, `confidence`,
`generatedAt`, and `sessionId`, and writes `memory-index.json`. It does not add
memory to kernel state and does not inject memory into prompts. It is a derived
artifact for dashboard provenance, eval reproducibility, and cleanup tooling.

Workspace/global delete is implemented as a tombstone, not a hard erase. The
executor moves the active markdown note under `.agent-kernel/memory/.tombstones/`
and writes a JSON tombstone with `scope`, `key`, `deletedAt`, original path, and
archive path. Normal `read`/`list` only sees active notes, while
`memory-index.json` includes both `status: "active"` and `status: "tombstoned"`
entries so deletion remains auditable and reversible without adding memory state
to the kernel protocol.

Implemented message assembly observability also accounts for memory. When a
session already contains a structured `memory` tool call and its matching tool
result, the live `message-assembly` artifact includes a `memory` contribution
bucket and a `memory.contribution` pipeline stage. This is provenance and budget
metadata only; it does not create a hidden memory channel or mutate the kernel
state machine.

Implemented eval memory snapshot metadata: every SWE-bench prediction run
records a first-class `memoryPolicy` field on the `experiment.json` artifact,
built via `deriveEvalMemoryPolicy`. The default for benchmark runs is
`mode: disabled` with reason codes `memory_mode:disabled`,
`benchmark_isolation`, and `memory_disabled`. Callers can opt into
`workspace_only`, `workspace_and_global`, or `snapshot_pinned` policies and
attach an active/tombstoned entry count derived from a `memory-index.json`
snapshot. This gives every eval trial a reproducible declaration of what
memory could reach the model, without adding memory state to the reducer.

Implemented runtime enforcement of `memoryPolicy.mode: disabled`. When a
session record carries `memoryPolicy.mode === 'disabled'`, the host loop
intercepts `memory` tool calls that target `scope: workspace` or `scope: global`
and short-circuits them with an `EMEMDISABLED` error before the executor sees
the request. Session-scope memory remains available because it lives inside
kernel state, not on disk. `SessionStore` exposes `setMemoryPolicy(sessionId,
policy)` so eval runners and benchmark drivers can attach the policy at trial
start without teaching the kernel about memory scopes. Reason codes remain the
same as the eval `memoryPolicy` metadata (`memory_mode:disabled`,
`benchmark_isolation`, `memory_disabled`) so a benchmark trial's runtime
enforcement and its reproducibility record share a single low-cardinality
vocabulary.

Implemented stale and conflict detection in `memory-index.json`. In addition
to the existing entries and text warnings, the index now emits two structured
lists: `staleWarnings` and `conflictWarnings`. Stale detection flags any
active entry whose `generatedAt` timestamp is older than the configured
threshold (default 90 days) with reason code `stale_memory`. Conflict
detection flags two active entries with the same key across the workspace and
global scopes with reason code `duplicate_key_across_scopes`, and two active
entries that share a `name` frontmatter field with reason code
`duplicate_name`. Tombstoned entries are excluded from both signals because a
deleted note cannot poison future prompts. The dashboard Memory tab surfaces
counts for both categories alongside the existing active/tombstoned counters
so operators can spot cross-scope drift without reading the JSON directly.

The dashboard artifact explorer includes a `Memory` tab that loads
`memory-index.json` artifacts on demand. It summarizes active/tombstoned,
workspace/global, and warning counts, then shows each memory key with scope,
status, description, confidence, source session, delete timestamp, and archive
path. This keeps memory provenance inspectable as artifact data instead of
adding another live protocol surface.

## Testing Plan

- Unit tests for scope filtering.
- Implemented unit tests for workspace memory index export.
- Implemented unit tests for memory contribution metadata in message assembly
  artifacts.
- Implemented unit tests for workspace/global delete tombstones and tombstone
  indexing.
- Tests that benchmark mode disables cross-task memory by default.
- Retrieval ranking tests with stale conflicting facts.
- Implemented browser tests for memory provenance views.

## Non-Goals

- Do not treat memory as hidden system prompt text.
- Do not let memory bypass context budget accounting.
- Do not add vector database dependencies to the kernel.

## Current Implementation Alignment

### Implemented In Code

The current memory implementation emphasizes provenance and auditability:

- `agent-kernel-host enhancement memory index` reads workspace/global
  `.agent-kernel/memory/*.md` files and writes `memory-index.json`.
- Frontmatter fields such as `name`, `description`, `type`, `source`,
  `confidence`, `generatedAt`, and `sessionId` are preserved in the index.
- Deletes are represented as tombstones under `.agent-kernel/memory/.tombstones`
  and indexed with `status: tombstoned` rather than being silently removed.
- Message assembly artifacts include a `memory` contribution bucket only when
  structured memory tool calls/results already exist in kernel messages.
- Dashboard Memory tab renders active/tombstoned counts, scope, confidence,
  source metadata, delete timestamp, and archive path.
- Browser enhancement e2e verifies memory index generation and dashboard
  rendering from real files.

### Important Gaps

- The lexical retrieval prototype is inspectable but not yet wired into the
  live message assembly pipeline: it produces a `memory-retrieval.json`
  artifact and dashboard action, but the host does not automatically inject
  the top hits into the next prompt.
- There is no memory write UX with explicit user approval and provenance review.

### Production Quality Criteria

Memory is production-level when:

- Retrieval uses explicit scope filters, ranking signals, and context budget
  accounting.
- Memory insertions are visible in message assembly artifacts with source refs
  and token cost.
- Writes require clear provenance and can be reviewed, accepted, edited, or
  tombstoned from the dashboard.
- Eval/benchmark runs can disable memory or pin a memory snapshot.
- Conflicting memories are detected and surfaced instead of silently poisoning
  prompts.

### Next Implementation Steps

1. Wire the lexical retrieval prototype into a preflight step that fits
   `memory-retrieval.json` results into the active message assembly budget
   partition when the operator opts in.
2. Add dashboard memory write/review/tombstone workflow.

# Web-native paths — implementation plan

Companion to `docs/planning/enhancement/12-web-native-path-handling.md`. This file
enumerates the concrete files to touch and the order of work.

## Order of operations

1. **Host: new upload primitives** (independently testable).
2. **Host: derivable-path fallbacks on existing endpoints** (additive,
   backward compatible).
3. **Dashboard: `<ContentSourcePicker>` shared component** (generalized
   from the existing 3-tab instances picker).
4. **Dashboard: wizard rewrite** (drop path inputs, use derived state).
5. **Dashboard: `EnhancementActionPanel` field-metadata migration**
   (per-action field type: replace `path` with `upload` where applicable).
6. **Tests: unit + integration + e2e**.
7. **Doc updates in 01/03/04**.

## Step 1 — Host: new upload primitives

### `packages/host/src/eval/swebench-patches-source.ts` (NEW)

```ts
export type PatchesSource =
  | { kind: 'inline'; patches: Record<string, string> }
  | { kind: 'zip'; zipBase64: string }

export interface ResolveInput {
  rootDir: string
  runId: string
  source: PatchesSource
}
export interface ResolveResult {
  patchesDir: string
  instanceCount: number
  bytes: number
}
export async function resolveSweBenchPatches(input: ResolveInput): Promise<ResolveResult>
```

Behavior:
- Path convention: `<rootDir>/<runId>/patches/`.
- Inline: for each `<instance_id, content>` pair, sanitize the instance
  id (must match `/^[A-Za-z0-9._-]+$/`), refuse traversal, cap 2 MB per
  patch, cap 200 patches per request, write `<instance_id>.diff`.
- Zip: base64-decode, then a stream-based unzip using
  `unzipper` (already vendored? — check `packages/host/package.json`.
  If not: use Node's built-in `zlib` + a minimal `unzip` primitive, or
  add the smallest viable dep. Prefer `adm-zip` since it's tiny and
  synchronous; guard the size cap before unzipping).
- Total decompressed size cap: 20 MB. If exceeded, throw
  `PatchesSourceError(413)` mirroring `InstancesSourceError`.
- Reject any zip entry that:
  - contains `..` or absolute path
  - does not end in `.diff` or `.patch`
  - has a name that doesn't match instance-id pattern (strip extension
    first)
- Returns absolute `patchesDir` path.

### `packages/host/src/eval/swebench-results-source.ts` (NEW)

Mirror of the above, but writes under
`<rootDir>/<runId>/grade-results/`. Accepts:
- inline JSON/JSONL blob (for small runs)
- zip
- (later) `sessionId` — not for this feature

The uploaded content is *not* validated schema-wise here; that's
`ingestSweBenchResults`'s job.

### `packages/host/src/http/routes.ts` (EDIT)

Add two new action dispatches after `swebench-resolve-instances`
(lines 629-669), following the same pattern:

```ts
if (action === 'swebench-upload-patches') { … }
if (action === 'swebench-upload-results') { … }
```

Extend `EnhancementActionRequest` type (line ~130) with:
- `zipBase64?: string`
- `patches?: Record<string, string>`
- `resultsContent?: string`
- `sessionLogContent?: string`
- `sessionLogContents?: Record<string, string>`
- `patchContent?: string`
- `promptContent?: string`
- `responseContent?: string`
- `baselineSummaryContent?: string`
- `candidateSummaryContent?: string`
- `catalogContent?: string`
- `heartbeatContent?: string`
- `chaosReportContent?: string`
- `rewardContent?: string`
- `tokenSegmentsContent?: string`
- `sidecarContent?: string`
- `sessionId?: string`

Every new field is optional to preserve back-compat.

### Derivable-path fallbacks (EDIT)

For each of these actions, if the current required-path field is
missing but `runId` and `rootDir` are known, silently derive from the
canonical layout:

| Action | Missing field | Fallback |
| --- | --- | --- |
| `swebench-infer-patches` | `patchesDir` | `<root>/<runId>/patches` |
| `swebench-infer-patches` | `instancesJsonl` | `<root>/<runId>/instances.jsonl` |
| `swebench-grade-command` | `predictionsPath` | `<root>/<runId>/predictions.jsonl` |
| `swebench-ingest-results` | `resultsDir` | `<root>/<runId>/grade-results` |
| `swebench-export-session` | `modelPatchPath` | require `modelPatchContent` instead |
| `swebench-export-session` | `sessionLogPath` | require `sessionLogContent` OR `sessionId` |

Missing-derivation cases produce an HTTP 400 with a message pointing at
the previous step ("run `swebench-upload-patches` first, or provide
patchesDir explicitly").

### Non-SWE-bench derivation

For eval/profile/memory/ops actions, add a `resolveContentToPath()`
helper in a new `packages/host/src/http/content-inputs.ts` that:

- If a `*Path` field is provided, use it as-is.
- If a corresponding `*Content` field is provided, write it under
  `<root>/uploads/<action>/<uuid>/<field>.<ext>` and return that path.
- If a `sessionId` is provided (for session-related actions), resolve
  via the existing sessions directory.

Each action dispatch that currently calls `requiredString(body.xPath,
'xPath')` becomes `await resolveContentToPath(body, {kind: 'xPath',
allowedExts: ['.jsonl'], sessionsDir: payloads.sessions})`.

## Step 2 — Dashboard: `<ContentSourcePicker>` shared component

`packages/dashboard/src/features/artifacts/ContentSourcePicker.tsx` (NEW)

Generalizes the existing 3-tab UI from
`ArtifactExplorerDialog.tsx:1382…`. Props:

```ts
export interface ContentSourcePickerProps {
  testIdPrefix: string
  supportedModes: readonly ('paste' | 'upload' | 'huggingface' | 'server-session')[]
  onResolve: (source: ResolvedSource) => Promise<{ path: string; summary: string }>
  pasteConfig?: { placeholder: string; rows?: number }
  uploadConfig?: { accept: string; maxBytes: number }
  hfConfig?: { defaultDataset?: string }
  sessionConfig?: { listSessions: () => Promise<SessionSummary[]> }
}
```

The existing instances-source UI is refactored to use this component.

## Step 3 — Dashboard: wizard rewrite

`packages/dashboard/src/features/artifacts/ArtifactExplorerDialog.tsx`

- `WizardShared` shape:
  - Remove `patchesDir`, `predictionsPath`, `resultsDir`
  - Add `patchesDir?: string`, `predictionsPath?: string`,
    `resultsDir?: string` (optional; auto-populated on upload success,
    displayed as read-only breadcrumbs)
- `WizardInferStep` (line 1665):
  - Delete `<LabeledInput label="Patches Dir">` and
    `<LabeledInput label="Predictions Path">` (lines 1693-1694)
  - Insert `<ContentSourcePicker>` for patches with modes
    `['upload', 'paste']` (paste = per-instance <textarea>, or a simple
    inline JSON blob)
  - After successful upload, show `patches → …` breadcrumb
  - `submitInfer()` no longer sends `patchesDir` — server derives
- `WizardGradeStep` (line 1705):
  - Delete `Predictions Path` and `Max Workers` from top-level
  - Move `Max Workers` under an "Advanced" `<details>` block
  - Server derives `predictionsPath`
- `WizardIngestStep` (line 1749):
  - Delete `Results Dir`
  - Insert `<ContentSourcePicker>` with modes `['upload', 'paste']`
  - `submitIngest()` sends the uploaded `resultsDir`
- `WizardReviewStep` (line 1796): no removals; already read-only.

## Step 4 — Dashboard: `SweBenchPlanPanel`

`ArtifactExplorerDialog.tsx:904`

- Delete `rootDir` input entirely
- Move `repoCacheDir` under "Advanced"
- Wire `instancesJsonl` through `<ContentSourcePicker>` (was
  path-input; the wizard already uses picker; unify to the shared
  component)

## Step 5 — Dashboard: `EnhancementActionPanel` field metadata

Current metadata (line ~1992):

```ts
{ action: 'swebench-infer-patches', label: '…', fields: [
  { key: 'instancesJsonl', label: 'Instances JSONL', required: true },
  { key: 'patchesDir', label: 'Patches Dir', required: true },
  …
]}
```

New field type discriminator on each `EnhancementActionField`:

```ts
type EnhancementActionField =
  | { kind: 'text'; key, label, required?, defaultValue?, placeholder?, list?, boolean?, numeric? }
  | { kind: 'upload'; key, label, contentKey: string, accept: string, maxBytes: number, required?: boolean }
  | { kind: 'session'; key, label, contentKey: string, required?: boolean }
```

Migration per action:

| Action | Field | Kind |
| --- | --- | --- |
| `eval-score-session` | `sessionLogPath` | `upload` → `sessionLogContent` |
| `eval-score-session` | `patchPath` | `upload` → `patchContent` |
| `eval-score-session` | `workspaceRoot` | REMOVE (host-configured) |
| `eval-judge-score` | `promptPath` | `upload` → `promptContent` |
| `eval-judge-score` | `responsePath` | `upload` → `responseContent` |
| `eval-compare-runs` | `baselineSummaryPath` | `upload` → `baselineSummaryContent` |
| `eval-compare-runs` | `candidateSummaryPath` | `upload` → `candidateSummaryContent` |
| `swebench-infer-patches` | `patchesDir` | `upload` (zip) → `zipBase64` |
| `swebench-export-session` | `sessionLogPath` | `session` (dropdown) |
| `swebench-export-session` | `modelPatchPath` | `upload` → `modelPatchContent` |
| `swebench-ingest-results` | `resultsDir` | `upload` (zip) → `zipBase64` |
| `swebench-grade-command` | `predictionsPath` | REMOVE (derived from runId) |
| `profile-*` all `*Path` | | `upload` → `*Content` |
| `memory-*` `workspaceRoot` | | REMOVE |
| `reliability-*` `sessionLogPath` | | `session` OR `upload` |
| `reliability-*` `heartbeatPath` | | `upload` |
| `reliability-*` `chaosReportPath` | | `upload` |
| `tool-catalog-diff` `*CatalogPath` | | `upload` |
| `trace-export-*` `sessionLogPath` | | `session` |
| `rollout-export-*` `sessionLogPath` | | `session` |
| `rollout-export-*` `rewardPath` | | `upload` |
| `rollout-export-*` `tokenSegmentsPath` | | `upload` |
| `rollout-export-adapter` `sidecarPath` | | `upload` |
| `rollout-verify-reward` `trialPath` | | `upload` |
| `rollout-verify-reward` `scorePath` | | `upload` |
| `subagents-graph` `sessionsDir` | | REMOVE (host-configured) |
| `trace-export-otlp` `sessionLogPath` | | `session` |
| `trace-export-otlp` `headersFilePath` | | `upload` (small text) |
| `artifacts-manifest` `outputPath` | | REMOVE (auto-derived) |
| `artifacts-prune` `outputPath` | | REMOVE (auto-derived) |

Global `rootDir` (line 1947): REMOVE.

The `EnhancementActionPanel` renders each field via a switch on `kind`:
- `text` → `<LabeledInput>` as today
- `upload` → mini `<ContentSourcePicker>` (single mode = upload, no
  paste unless a small text field)
- `session` → `<select>` populated via `GET /sessions/summary`

## Step 6 — Tests

### Host unit tests

- `packages/host/src/eval/swebench-patches-source.test.ts` (NEW)
  - inline: writes files, rejects bad instance id, rejects >2MB
    per patch, rejects >20MB total, rejects >200 entries
  - zip: happy path, path traversal, wrong extension, oversize
- `packages/host/src/eval/swebench-results-source.test.ts` (NEW)
  - inline JSONL blob
  - zip with `instance_results.jsonl` at top level
  - traversal guard
- `packages/host/src/http/content-inputs.test.ts` (NEW)
  - path passthrough, content upload → path derivation, sessionId
    resolution
- `packages/host/src/server.test.ts` (EDIT)
  - Extend with a test that `swebench-infer-patches` succeeds with no
    `patchesDir` when `<root>/<runId>/patches/` exists
  - Same for `swebench-grade-command` derived `predictionsPath`
  - Same for `swebench-ingest-results` derived `resultsDir`
  - Test both new upload endpoints (inline and zip)

### Dashboard unit tests

- `packages/dashboard/src/features/artifacts/ContentSourcePicker.test.tsx`
  (NEW) — tab switch, upload triggers, paste triggers, error surfacing
- `packages/dashboard/src/features/artifacts/ArtifactExplorerDialog.test.tsx`
  (EDIT)
  - Assert `Patches Dir` / `Predictions Path` / `Results Dir` inputs no
    longer exist in the wizard
  - Assert paste + upload flow in Infer step works (mocked fetch)
  - Assert breadcrumb pill renders after upload

### E2E

`scripts/verify-dashboard-enhancement-actions.mjs` (EDIT):

- Existing `verifyRunBenchmarkWizard` extended:
  - After Plan step, upload a two-instance patches zip (build in-memory
    using `zlib` or write a tar; use `adm-zip`), trigger Infer, expect
    breadcrumb, no `patchesDir` typed
  - After Grade command generation, upload a mock `results.jsonl` zip,
    trigger Ingest, expect the summary
  - Assert `document.querySelectorAll` for the deleted testids
    (`run-benchmark-wizard-patches-dir`, `run-benchmark-wizard-predictions-path`,
    `run-benchmark-wizard-results-dir`) returns 0

## Step 7 — Doc updates

- `docs/planning/enhancement/01-swe-bench-evaluation-integration.md` — add a
  "Web-native flow" section referencing feature 12
- `docs/planning/enhancement/03-agent-eval-benchmark-platform.md` — same
- `docs/planning/enhancement/04-agentic-rl-rollout-export.md` — same for the
  rollout actions

## Risk register

- **Zip decompression**: use `adm-zip` (widely used, small, sync). Cap
  before extraction using the CentralDir header size fields so a zip bomb
  cannot force a huge decompress. Reject `ZIP64` inflated sizes above
  20 MB before decompressing any entry.
- **Base64 explosion**: cap the request body at 30 MB in the HTTP layer
  (base64 overhead = 33%; effective 20 MB payload). Reject early with 413.
- **Windows path traversal on Linux**: normalise entries with
  `path.posix.normalize`, reject any entry that starts with `..`,
  contains `\`, or is absolute.
- **Session dropdown scale**: paginate at 100 sessions if
  `/sessions/summary` returns more; ordered by mtime descending.
- **CLI regression**: existing tests that pass `--patches-dir` explicitly
  keep passing (fields remain accepted, just optional).

## Rollout order (single PR is fine — features are internal & pre-1.0)

- Land upload endpoints first, then wizard, then action panel. Every
  intermediate commit keeps existing tests green because the changes
  are additive on the host side and the UI reads new state that's still
  backed by the same on-disk artifacts.

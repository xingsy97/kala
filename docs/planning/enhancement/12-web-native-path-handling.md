# 12 — Web-Native Path Handling

## Status

**Design** — 2026-07-10. Motivation: the dashboard's SWE-bench wizard and
`EnhancementActionPanel` currently expose 70+ text inputs that require the
user to type a server-side filesystem path (e.g. `/path/to/patches`,
`/tmp/results/{runId}`, `/path/to/predictions.jsonl`). Web users have no
shell access to the host process and cannot reasonably produce these paths.

Concrete complaint: after resolving `instances.jsonl` via the new browser
picker (feature 01 rev 2), step 2 (**Predictions**) of the guided wizard
still asked the user to type a `Patches Dir` and a `Predictions Path`. Step
3 (**Grade**) then asked for `Predictions Path` again. Step 4
(**Ingest**) asked for `Results Dir`. Every single one is a server-side
path that a browser-only user cannot produce.

The `swebench-resolve-instances` endpoint (feature 01 rev 2) already
demonstrated the correct pattern for **inputs**: accept content
(upload / paste / dataset fetch), write to a canonical location, return
the resolved path. This document generalizes that pattern to *all* eval
and ops actions.

## Principle

> The browser must never ask the user to type a path on the host filesystem.

Every path-shaped field in a dashboard input form falls into exactly one of
these categories, and there is a canonical treatment for each:

| Category | Example | Treatment |
| --- | --- | --- |
| **A. Output path** | `predictionsPath`, `summaryPath`, `planPath`, `verdictPath` | Host derives from `<artifactRoot>/<runId>/…`; UI never renders as input. |
| **B. Derivable input** | `predictionsPath` used by `swebench-grade-command` after `swebench-infer-patches` ran | Host derives from prior step's canonical output; UI carries the value silently in wizard state. |
| **C. Uploadable content** | `patchesDir`, `resultsDir`, `sessionLogPath`, `modelPatchPath`, per-file scoring paths | UI provides upload (single-file, zip, or drag-and-drop) or paste (small text). Host writes to canonical layout. |
| **D. Server-managed root** | `rootDir`, `workspaceRoot` | UI never asks. Server uses configured `AGENT_KERNEL_ARTIFACTS_DIR`. |
| **E. Genuine reference to server state** | Existing on-disk `sessionLogPath` (an ongoing session) | UI picks from a **server-listed** dropdown, not a text input. |

## Non-goals

- The **CLI stays path-based**. `agent-kernel-host eval swebench infer --patches-dir /x`
  and friends do not change. The CLI is where power users compose paths;
  the web is where non-power users click through.
- No file-system browser widget. All picking is either "upload from local
  machine" (browser file picker) or "pick from server-known artifacts"
  (dropdown populated by an `/artifacts/*` list endpoint), never a free
  path traversal.
- No new persistent stores. Everything writes under the already-configured
  artifact root (`AGENT_KERNEL_ARTIFACTS_DIR`).
- No secrets on disk. HuggingFace tokens and OTLP headers stay per-request.

## Canonical layout extensions

Existing (from `sweBenchRunLayout` in `packages/host/src/eval/swebench.ts`):

```
<artifactRoot>/<runId>/
├── instances.jsonl        # resolved by feature 01 rev 2
├── predictions.jsonl      # written by infer/export
├── experiment.json
├── progress.json
├── summary.json
├── worker-plan.json
├── swebench-results.json  # written by ingest
├── trials/…
├── traces/…
└── artifacts/…
```

New for feature 12:

```
<artifactRoot>/<runId>/
├── patches/               # NEW: written by swebench-upload-patches
│   ├── <instance_id>.diff
│   └── …
├── grade-results/         # NEW: written by swebench-upload-results
│   ├── instance_results.jsonl
│   └── … (whatever the harness produced)
└── inputs/                # ancillary uploads (existing dir, extended)
    ├── model-patch.diff
    ├── session-log.jsonl
    └── …
```

For non-run-scoped uploads (e.g. `eval-judge-score` where there's no runId
yet), a per-action bucket is used:

```
<artifactRoot>/uploads/<action>/<uuid>/{prompt,response,patch,…}
```

## Endpoint changes

### `swebench-upload-patches` (new)

`POST /enhancement/action` with:

```json
{
  "action": "swebench-upload-patches",
  "runId": "my-run",
  "source": "zip" | "inline",
  "zipBase64": "…"                     // when source=zip
  "patches": {                           // when source=inline
    "astropy__astropy-12907": "diff --git a/x b/x\n…"
  }
}
```

Server:
1. Ensures `<root>/<runId>/patches/` exists.
2. Zip path: decompress, accept only entries ending in `.diff`/`.patch`,
   reject if any entry escapes the target directory or exceeds a per-file
   or per-archive size cap.
3. Inline path: write each key as `<instance_id>.diff`.

Response:
```json
{
  "action": "swebench-upload-patches",
  "patchesDir": "/artifacts/my-run/patches",
  "instanceCount": 12,
  "bytes": 123456
}
```

Size limits: 20 MB per archive, 2 MB per patch (mirrors
`swebench-resolve-instances`).

### `swebench-upload-results` (new)

Same shape but writes under `<root>/<runId>/grade-results/`, then hands the
directory to `ingestSweBenchResults`. Response:

```json
{
  "action": "swebench-upload-results",
  "resultsDir": "/artifacts/my-run/grade-results",
  "summaryPath": "…",
  "resolved": 7,
  "trialCount": 12
}
```

### `swebench-infer-patches` (change: `patchesDir` becomes derivable)

The host already accepts a `patchesDir`. Behavior change: when `patchesDir`
is omitted, derive from `<root>/<runId>/patches`. When present, keep
current behavior for CLI users. UI never sends it — always relies on the
canonical layout established by the upload endpoint.

Same treatment for `instancesJsonl` — if omitted, derive from
`<root>/<runId>/instances.jsonl` (already written by
`swebench-resolve-instances`).

### `swebench-grade-command` (change: `predictionsPath` becomes derivable)

If omitted, derive from `<root>/<runId>/predictions.jsonl`.

### `swebench-ingest-results` (change: `resultsDir` becomes derivable)

If omitted, derive from `<root>/<runId>/grade-results`. Errors surface
clearly if the directory does not exist yet (upload step was skipped).

### Content-based upload for non-runId actions

For eval-scoring / trace-export / rollout / reliability actions that
today take a `sessionLogPath` or similar, we accept `sessionLogContent` as
inline JSONL. Host writes to
`<root>/uploads/<action>/<uuid>/session-log.jsonl` and passes that path
down. For actions taking multiple files (e.g. `reliability-chaos-replay`
with `sessionLogPaths`), the client can bundle them in a single JSON
`{ [name]: content }` object.

For actions that reference an existing server-side session
(recommended: `trace-export-session` in production use), an alternative
`sessionId` field is accepted and the host resolves the log path from the
sessions directory. This is category E — the UI presents a dropdown of
active sessions, not a text input.

### Removal / hiding of user-visible path inputs

The following fields are **removed** from wizard step forms:
- `patchesDir` (replaced by upload)
- `predictionsPath` in both Infer and Grade steps (derived)
- `resultsDir` (replaced by upload)
- `rootDir` in `SweBenchPlanPanel` (server-managed)
- `repoCacheDir` (moved to "Advanced" collapsible; empty defaults to
  host-configured cache)

The following fields are **removed** from `EnhancementActionPanel`
forms and replaced with uploaders or dropdowns:

- All `*Path` fields taking session logs → upload OR server session
  dropdown
- All `*Path` fields taking small text files (patches, prompts,
  responses, catalogs) → paste OR upload
- All `workspaceRoot` fields → dropdown of workspaces already known to
  the host

The `rootDir` "global" field at the top of `EnhancementActionPanel` is
removed entirely; the host always uses its configured artifact root.

## API compatibility

Path-based inputs remain accepted by all endpoints. This preserves:
- CLI callers (`agent-kernel-host eval …`).
- Existing e2e scripts and integration tests.
- CI pipelines that already pass explicit paths.

New optional fields (`source`, `zipBase64`, `patches`, `sessionLogContent`,
`sessionId`) are additive; missing them falls back to current behavior.

## UX conventions

- **Uploader widget** (new component `<ContentSourcePicker>`) has three
  tabs identical to the instances picker: Upload / Paste / (optional)
  Server-known. Sizes: 20 MB archive, 2 MB single-file, no server call
  until the user clicks "Use this content" (idempotent).
- **Derived-path badges**: instead of hiding paths entirely, the wizard
  shows a subdued monospace pill `patches → …/patches` under the step
  once the upload succeeds. This gives the user a debuggable breadcrumb
  without asking them to type it. Same treatment for `predictions`,
  `results`, and `summary`.
- **Advanced disclosure**: rare-but-valid overrides (`workspaceRoot`,
  `repoCacheDir`, custom `rootDir` for multi-tenant hosts) live behind a
  `<details>Advanced</details>` block so the default flow contains zero
  path text inputs.
- **Errors**: 413 uploads render "File too large (max 20MB)". Missing
  derivations render "Run the previous step first" and highlight the
  offending wizard step.

## Testing

- Host unit tests for each new upload endpoint mirror the
  `swebench-instances-source` tests: happy path, malformed archive,
  size limit, path-traversal attempt, missing runId.
- Wizard component tests assert the removed path inputs are gone and the
  new upload widgets fire the correct actions.
- E2E extension (`scripts/verify-dashboard-enhancement-actions.mjs`) drives
  the full 5-step wizard using only browser-native actions: paste
  instances → upload patches (zip) → generate grade command → upload
  results (zip) → view review. No filesystem paths typed anywhere.

## Migration

- Feature 01 (SWE-bench integration) doc updated to reference feature 12
  for the browser workflow; CLI examples stay the same.
- Feature 03 (Eval platform) and feature 04 (Rollout export) docs
  updated to mention the new upload endpoints where applicable.
- No data migration; all changes are additive to the on-disk layout.

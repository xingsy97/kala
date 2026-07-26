# Unified Benchmark Orchestrator

Status: implementation plan
Owner: Agent RunLab
Historical-data policy: read-only import

## Objective

Make Dashboard and CLI equal clients of one durable benchmark service. A run must be reproducible, observable, resumable, officially graded when the benchmark has an official grader, and inspectable down to each backend/session/patch/test result.

This replaces the current split where the mature Agent RunLab and Claude Code SWE-bench runners are available through CLI while the Dashboard wizard defaults to an empty-patch smoke command.

## Non-negotiable requirements

1. `agent-runlab` is the default production backend. Smoke is explicitly marked non-evidence.
2. Agent backends are configurable and comparable: Agent RunLab, Claude Code SDK, custom command, then Codex/OpenCode when adapters are added.
3. Dashboard and CLI submit the same immutable run specification and read the same durable state.
4. Official scoring is separate from inference. Predictions are never presented as resolved before official result ingest.
5. Every instance retains the session/transcript, final diff, stdout/stderr, trace, usage, timing, backend metadata, and grading evidence.
6. Runs survive browser disconnects. Host restart recovery must never silently repeat ambiguous provider work.
7. Historical experiments are read-only. Import creates a new index containing references and hashes; it never writes under the historical directory.
8. Bad cases are first-class, filterable, annotatable, comparable across backends, and exportable.

## Architecture

```text
Dashboard Wizard ─┐
                  ├─ BenchmarkRunService ─ durable run store/event log
CLI ──────────────┘          │
                             ├─ BenchmarkAdapter registry
                             │   ├─ SWE-bench
                             │   ├─ Terminal-Bench
                             │   ├─ ProgramBench
                             │   └─ SWE-Marathon
                             │
                             ├─ AgentBackend registry
                             │   ├─ Agent RunLab
                             │   ├─ Claude Code SDK
                             │   ├─ Custom command
                             │   └─ Smoke (non-evidence)
                             │
                             ├─ official/native grader
                             └─ artifacts / bad cases / comparisons
```

The pure-function Agent Kernel remains benchmark-agnostic. Orchestration belongs in Host.

## Canonical run specification

```typescript
type BenchmarkRunSpec = {
  schemaVersion: 1
  runId: string
  benchmark: 'swebench' | 'terminal-bench' | 'program-bench' | 'swe-marathon'
  dataset: { source: string; split?: string; instanceIds?: string[]; limit?: number }
  backends: Array<{
    id: 'agent-runlab' | 'claude-code' | 'custom-command' | 'smoke'
    model: string
    label?: string
    config: Record<string, unknown>
  }>
  execution: {
    maxWorkers: number
    maxTurns: number
    timeoutMs: number
    inactivityTimeoutMs?: number
    retryLimit: number
    skipCompleted: boolean
  }
  grading: { mode: 'official' | 'native' | 'deferred' }
  createdAt: string
}
```

The accepted spec is written once to `run.json`; runtime status is written separately. Secrets are represented only by credential references and are redacted from persisted command previews.

## Agent backend contract

```typescript
interface AgentBackend {
  readonly descriptor: AgentBackendDescriptor
  validate(config: AgentBackendConfig): Promise<ValidationResult>
  runInstance(input: AgentInstanceInput, signal: AbortSignal): Promise<AgentInstanceResult>
}
```

`AgentInstanceResult` includes backend/version/model/config hash, final patch, session and trace references, usage, duration, stdout/stderr references, and a typed completion/failure classification.

Backend capability metadata drives both CLI validation and Dashboard forms. Backend-specific fields are retained inside `config`; shared fields remain canonical.

### Agent RunLab adapter

Extract the proven behavior from `bin/run-agent-runlab-swebench.ts`: real Host loop, built-in tools, isolated benchmark memory, allow-all benchmark approval mode, bounded turns/time, session JSONL and trace preservation.

### Claude Code adapter

Extract `bin/run-claude-code-swebench.ts`: Claude Agent SDK invocation, isolated settings sources, explicit model/base URL, transcript/debug/result preservation, cancellation and error classification.

### Custom command adapter

Keep shell compatibility, but require an explicit command. Capture stdout/stderr and environment contract. It must never be the implicit production default.

### Smoke adapter

Produces an empty patch solely to verify plumbing. Persist `evidenceLevel: smoke`; block official-result comparison and headline metrics.

## Durable lifecycle

Run states:

```text
draft → preparing → running → predictions_ready → grading → ingesting
      → analyzing → completed
      ↘ failed / cancelled / interrupted
```

Instance/backend states:

```text
queued → preparing_workspace → agent_running → patch_captured
       → grading → resolved / unresolved
       ↘ empty_patch / timeout / agent_error / tool_error /
          patch_apply_error / grader_error / cancelled
```

Each transition is appended to `events.jsonl` with a monotonic sequence. `status.json` and `progress.json` are rebuildable projections. Live deltas are ephemeral and never advance the durable reconnect cursor.

## Storage layout

```text
benchmark-runs/<run-id>/
  run.json
  status.json
  events.jsonl
  environment.json
  predictions.jsonl
  summary.json
  comparisons.json
  instances/<instance-id>/<backend-id>/
    input.json
    status.json
    session.jsonl
    trace.jsonl
    final.diff
    stdout.log
    stderr.log
    usage.json
    result.json
  grading/<backend-id>/...
  analysis/
    badcases.jsonl
    failure-summary.json
    annotations.jsonl
```

Artifacts may reference files outside this root only for read-only legacy imports. API responses expose artifact IDs/relative references, not arbitrary filesystem paths.

## API and CLI

HTTP:

```text
GET    /benchmark/backends
GET    /benchmark/adapters
POST   /benchmark/runs
GET    /benchmark/runs
GET    /benchmark/runs/:id
POST   /benchmark/runs/:id/start
POST   /benchmark/runs/:id/cancel
POST   /benchmark/runs/:id/retry
POST   /benchmark/runs/:id/grade
POST   /benchmark/runs/:id/analyze
GET    /benchmark/runs/:id/events?after=<seq>&limit=<n>
GET    /benchmark/runs/:id/instances
GET    /benchmark/runs/:id/badcases
POST   /benchmark/import/legacy-swebench
```

CLI uses the same service layer:

```text
agent-kernel-host benchmark backends
agent-kernel-host benchmark create --config run.json
agent-kernel-host benchmark start <run-id>
agent-kernel-host benchmark watch <run-id> --json
agent-kernel-host benchmark status <run-id> --json
agent-kernel-host benchmark cancel <run-id>
agent-kernel-host benchmark retry <run-id> --failed
agent-kernel-host benchmark grade <run-id>
agent-kernel-host benchmark analyze <run-id>
agent-kernel-host benchmark import-legacy-swebench <path>
```

Existing benchmark-specific CLI commands remain compatibility shims until the shared service is proven.

## Dashboard

Wizard steps:

1. Dataset: benchmark, source, split and selected instances.
2. Backends: one or more backend/model configurations; compare mode is natural, not a separate runner.
3. Execution: concurrency, limits, timeout, retry, resume and grading mode.
4. Run: durable per-instance/backend progress with links to real sessions/logs/patches.
5. Grade: preflight, official command/job progress, reports and ingest.
6. Results: metrics, cost/latency, pairwise matrix and evidence level.
7. Bad cases: taxonomy, official failed tests, patch/session comparison, annotations and export.

The current smoke recipe moves under an Advanced/Development group and is never preselected.

## Historical experiment protection

Protected root:

`experiments/evals/2026-07-17-swebench-agent-vs-claude`

Policy:

- No orchestrator code writes below this root.
- Import reads known manifests/summaries/comparison rows and validates referenced artifacts.
- Import output goes to the configured new benchmark artifact root.
- The imported run records `source.kind=legacy-readonly`, canonical source path, source summary hashes and import timestamp.
- Imported values retain their original grading authority and evidence labels.
- Tests snapshot source checksums before and after import.

Baseline root-file hashes captured before implementation:

```text
run-summary.json                    43387216d58094b6e58a7f1cd74e5b3ab94304cf5dbbbc05cd264a94bf1d15b7
model-controlled-run-summary.json  2fcc7b657707cbbed99b50c98f1e7fa6deecd23e913fc940a887a14f02ade8a9
failure-taxonomy.json              b5348505611d0bfa9844dac7c73b3b6094d173e61315cc99a897b491cf95d0c1
manifest.md                        2689c2e6faf72a0d10c25ee1b01a4de6bcf1ff95a2315d0b941bc147638d9fcd
pairwise-comparison.jsonl          20fe09d0be71d0b3cf0eff7b523b25523bac9b8441896df7cac6f76ae54b5664
model-controlled-comparison.jsonl  d6ce0bdc7d1b82a1fea11f1214b209460fdf2cbe272b8cd2cbbd6f5c7fa3dff8
```

## Verification ladder

1. Unit: schema, reducer, event store, registry, capability validation and failure taxonomy.
2. Integration: both Dashboard HTTP and CLI call the same service and produce byte-compatible canonical metadata.
3. Fixture E2E: two local SWE-bench-shaped repositories, Agent RunLab backend, smoke backend and deterministic grader.
4. Legacy import: import the 30-case historical summaries read-only and display 23/30 plus Sonnet/Opus controlled comparisons and seven annotated bad cases.
5. Real paid smoke: one real SWE-bench Lite instance with Agent RunLab and Claude Code on the same model, then official Docker grading.
6. Comparison: compare the new one-case result with the matching historical case without changing either source run.
7. Remote: deploy to `box_agent`, run from Dashboard, reconnect during execution, and verify results/patch/session/bad case in the UI.

## Completion criteria

- Dashboard production default executes Agent RunLab, not `true`.
- CLI and Dashboard create the same run schema and durable state.
- Multi-backend same-instance comparison works.
- Official result claims appear only after ingest.
- Browser/Host restart paths are tested.
- Historical import is checksum-proven read-only.
- At least one newly executed real instance is officially graded and visible in Dashboard with its session, patch, evidence and bad-case classification.


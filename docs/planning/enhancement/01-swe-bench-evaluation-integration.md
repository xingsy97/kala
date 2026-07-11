# SWE-bench Evaluation Integration

Status: implemented as an artifact-driven SWE-bench adapter; official grading remains external/opt-in
Priority: 1
Last reviewed against implementation: 2026-07-10

## Why This Matters

SWE-bench is the most direct way to prove that `agent-kernel` is more than a UI
demo. It measures whether an agent can fix real GitHub issues by producing a
patch that passes repository tests in a reproducible Docker environment.

For the target roles, this demonstrates context engineering, tool use, code
sandboxing, long-running task reliability, benchmark engineering, and measurable
agent quality. It also creates training and debugging artifacts for agentic RL.

## Production References

- Official SWE-bench repo [1].
- Official docs [2].
- Official evaluation guide [3].
- Official harness entry point: `python -m swebench.harness.run_evaluation`
- Official prediction format:

```json
{
  "instance_id": "repo_owner__repo_name-issue_number",
  "model_name_or_path": "your-model-name",
  "model_patch": "diff --git ..."
}
```

Important resource facts from the official repo: SWE-bench evaluation uses
Docker, recommends x86_64, about 120GB free storage, 16GB RAM, and 8 CPU cores,
and stores results under `evaluation_results` with logs under `logs/`.

The official harness is patch-centric. It applies `model_patch` to the original
checkout inside Docker, runs the generated `/eval.sh`, parses test logs, and
marks an instance resolved only when the issue-specific `FAIL_TO_PASS` tests
pass and the `PASS_TO_PASS` tests keep passing. An agent completing its own run
or leaving a non-empty diff is not a SWE-bench score.

## Design Principle

Do not reimplement SWE-bench grading. `agent-kernel` should implement inference,
patch extraction, trace capture, and result ingestion. The official Docker
harness remains the grading source of truth.

Use precise product vocabulary:

- **Prediction**: an official JSONL row with `instance_id`,
  `model_name_or_path`, and `model_patch`.
- **Agent completion**: the agent command exited and a patch artifact was
  captured. This can still be an empty patch, bad patch, or test failure.
- **Official grading**: `python -m swebench.harness.run_evaluation` ran in a
  Docker-capable environment.
- **Resolved**: the official harness result was ingested and says the instance
  resolved. Do not show `resolved` before ingestion.

The benchmark adapter must stay above the kernel. SWE-bench does not add reducer
states, protocol messages, or benchmark-specific effects. The host materializes
repositories, runs an operator-provided agent command, exports official
prediction rows, and ingests official result artifacts.

Runtime boundaries are explicit: browser-safe protocol/log types stay on
`@agent-kernel/shared`; Node-only artifact and eval helpers live on
`@agent-kernel/shared/enhancement`. This prevents dashboard bundles from
accidentally importing filesystem or hashing code used by benchmark exporters.

## Proposed Architecture

Add a benchmark adapter package or host module, tentatively
`@agent-kernel/eval-swebench`, with three responsibilities:

1. Load SWE-bench instances from Hugging Face datasets or an exported JSONL.
2. Run `agent-kernel` against each instance and produce official prediction
   JSONL rows.
3. Invoke or wrap the official SWE-bench harness and ingest its results.

The flow is:

1. Load an instance with fields such as `instance_id`, repo, base commit,
   problem statement, and test patch metadata.
2. Materialize an isolated workspace for the agent. The workspace must be a
   normal git repo so existing read/edit/bash tools work unchanged.
3. Create an `agent-kernel` session bound to that workspace.
4. Inject a benchmark task prompt that contains the issue statement and explicit
   instruction to edit the repo and leave a final patch in the worktree.
5. Let the agent run with normal tools, approval policy, compaction, and
   dashboard trace capture.
6. At terminal status or timeout, compute `git diff --binary` from the original
   checkout.
7. Emit one prediction JSONL row:
   `{ instance_id, model_name_or_path, model_patch }`.
8. Call the official harness:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path runs/swebench/<run_id>/predictions.jsonl \
  --max_workers 8 \
  --run_id <run_id>
```

9. Parse `evaluation_results/<run_id>/results.json` and
   `instance_results.jsonl`.
10. Attach result metadata to the agent session trace and eval run index.

## CLI Surface

Keep the CLI explicit and close to the official harness:

```bash
agent-kernel eval swebench infer \
  --dataset princeton-nlp/SWE-bench_Lite \
  --split test \
  --instance-ids sympy__sympy-20590 \
  --model gpt-5.5 \
  --run-id 2026-07-09-smoke

agent-kernel eval swebench grade \
  --dataset princeton-nlp/SWE-bench_Lite \
  --predictions runs/swebench/2026-07-09-smoke/predictions.jsonl \
  --max-workers 8 \
  --run-id 2026-07-09-smoke

agent-kernel eval swebench run \
  --dataset princeton-nlp/SWE-bench_Lite \
  --split test \
  --limit 50 \
  --model gpt-5.5 \
  --max-workers 4
```

`infer` produces predictions. `grade` delegates to SWE-bench. `run` does both.

Current implemented host CLI surface starts with the reproducible local pieces:

```bash
agent-kernel-host eval swebench infer \
  --root-dir runs/swebench \
  --run-id smoke-001 \
  --dataset princeton-nlp/SWE-bench_Lite \
  --split test \
  --model gpt-5.5 \
  --instances-jsonl fixtures/swebench-lite.jsonl \
  --patches-dir runs/tmp/patches \
  --instance-ids sympy__sympy-20590

agent-kernel-host eval swebench run \
  --root-dir runs/swebench \
  --run-id smoke-001 \
  --dataset princeton-nlp/SWE-bench_Lite \
  --model gpt-5.5 \
  --instances-jsonl fixtures/swebench-lite.jsonl \
  --patches-dir runs/tmp/patches \
  --max-workers 8
```

`infer` currently supports an offline, CI-friendly prediction path: load local
SWE-bench-shaped JSONL instances, read `<instance_id>.diff` or
`<instance_id>.patch`, write official `predictions.jsonl`, per-trial JSON, diff
artifacts, and `summary.json`. `run` performs the same inference step and then
prints the official SWE-bench harness command. It only executes Docker grading
when `--execute` is provided.

The manual export path remains useful for turning an already-run agent session
into a benchmark prediction:

```bash
agent-kernel-host eval swebench export-session \
  --root-dir runs/swebench \
  --run-id smoke-001 \
  --dataset princeton-nlp/SWE-bench_Lite \
  --split test \
  --model gpt-5.5 \
  --instance-id sympy__sympy-20590 \
  --session-log ~/.agent-kernel/sessions/<session>.jsonl \
  --model-patch runs/tmp/final.diff

agent-kernel-host eval swebench grade \
  --dataset princeton-nlp/SWE-bench_Lite \
  --predictions runs/swebench/smoke-001/predictions.jsonl \
  --run-id smoke-001 \
  --max-workers 8

agent-kernel-host eval swebench ingest-results \
  --root-dir runs/swebench \
  --run-id smoke-001 \
  --results-dir evaluation_results/smoke-001

agent-kernel-host eval swebench agent-infer \
  --root-dir runs/swebench \
  --run-id smoke-001 \
  --dataset princeton-nlp/SWE-bench_Lite \
  --model agent-kernel-gpt-5.5 \
  --instances-jsonl fixtures/swebench-lite.jsonl \
  --agent-command 'agent-kernel-run --prompt-file "$AGENT_KERNEL_SWEBENCH_PROMPT_FILE"' \
  --repo-cache-dir runs/repos \
  --max-workers 4 \
  --skip-completed \
  --timeout-ms 1800000
```

`export-session` writes the same eval-visible run artifacts as the automated
inference paths: official `predictions.jsonl`, `experiment.json`, per-instance
`trials/<instance_id>.json`, `summary.json`,
`traces/<instance_id>.openinference.json`, and
`artifacts/<instance_id>/final.diff`. The trial includes both trace and diff
artifact refs, so the dashboard can navigate from a SWE-bench instance to the
exported OpenInference trace and final patch without guessing paths.

`grade` emits structured JSON by default with `gradingAuthority` set to
`official-swebench-harness`, `gradingMode` set to `dry-run`, `requiresDocker:
true`, the argv array, and the shell command. Add `--execute` to actually run
the Docker harness. This avoids accidentally triggering an expensive SWE-bench
evaluation when the operator only wants to inspect the command.

`ingest-results` parses official harness output artifacts, currently
`instance_results.jsonl`, `instance_results.json`, or `results.json` shapes. It
maps official resolved/unresolved results into existing `EvalTrial` files,
updates `summary.json`, and keeps the raw rows in `swebench-results.json`. It
also writes each official per-instance result row to
`artifacts/<instance_id>/swebench-result.json` and copies matching small harness
text/json/log files under `artifacts/<instance_id>/harness/`. Those refs are
attached to the trial so the dashboard can open official harness evidence from
the same artifact store as prompts, diffs, traces, and agent logs. It does not
re-grade patches or reinterpret repository tests.

All host and dashboard actions now preserve this distinction in their responses
and labels. Prediction-producing actions return `gradingStatus: not_graded`.
Result ingestion returns `gradingStatus: ingested`. Dashboard text uses
"predictions completed" for agent execution and reserves "resolved" for
ingested official harness output.

`agent-infer` is the implemented agent-driven materialization adapter. It loads
local SWE-bench-shaped JSONL instances, clones either `repo_path`, a
`--repo-cache-dir` match, or the GitHub `repo`, checks out `base_commit`, writes
a versioned prompt artifact, runs an operator-provided agent command in the
workspace, captures stdout/stderr artifacts, and extracts `git diff --binary` as
the official prediction patch. The agent command receives:

- `AGENT_KERNEL_SWEBENCH_INSTANCE_ID`
- `AGENT_KERNEL_SWEBENCH_REPO`
- `AGENT_KERNEL_SWEBENCH_PROMPT`
- `AGENT_KERNEL_SWEBENCH_PROMPT_FILE`
- `AGENT_KERNEL_SWEBENCH_SESSION_LOG`

When the agent command writes an `agent-kernel` JSONL session log to
`$AGENT_KERNEL_SWEBENCH_SESSION_LOG`, the runner reads it, records the child
session id on the trial, exports an OpenInference trace to
`traces/<instance_id>.openinference.json`, and attaches the trace as a trial
artifact ref. This is the "managed session" mode: the runner owns the session
log path and trace destination, so any well-behaved agent command produces the
same replayable dashboard evidence as `export-session` without operator wiring.
When no session log is written, the trial still succeeds with prompt, stdout,
stderr, diff, and workspace-metadata artifacts. The default session log
directory is `<runDir>/sessions/` and can be overridden with
`--session-logs-dir`.

This is intentionally an adapter, not a benchmark-specific kernel mode. The
official harness remains responsible for grading; the adapter only prepares a
real workspace and prediction row.

`agent-infer` also writes a run-level progress artifact:

```text
runs/swebench/<run_id>/progress.json
```

This file is the production control-plane view for long benchmark inference. It
records schema version, run id, dataset, split, model, run status, start/update
timestamps, selected/queued/running/skipped/completed/failed/timed-out counts,
`maxWorkers`, and one compact record per instance. Instance records contain the
instance id, scheduling status, optional failure label, duration, metrics, and
artifact refs for prompt, logs, final diff, and workspace metadata.

The progress artifact solves three operational problems without changing the
kernel protocol:

- interrupted runs can be inspected before `summary.json` is final;
- `--skip-completed` is auditable because skipped instances remain visible;
- dashboard/eval tooling can show live queue health and failure taxonomy from a
  single small JSON document instead of walking every trial artifact.

The artifact manifest classifies this file as `eval_progress`, so the dashboard
can discover it like any other run artifact. It is derived state only; replay
and official SWE-bench grading do not depend on it.

`plan` is the implemented resource planning command:

```bash
agent-kernel-host eval swebench plan \
  --root-dir runs/swebench \
  --run-id lite-plan \
  --dataset princeton-nlp/SWE-bench_Lite \
  --model agent-kernel \
  --instances-jsonl data/swebench-lite.jsonl \
  --max-workers 8 \
  --timeout-ms 900000 \
  --repo-cache-dir runs/repo-cache
```

It writes `runs/swebench/<run_id>/worker-plan.json` with selected instance
count, deterministic round-robin worker shards, Docker and per-instance git
workspace isolation hints, timeout, optional repo cache location, and warnings
such as empty selection or over-provisioned workers. The plan is an artifact for
CI/manual orchestration and future distributed workers; it does not add
SWE-bench scheduling state to the kernel protocol.

## CI and Release Validation

Implemented CI coverage is split into a cheap deterministic smoke path and an
explicit manual official-harness path.

The default CI job runs:

```bash
pnpm run verify:swebench-smoke
```

That script creates local SWE-bench-shaped fixture instances, generates official
`predictions.jsonl` through `agent-kernel-host eval swebench infer`, ingests
official-style `instance_results.jsonl` rows through `ingest-results`, compares
baseline and candidate summaries, and verifies that `grade` builds the official
`python -m swebench.harness.run_evaluation` command without executing Docker.
This catches adapter, artifact, summary, and CLI drift in pull requests without
requiring Docker image builds or a benchmark-scale runner.

`.github/workflows/eval-smoke.yml` adds a scheduled/manual workflow. The
scheduled job runs the same fixture smoke. The manual job can either print the
official harness command or execute it with `execute_swebench_harness=true`.
This keeps expensive external grading opt-in while still making the production
command visible in CI logs.

## Output Layout

Use a stable run directory:

```text
runs/swebench/<run_id>/
  experiment.json
  instances.jsonl
  predictions.jsonl
  trials/
    <instance_id>.json
  traces/
    <instance_id>.openinference.json
  artifacts/
    <instance_id>/final.diff
    <instance_id>/workspace-metadata.json
  swebench/
    evaluation_results/...
    logs/...
  summary.json
```

`config.json` records model, prompt version, tool policy, compaction policy,
timeout, max turns, git base, and package versions. This is required for
reproducible comparisons.

## Prompt and Tool Policy

The benchmark prompt should be versioned. It should contain:

- The problem statement.
- Repository path and base commit.
- Clear rule that the final answer is not the patch; the workspace diff is.
- Permission to inspect files and run tests.
- Instruction to keep changes minimal and avoid unrelated cleanup.

The agent should use the same tool registry as normal sessions. Benchmark mode
may add timeouts and deny network by default unless a benchmark variant permits
network. The kernel should not know that a session is a SWE-bench run.

## Dashboard Integration

The dashboard has a dedicated Eval entry point in the workbench toolbar and
command palette. It opens the artifact explorer directly in Eval mode, so eval
remains a read-only artifact projection instead of becoming a second runtime
state model. The same dialog can still open in generic Artifacts mode for raw
manifest inspection.

The Eval view consumes the host artifact manifest, finds eval `summary.json`,
`progress.json`, comparison, and trial artifacts, then loads details through the
bounded `/artifacts/content` endpoint. It renders run-level metrics, live
progress-only runs, prediction artifacts, official harness results, and comparison deltas without adding eval
state to the kernel or Socket.IO protocol.

Implemented dashboard surfaces:

- Run table: dataset, split, model, pass rate, completed, failed, timed out,
  worker count, and run status when progress artifacts exist.
- Instance table: `instance_id`, status, resolved label, duration, failure type,
  and artifact count.
- Instance detail: final diff, OpenInference trace, official SWE-bench evidence,
  harness logs, agent logs, prompt, workspace metadata, and raw trial JSON.
- Linked session action: trials that include `sessionId` can jump back to the
  corresponding dashboard session with no new backend endpoint.
- Comparison view: baseline/candidate summaries, numeric deltas, failure delta
  chips, and a compact delta bar chart for resolved, failed, timed out, and pass
  rate changes.

The dashboard should show official SWE-bench result labels separately from
agent execution labels. For example, `agent_done` does not imply `resolved`.

## Failure Taxonomy

Use low-cardinality failure labels:

- `agent_timeout`
- `agent_error`
- `empty_patch`
- `patch_apply_failed`
- `test_failed`
- `harness_error`
- `infrastructure_error`
- `resolved`

Map official harness results into this taxonomy without hiding raw harness logs.

## Testing Plan

Start with tests that do not require full SWE-bench resources:

- Unit test prediction row generation from a synthetic git diff.
- Unit test empty patch handling.
- Unit test run directory metadata and summary aggregation.
- Integration test against a tiny local git fixture that mimics one benchmark
  instance.
- Smoke test using the official gold patch command:

```bash
python -m swebench.harness.run_evaluation \
  --predictions_path gold \
  --max_workers 1 \
  --instance_ids sympy__sympy-20590 \
  --run_id validate-gold
```

Full CI should not run SWE-bench by default because Docker image builds are too
expensive. Instead, add a scheduled or manually triggered workflow for
SWE-bench Lite smoke runs.

## Implementation Phases

Shared foundation now exists in `@agent-kernel/shared/enhancement`: SWE-bench
prediction JSONL helpers, official harness command construction, eval
experiment/trial metadata types, artifact references, redaction, and trace span
export. The CLI runner builds on these helpers rather than creating a separate
benchmark schema. The default `@agent-kernel/shared` entry remains browser-safe
for dashboard and executor protocol imports.

Phase 1: prediction exporter.
Implemented for local/offline fixtures: load instance JSONL, read patch files,
write official JSONL, persist trial metadata and summary, and label empty
patches without failing the whole run.

Phase 2: official harness wrapper.
Implemented command construction and optional execution through
`python -m swebench.harness.run_evaluation`. Result ingestion is implemented for
official result files, updates per-trial/summary metadata after the harness has
produced results, and preserves official result/log evidence as trial artifact
refs.

Phase 3: SWE-bench Lite single-instance run.
Implemented for local JSONL instances and external agent commands through
`agent-infer`: materialize a git workspace, run the command with prompt/repo env
vars, capture logs, extract `git diff --binary`, write official predictions,
and persist trial metadata. The next step is binding this adapter directly to a
managed `agent-kernel` host/executor session for full dashboard replay.

Phase 4: batch scheduler.
Implemented first host-side scheduler controls for `agent-infer`: bounded
`--max-workers`, stable output ordering, and `--skip-completed` resume behavior
that reuses existing trial and prediction rows without rerunning completed
instances. The adapter also emits `progress.json` for live queue visibility and
`worker-plan.json` for resource-aware sharding. Actual distributed execution can
consume that plan outside the kernel.

Phase 5: dashboard eval explorer.
Implemented read-only summary, comparison, and instance-level trial views through
the artifact explorer, with dedicated Eval toolbar and command palette entries.
The dashboard loads run summaries, progress files, trial JSON artifacts, and
comparison deltas through the bounded artifact content endpoint without adding
eval state to the kernel protocol. Trial details now derive grouped artifact
sections from existing refs, with prominent entries for final patches,
OpenInference traces, official SWE-bench result evidence, harness logs, agent
logs, prompts, and metadata. Trials with `sessionId` expose a direct linked
session action, and comparison rows include both numeric deltas and compact delta
bars. The grouping is UI-only: it uses `kind`, `mediaType`, and path conventions
from preserved artifacts rather than adding a benchmark-specific protocol field.

Phase 6: CI eval smoke and manual official-harness workflow.
Implemented through `scripts/verify-swebench-smoke.mjs`, default CI, and
`.github/workflows/eval-smoke.yml`. The default path validates the adapter
without Docker; the manual path can execute official SWE-bench grading when the
runner has the required Docker, CPU, memory, and storage resources.

## Non-Goals

- Do not clone SWE-bench grading logic.
- Do not add SWE-bench concepts to the kernel event union.
- Do not hide official harness logs behind simplified summaries.
- Do not treat benchmark pass rate as the only useful metric; failed traces are
  the main debugging and RL data source.

## Current Implementation Alignment

### Implemented In Code

The repository currently has a real SWE-bench adapter layer in the host, not a
toy benchmark schema. The implemented pieces are:

- CLI commands under `agent-kernel-host eval swebench ...` for `plan`, `infer`,
  `run`, `agent-infer`, `export-session`, `grade`, and `ingest-results`.
- Official prediction JSONL generation with rows shaped as
  `{ instance_id, model_name_or_path, model_patch }`.
- Offline patch inference from local SWE-bench-shaped `instances.jsonl` plus a
  patch directory.
- Existing-session export into SWE-bench prediction/trial artifacts.
- Official harness command construction through
  `python -m swebench.harness.run_evaluation`, with Docker execution only when
  explicitly requested.
- Official-style result ingestion from `instance_results.jsonl`,
  `instance_results.json`, or `results.json` shaped outputs.
- Agent-command based materialization through `agent-infer`: clone/materialize a
  repo, write a prompt artifact, run an operator-provided command, capture logs,
  extract `git diff --binary`, and emit prediction/trial/progress artifacts.
- Worker planning through `worker-plan.json`, with selected instance count,
  deterministic shards, worker count, timeout, and resource hints. Each plan
  is also registered in a `runs/registry/run-index.json` artifact keyed by
  `runId`, so dashboards and follow-up tooling can discover recent SWE-bench
  plans without re-parsing every run directory.
- CI smoke coverage through `pnpm run verify:swebench-smoke` and the manual
  `.github/workflows/eval-smoke.yml` workflow.
- Dashboard Eval mode that renders summaries, progress, trials, comparisons,
  worker plans, final diffs, trace refs, harness evidence, and linked sessions.
- Dashboard action forms for cheap artifact actions: create worker plan, infer
  offline patches, export session, ingest results, and generate the official
  grade command.
- Dashboard `Run Benchmark` wizard that composes those actions into a Plan  - 
  Predictions  -  Grade  -  Ingest  -  Review flow with a numbered progress rail,
  propagated run id/dataset/predictions/results state between steps, an inline
  Grading Handoff panel showing the official
  `python -m swebench.harness.run_evaluation` command, and a Reset control.
- Real browser coverage through `pnpm run verify:dashboard-enhancement-actions`
  for the dashboard-visible SWE-bench actions and artifact rendering.

### Current Website Workflow

The dashboard now offers two entry points for a SWE-bench run:

1. Guided path: open `Eval` from the toolbar or command palette, expand
   `Run Benchmark (guided)`, then step through Plan  -  Predictions  -  Grade
    -  Ingest  -  Review. Each step composes one existing artifact action and
   propagates the run id, dataset, predictions path, and results directory
   between steps without introducing a new backend endpoint. The Grade step
   surfaces the official `python -m swebench.harness.run_evaluation` command
   inline as a Grading Handoff panel; the operator runs it locally or in CI
   and returns to the Ingest step, whose Results Dir input is pre-filled
   from the grade response.
2. Direct-action path (unchanged): the `Create SWE-bench Worker Plan` panel
   and the Eval Artifact Actions form remain available for one-off actions
   or for users who prefer explicit control over each API call.

Long-running agent batches and Docker-based official grading still happen
outside the browser (CLI/CI). The wizard makes that handoff explicit rather
than hiding it behind an in-browser scheduler.

### Important Gaps

- Guided wizard is implemented but browser-triggered long-running agent
  shard execution is not. That is acceptable for now, but the UI must keep
  the CLI/CI handoff explicit rather than pretending to schedule shards.
- `worker-plan.json` is not yet consumed by a managed distributed worker
  runtime. It is a planning artifact for CLI/manual orchestration.
- `agent-infer` now runs external commands with a managed session-log slot
  (`AGENT_KERNEL_SWEBENCH_SESSION_LOG`) so any well-behaved runner produces
  sessionId + OpenInference trace on the trial. It is not yet bound to an
  in-process host loop for one shard, but the artifact contract for
  dashboard replay is fully in place.
- Full official Docker SWE-bench grading is manual/opt-in and not part of the
  default e2e or CI path because of resource requirements.
- Dataset loading is local JSONL first. Hugging Face dataset integration remains
  a planned Python/platform component.

### Production Quality Criteria

This feature reaches production level when:

- A user can run a small benchmark from the dashboard without understanding
  internal action names.
- Long-running execution has resumable run status, per-worker logs, and clear
  failure labels.
- Official grading remains delegated to SWE-bench but can be launched or handed
  off through a first-class CI/manual workflow from the UI.
- Every trial links prediction, final patch, session log, trace, harness result,
  and failure taxonomy.
- E2e coverage includes missing artifact directories, failed planning inputs,
  successful planning, prediction export, result ingestion, and report rendering.

### Next Implementation Steps

1. Extend the managed session-log slot into a first-class in-process host loop
   integration when a real workload demands it (currently the artifact contract
   already gives dashboard replay from any well-behaved agent command).
2. Add a real-world e2e that exercises the full browser wizard through dry-run
   grading and result ingestion.

## References

[1] https://github.com/SWE-bench/SWE-bench

[2] https://www.swebench.com/SWE-bench/

[3] https://www.swebench.com/SWE-bench/guides/evaluation/

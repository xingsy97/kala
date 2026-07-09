# Agent Evaluation Platform

Status: partially implemented; artifact platform exists, scheduler incomplete
Priority: 3
Last reviewed against implementation: 2026-07-09

## Why This Matters

SWE-bench is the first benchmark target, but a production agent platform needs a
general eval system: datasets, experiments, repeated runs, metrics, regressions,
trace comparison, and failure analysis. Without this layer, every prompt, tool,
or model-router change becomes anecdotal.

## Production References

- LangSmith positions evals around datasets, evaluators, experiments, and
  comparisons across runs.
- Phoenix provides tracing, datasets, experiments, prompt management, and evals
  over traces.
- OpenTelemetry GenAI defines a `gen_ai.evaluation.result` event for recording
  evaluation outcomes.
- SWE-bench provides the concrete external verifier for coding patch tasks.

## Design Principle

Evals should be an adapter layer over real sessions and traces. The kernel must
not know about datasets, scoring, or benchmark names.

Browser and host boundaries matter here. Eval and artifact writers use Node IO,
hashing, and filesystem paths, so they are exported from
`@agent-kernel/shared/enhancement`. The default `@agent-kernel/shared` entry is
kept browser-safe for dashboard protocol types. This prevents product UI code
from depending on evaluator internals and keeps CI able to catch accidental
cross-boundary imports through the dashboard production build.

## Core Concepts

Dataset: a versioned collection of tasks. A task has input, optional fixture
setup, evaluator config, tags, and expected constraints.

Experiment: a run of one agent configuration over one dataset version.

Trial: one task execution under an experiment.

Evaluator: deterministic or model-assisted scorer that consumes the final
workspace, trace, messages, and artifacts.

Metric: numeric or categorical output with low-cardinality labels.

Artifact: diff, logs, request bodies, screenshots, terminal output, traces.

## Data Model

Store eval runs outside session JSONL:

```text
runs/eval/<experiment_id>/
  experiment.json
  dataset.snapshot.jsonl
  trials/<trial_id>/
    session.jsonl
    trace.otlp.jsonl
    artifacts/
    scores.json
  summary.json
```

`experiment.json` should record model, provider, prompt version, tool registry
version, compaction config, approval mode, code commit, package versions, and
environment. This is essential for comparing runs honestly.

## Evaluator Types

Start with deterministic evaluators:

- Patch applies.
- Unit tests pass.
- Expected file changed.
- No forbidden file changed.
- No timeout.
- No unhandled agent error.

Then add model-assisted evaluators only where deterministic checks are
insufficient:

- Answer helpfulness.
- Retrieval grounding.
- Instruction following.
- Trace quality labels.

Model-assisted evaluators must save their full judge prompt, model, response,
score, and explanation as artifacts.

## Metrics

Use metrics that connect quality, latency, token pressure, and reliability:

- Pass/resolution rate.
- Timeout rate.
- Agent error rate.
- Tool error rate.
- Patch apply failure rate.
- Median and p95 wall time.
- Median and p95 input/output tokens.
- Tokens and wall time per resolved task.
- LLM calls per task.
- Tool calls per task.
- Compaction frequency.

## Dashboard

Add an Eval section:

- Experiment list with pass rate, token usage, duration, model, commit.
- Dataset/task filters.
- Regression compare between two experiments.
- Trial detail linking session replay, trace waterfall, final output, artifacts,
  and scores.
- Failure clustering by low-cardinality taxonomy.

## Implementation Phases

The shared enhancement foundation already defines `EvalExperiment`, `EvalTrial`,
artifact references, JSONL serialization helpers, and session span export. The
eval runner should persist those types directly and keep benchmark-specific
fields inside adapter metadata.

The first concrete adapter is implemented under `@agent-kernel/host` as
`eval/swebench`: it creates run directories, writes experiment metadata,
serializes official SWE-bench prediction JSONL, exports session traces as
OpenInference-shaped artifacts, and builds the official harness command.

The generic deterministic scorer is implemented as a host-side artifact runner:

```bash
agent-kernel-host enhancement eval score-session \
  --root-dir runs/eval/session-score \
  --session-log ~/.agent-kernel/sessions/<session>.jsonl \
  --patch runs/tmp/final.diff \
  --instance-id sympy__sympy-20590
```

It currently evaluates low-risk checks that do not require benchmark-specific
logic:

- `patch.non_empty`
- `agent.no_llm_error`
- `tools.no_failed_results`
- optional `session.final_status_done` with `--require-done`

The output is `scores.json`, containing individual scorer results plus a
low-cardinality summary label such as `resolved`, `empty_patch`, or
`agent_error`. This is intentionally separate from official benchmark grading:
SWE-bench pass/fail still comes from the official Docker harness.

Implemented run comparison command:

```bash
agent-kernel-host enhancement eval compare-runs \
  --root-dir runs/eval/compare \
  --baseline-summary runs/swebench/base/summary.json \
  --candidate-summary runs/swebench/candidate/summary.json
```

It writes `eval-comparison.json` with resolved/failed/timeout/pass-rate deltas
and per-failure-label deltas. The command reads summaries only and does not
mutate either run directory.

Implemented regression gate command:

```bash
agent-kernel-host enhancement eval regression-gate \
  --root-dir runs/eval/regression-gate \
  --baseline-summary runs/swebench/base/summary.json \
  --candidate-summary runs/swebench/candidate/summary.json \
  --min-pass-rate 0.8 \
  --max-pass-rate-drop 0.05 \
  --max-failed-increase 1 \
  --max-timeout-increase 0 \
  --max-resolved-drop 2 \
  --failure-cap agent_error=0
```

Writes `regression-gate.json` with `verdict.pass`, per-threshold reason codes,
observed values, and applied thresholds. When the verdict is a fail, the
process exits with code 2 so CI runners can block promotion without any extra
scripting. The gate reads summaries only and does not mutate either run
directory.

Phase 1: local eval run directory and deterministic scorers over synthetic
fixtures. Implemented for session logs and patch files.

Phase 2: SWE-bench adapter plugs into the same experiment/trial model.

Phase 3: trace-aware comparison dashboard. The host now provides summary-level
run comparison artifacts. The dashboard artifact explorer now renders eval run
summaries, progress artifacts, failure breakdown bars, and comparison deltas
from manifest-discovered artifacts without adding eval state to the kernel
protocol. It also loads per-run trial artifacts from the same manifest, shows
instance status/resolution/failure/latency/patch size, and exposes each trial's
artifact refs. Trial artifact refs are grouped into final patch, trace, harness
evidence, logs, prompt, and metadata sections in the dashboard, with preview
buttons backed by the existing artifact content endpoint. It also surfaces
generic `scores.json`, model judge trace artifacts, and SWE-bench
`worker-plan.json` artifacts. The Eval tab now has an aggregate scorecard for
runs/trials/resolution/pass rate and compact failure-delta chips for
comparisons, so cross-run regression signals are visible without opening raw
JSON.

The dashboard can create a SWE-bench worker plan through
`POST /eval/swebench/plan`. This is intentionally limited to the cheap planning
step: it validates the selected instance set, shards it across workers, writes
`worker-plan.json`, and refreshes the artifact manifest. The dashboard can also
invoke lightweight eval artifact actions through `POST /enhancement/action`:
session scoring, model-judge response parsing, run-summary comparison,
SWE-bench offline patch inference, session-to-SWE-bench export, and official
result ingestion. It can also construct the official SWE-bench grading command
as a dry-run artifact action, without executing Docker. These actions only read
existing files/session logs, derive command lines, or write the same artifacts
as their CLI counterparts.

Running the agent over a benchmark shard, cloning/materializing many workspaces,
and executing Docker-based official grading remain explicit CLI/CI operations.
Those jobs are long-running, environment-specific, and need reproducible process
control outside a browser session; the dashboard is the control/readout surface
for their artifacts, not a second benchmark scheduler.

Phase 4: scheduled CI eval smoke tests and manual full benchmark workflow.
Implemented as a deterministic fixture smoke in default CI plus a manual
`Eval Smoke` GitHub Actions workflow. The smoke test exercises the real host CLI
for prediction export, official-style result ingestion, run comparison, and
dry-run SWE-bench harness command construction. Full Docker grading remains
manual/opt-in because official SWE-bench evaluation has large CPU, memory, and
storage requirements.

Phase 5: model-assisted judge evaluators with saved judge traces. Implemented
as a host-side artifact runner, not as a replacement for deterministic grading:

```bash
agent-kernel-host enhancement eval judge-score \
  --root-dir runs/eval/judge-score \
  --prompt runs/tmp/judge-prompt.txt \
  --response runs/tmp/judge-response.json \
  --judge-model judge-model-v1 \
  --scorer answer.groundedness \
  --threshold 0.7
```

The response file must contain a numeric `score` field in the `[0, 1]` range.
Optional `label` and `explanation` fields are preserved when present. The
runner writes:

- `judge/<scorer>.judge-trace.json`: redacted judge prompt, judge model,
  raw response, parsed score/pass/failure label, and metadata;
- `scores.json`: standard eval score summary with the judge trace artifact ref.

This preserves auditability for subjective evaluators while keeping official
benchmark scoring, such as SWE-bench, delegated to the official harness.

## Testing Plan

- Unit tests for score aggregation and model-judge trace persistence.
- Snapshot tests for experiment metadata.
- Integration test running a tiny fixture task end-to-end.
- Browser test for experiment list and trial detail.
- Regression test that two experiments can be compared without mutating either.

## Non-Goals

- Do not build a full LangSmith/Phoenix clone.
- Do not store eval scores inside kernel state.
- Do not let model-assisted eval replace deterministic benchmark grading.

## Current Implementation Alignment

### Implemented In Code

The project now has a real local eval artifact layer:

- Generic deterministic session scoring through
  `agent-kernel-host enhancement eval score-session`.
- Model-judge trace parsing through
  `agent-kernel-host enhancement eval judge-score`; this parses saved judge
  responses and writes judge trace artifacts, but does not call an external
  judge model itself.
- Summary comparison through
  `agent-kernel-host enhancement eval compare-runs`.
- SWE-bench adapter artifacts: experiments, trials, summaries, predictions,
  worker plans, progress, final diffs, traces, and official harness evidence.
- Dashboard Eval view that discovers artifacts through `/artifacts/manifest` and
  loads detail through `/artifacts/content`.
- Dashboard action forms for session score, judge score, compare runs,
  SWE-bench infer/export/ingest/grade-command, and worker-plan creation.
- Browser e2e that drives the Eval UI for form-backed actions and verifies real
  artifact files on disk.

### Current Product Boundary

The dashboard is currently an eval artifact workbench. It can create cheap
derived artifacts and inspect results, but it is not a full experiment
scheduler. Long-running benchmark execution, Docker grading, and external judge
model calls remain CLI/CI or operator-controlled jobs.

This boundary is deliberate for the current implementation because those jobs
need environment prerequisites, process supervision, resumability, and explicit
resource controls. The UI, CLI, and HTTP action responses now name this boundary
explicitly: prediction-producing steps are `not_graded`, the generated grade
command is a dry-run handoff to the official SWE-bench Docker harness, and
`resolved` appears only after official harness results are ingested.

### Important Gaps

- No dataset registry with versioned dataset definitions and task metadata.
- No first-class experiment registry beyond run directories and summaries.
- No dashboard-owned long-running scheduler for full benchmark execution. The
  dashboard wizard prepares artifacts, runs local/host prediction steps, creates
  the official harness command, and ingests official results, but Docker grading
  remains operator/CI controlled.
- No scheduled regression gate that compares candidate against baseline and
  fails on quality/latency/token/reliability thresholds.
- No model-assisted evaluator service that owns prompt templates, calls judge
  models, and stores responses. Current `judge-score` only parses a saved
  response artifact.
- No eval-level latency/token distribution view across trials, only session
  profile artifacts and summary-level comparisons.
- No clustering view for failures beyond low-cardinality labels and comparison
  deltas.

### Production Quality Criteria

This platform is production-level when:

- A run has immutable metadata: dataset version, model/provider, tool registry
  hash, prompt version, commit, environment summary, timeout policy, compaction
  policy, and artifact root.
- The dashboard can show experiment status and failed-trial artifacts without
  requiring users to know run-directory conventions.
- CLI/CI can run a deterministic smoke by default and an official benchmark
  gate manually or on a scheduled runner.
- Comparisons include quality, latency, token, tool-error, timeout, and
  compaction deltas.
- Model-assisted evals preserve judge prompt, model, response, parsed score,
  and redaction status.

### Next Implementation Steps

1. Add an `experiment.json` creation path shared by generic eval and SWE-bench,
   with strict metadata fields.
2. Add a dashboard `Eval Run` wizard that wraps current actions into an ordered
   lifecycle.
3. Add a judge runner adapter that can call a configured judge provider while
   preserving the existing `judge-score` parser as the persistence layer.
4. Add e2e coverage for the guided eval flow, including failed input, dry-run
   grading handoff, result ingestion, and comparison report.

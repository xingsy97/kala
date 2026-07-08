# Agent Evaluation Platform

Status: proposed enhancement  
Priority: 3

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

Use metrics that connect quality, cost, and reliability:

- Pass/resolution rate.
- Timeout rate.
- Agent error rate.
- Tool error rate.
- Patch apply failure rate.
- Median and p95 wall time.
- Median and p95 input/output tokens.
- Cost per resolved task.
- LLM calls per task.
- Tool calls per task.
- Compaction frequency.

## Dashboard

Add an Eval section:

- Experiment list with pass rate, cost, duration, model, commit.
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

Phase 1: local eval run directory and deterministic scorers over synthetic
fixtures. Implemented for session logs and patch files.

Phase 2: SWE-bench adapter plugs into the same experiment/trial model.

Phase 3: trace-aware comparison dashboard. The host now provides summary-level
run comparison artifacts. The dashboard artifact explorer now renders eval run
summaries, progress artifacts, failure breakdown bars, and comparison deltas
from manifest-discovered artifacts without adding eval state to the kernel
protocol. It also loads per-run trial artifacts from the same manifest, shows
instance status/resolution/failure/latency/patch size, and exposes each trial's
artifact refs. Remaining work is richer cross-run charts and dedicated eval
navigation outside the artifact explorer.

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

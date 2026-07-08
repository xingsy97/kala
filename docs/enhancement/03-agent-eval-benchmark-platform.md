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

Phase 1: local eval run directory and deterministic scorers over synthetic
fixtures.

Phase 2: SWE-bench adapter plugs into the same experiment/trial model.

Phase 3: trace-aware comparison dashboard.

Phase 4: scheduled CI eval smoke tests and manual full benchmark workflow.

Phase 5: model-assisted judge evaluators with saved judge traces.

## Testing Plan

- Unit tests for score aggregation.
- Snapshot tests for experiment metadata.
- Integration test running a tiny fixture task end-to-end.
- Browser test for experiment list and trial detail.
- Regression test that two experiments can be compared without mutating either.

## Non-Goals

- Do not build a full LangSmith/Phoenix clone.
- Do not store eval scores inside kernel state.
- Do not let model-assisted eval replace deterministic benchmark grading.

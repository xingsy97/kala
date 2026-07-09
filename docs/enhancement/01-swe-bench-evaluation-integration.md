# SWE-bench Evaluation Integration

Status: proposed high-priority enhancement  
Priority: 1

## Why This Matters

SWE-bench is the most direct way to prove that `agent-kernel` is more than a UI
demo. It measures whether an agent can fix real GitHub issues by producing a
patch that passes repository tests in a reproducible Docker environment.

For the target roles, this demonstrates context engineering, tool use, code
sandboxing, long-running task reliability, benchmark engineering, and measurable
agent quality. It also creates training and debugging artifacts for agentic RL.

## Production References

- Official SWE-bench repo: `https://github.com/SWE-bench/SWE-bench`
- Official docs: `https://www.swebench.com/SWE-bench/`
- Official evaluation guide: `https://www.swebench.com/SWE-bench/guides/evaluation/`
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

## Design Principle

Do not reimplement SWE-bench grading. `agent-kernel` should implement inference,
patch extraction, trace capture, and result ingestion. The official Docker
harness remains the grading source of truth.

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

Current implemented host CLI surface starts with the low-risk pieces:

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
```

`grade` prints the official command by default. Add `--execute` to actually run
the Docker harness. This avoids accidentally triggering an expensive SWE-bench
evaluation when the operator only wants to inspect the command.

## Output Layout

Use a stable run directory:

```text
runs/swebench/<run_id>/
  config.json
  instances.jsonl
  predictions.jsonl
  sessions/
    <instance_id>.jsonl -> ~/.agent-kernel/sessions/...jsonl or copied log
  traces/
    <instance_id>.otlp.jsonl
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

Add an Eval Runs view after the CLI and data model exist:

- Run table: dataset, split, model, pass rate, completed, failed, timed out,
  cost, wall time.
- Instance table: `instance_id`, status, resolved, duration, token count,
  tool count, final diff size, failure type.
- Instance detail: chat/session replay, LLM API calls, tool calls, final diff,
  official harness logs, and trace spans.

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

Shared foundation now exists in `@agent-kernel/shared`: SWE-bench prediction
JSONL helpers, official harness command construction, eval experiment/trial
metadata types, artifact references, redaction, and trace span export. The next
implementation should build the CLI runner on top of these helpers rather than
creating a separate benchmark schema.

Phase 1: prediction exporter.
Run one local fixture task through `agent-kernel`, extract diff, and write the
official JSONL format.

Phase 2: official harness wrapper.
Shell out to `python -m swebench.harness.run_evaluation`, capture stdout/stderr,
and parse result files.

Phase 3: SWE-bench Lite single-instance run.
Support `--instance-ids`, timeouts, and run directories.

Phase 4: batch scheduler.
Add concurrency control, resume, skip-completed behavior, and per-instance
resource limits.

Phase 5: dashboard eval explorer.
Render runs, instance results, final diffs, harness logs, and linked traces.

## Non-Goals

- Do not clone SWE-bench grading logic.
- Do not add SWE-bench concepts to the kernel event union.
- Do not hide official harness logs behind simplified summaries.
- Do not treat benchmark pass rate as the only useful metric; failed traces are
  the main debugging and RL data source.

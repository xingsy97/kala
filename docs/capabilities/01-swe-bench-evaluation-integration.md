# SWE-Bench evaluation integration

Status: standalone adapter and fresh-run acceptance implemented
Owner: `adapters/benchmarks/swe-bench`

SWE-Bench runs belong to the standalone evaluation platform. Product Host routes, product Dashboard actions, old legacy-runner scripts, historical artifact readers, and compatibility shims are not entry points. Every accepted result is produced by a newly submitted canonical run.

## Architecture

- `eval-orchestrator` owns the immutable run spec, durable trial state, events, leases, artifact authority, and result commit.
- `eval-worker` creates a fresh sandbox per trial and owns Agent execution, verifier invocation, evidence staging, allowlisted artifact import, and cleanup.
- `adapters/benchmarks/swe-bench` resolves fresh immutable task input and invokes the pinned official harness tool.
- Agent RunLab, Claude Code, and Codex implement the public Agent adapter contract; the same run spec and environment lock apply to each variant.
- `eval-analyzer` and the grader consume only canonical artifacts through the Control Plane.
- `eval-dashboard` and the CLI are clients of the same versioned API.

Official evidence requires a pinned dataset record, task/slice manifest, derived trial image lineage, official harness revision, non-empty native/normalized events, final diff, raw grader result, and a content-addressed artifact manifest. An Agent exit or non-empty patch alone is not a resolved result.

## Running a fresh session

Build a pinned trial image, build the standalone packages, and run the current-source acceptance runner:

```bash
deploy/evaluation/build-swe-bench-trial-image.sh \
  --instance-id astropy__astropy-12907 \
  --output /tmp/swe-bench-image.json
pnpm build
pnpm evaluation:run-real-swe-bench -- \
  --image local:<full-lxd-fingerprint> \
  --output docs/evidence/evaluation/fresh-swe-bench.json
```

The runner fetches the selected official record during the run, starts a fresh Control Plane, Worker, grader, and analyzer, creates a distinct fresh LXD sandbox for every Agent trial, verifies official evidence, and proves cleanup. Credentials come only from the explicit current-run environment or credential helper. No prior run directory is discovered.

For routine operations, deploy `eval-orchestrator`, `eval-worker`, `eval-analyzer`, and `eval-dashboard` independently as described in [`deploy/evaluation/README.md`](../../deploy/evaluation/README.md). Submit runs through the Control Plane CLI/API and monitor them in the standalone Dashboard.

## Verification

```bash
pnpm --filter @agent-kernel/eval-benchmark-swe-bench test
pnpm verify:evaluation-boundaries
pnpm test
pnpm build
```

The checked-in release evidence includes a fresh three-Agent official SWE-Bench matrix with equal environment locks, canonical hashes, non-empty diffs and normalized traces, official verifier results, completed grading/analysis jobs, and zero leaked credentials.

## Non-goals

- Reading or importing pre-cutover Host sessions or evaluation artifacts.
- Recreating the official SWE-Bench grader.
- Treating custom-command output as ranked evidence.
- Running untrusted benchmark work inside the Control Plane or product Host.

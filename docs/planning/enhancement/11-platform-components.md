# Platform Components

Status: TypeScript foundation implemented; Python/Go components not started
Priority: 11
Last reviewed against implementation: 2026-07-09

## Why This Matters

The project is TypeScript-first today, which is fine for the host/dashboard
prototype. The target roles also value Python/Go/C++ systems ability and ML
platform integration. The right move is not a rewrite; it is adding platform
components where they carry real value.

## Design Principle

Keep the core protocol stable and language-neutral. Add Python/Go components as
adapters, runners, or high-performance services around the existing architecture.

## Python Components

Best fit:

- SWE-bench harness wrapper and dataset loader.
- Eval runner integrations with Hugging Face datasets.
- RL rollout exporters for slime/verl.
- Phoenix/LangSmith interop scripts.

Python is appropriate because SWE-bench, RL frameworks, PyTorch, vLLM, SGLang,
and many eval libraries are Python-native.

## Go Components

Best fit:

- High-concurrency worker supervisor.
- Artifact server for traces and run files.
- OTLP collector sidecar or gateway.
- Process supervisor for executors in production deployment.

Go is appropriate where static binaries, concurrency, and operational simplicity
matter.

## TypeScript Components

Keep TypeScript for:

- Kernel reducer.
- Host orchestration.
- Dashboard.
- Executor tool implementations.
- Local developer workflow.

## CI/CD

Release workflows should build and publish binaries for key components:

- host CLI
- executor CLI
- optional eval runner artifacts
- dashboard static bundle

GitHub Actions should run:

- lint/typecheck/test for packages
- dashboard build
- package binaries on tags
- attach artifacts to GitHub Releases
- optional manual SWE-bench smoke workflow

## Artifact Manifest

Status: implemented host-side CLI foundation

CI now validates the benchmark artifact path with `pnpm run verify:swebench-smoke`.
The smoke is intentionally fixture-only: it proves prediction JSONL generation,
official-style result ingestion, eval summary comparison, and official harness
command construction without starting Docker. Expensive official SWE-bench
grading is available from the manual `Eval Smoke` workflow.

Shared package exports are split by runtime boundary. `@agent-kernel/shared`
contains browser-safe protocol/log types used by the dashboard and executors.
`@agent-kernel/shared/enhancement` contains Node-only enhancement helpers such
as artifact stores, trace exporters, eval summaries, and SWE-bench command
builders. This keeps platform components reusable without leaking filesystem
dependencies into frontend bundles.

Production dashboards and eval explorers should not discover data by guessing
every run-directory layout. The host now provides a manifest builder:

```bash
agent-kernel-host enhancement artifacts manifest \
  --root-dir runs/enhancement \
  --output runs/enhancement/artifact-manifest.json
```

The manifest records relative path, inferred kind, media type, size, mtime, and
sha256 when the file is under the configured hash limit. It deliberately does
not copy request bodies, responses, prompts, logs, or diffs into manifest
entries. Large files are retained as entries with a `hashSkippedReason`, which
keeps dashboard indexing responsive on long production runs.

The host exposes the same index to the dashboard at `GET /artifacts/manifest`
when `artifactRootDir` is configured. The dashboard artifact explorer consumes
that endpoint as a read-only view: it shows summary counts, kind distribution,
file metadata, and hash status without loading artifact payload bodies into UI
state.

Dashboard coverage mirrors the implemented enhancement CLIs where a UI action is
reasonable. Expensive or environment-specific jobs still run through explicit
CLI/CI commands, but their outputs have first-class dashboard surfaces. Cheap,
deterministic planning actions can be triggered from the dashboard when they
only create artifacts and do not mutate kernel session state:

Dashboard action forms accept an optional `Root Dir` override for artifact
outputs; when omitted, the host artifact root is used. Actions that only derive
handoff data, such as the SWE-bench grading command dry-run, do not require
artifact capture to be configured.

- `Eval`: SWE-bench and generic eval summaries, worker plans, score artifacts,
  judge traces, progress, comparisons, trials, final patches, harness evidence,
  and linked sessions. The dashboard can create a SWE-bench worker plan, score a
  session, parse a saved judge response into score/judge-trace artifacts,
  compare two summary artifacts, infer predictions from an offline patches
  directory, export an existing session into a SWE-bench run, and ingest official
  SWE-bench result files through host actions that reuse the CLI
  implementations. It can also build the official grading command in dry-run
  mode for handoff to CI. Agent batch execution and Docker grading execution
  stay CLI/CI-only; their outputs are still rendered here once artifacts are
  written.
- `Profiles`: session latency, token usage, missing-trace, and runtime telemetry
  profiles. The dashboard can generate a profile artifact from a session id or
  explicit session log path.
- `Memory`: memory index provenance, active/tombstoned entries, confidence, and
  source metadata. The dashboard can rebuild the memory index for a workspace
  and optionally include global memory.
- `Ops`: reliability audit/chaos reports, RL rollout sidecars, token segment
  indexes, slime/verl adapter artifacts, subagent graphs, OpenInference traces,
  message assembly artifacts, router decisions, and tool catalogs. The dashboard
  can trigger reliability audits, chaos summary generation, trace export,
  rollout segment/sidecar/adapter export, and subagent graph export.

This gives every major CLI-generated artifact family a dashboard equivalent for
inspection while keeping execution control explicit and reproducible in the host
CLI or CI workflow.

This is an index, not a new protocol. It gives the dashboard and cleanup tools a
stable discovery surface while preserving the existing artifact contracts:
OpenInference traces, SWE-bench summaries/trials, rollout sidecars, profiles,
memory indexes, and reliability reports remain the source documents.

## Testing Plan

- Cross-language contract tests using JSON fixtures.
- CLI smoke tests for packaged host/executor.
- Artifact-manifest tests that verify kind inference, hash limits, and payload
  non-duplication.
- Release workflow dry-run on pull requests without publishing.
- Manual release workflow that uploads artifacts only on tags.

## Non-Goals

- Do not rewrite the kernel in another language prematurely.
- Do not create separate protocols per language.
- Do not add Python/Go just for legacy-runner value; each component must own a real
  integration or operational boundary.

## Current Implementation Alignment

### Implemented In Code

The current platform foundation is still TypeScript-first, with useful release
and artifact infrastructure:

- Host, executor, kernel, shared, substrate, and dashboard packages build under
  the pnpm workspace.
- `scripts/build-release-assets.mjs` and `scripts/verify-release-assets.mjs`
  build and verify release artifacts.
- GitHub Actions include CI, release asset verification, release publishing, and
  a manual/scheduled eval smoke workflow.
- The host exposes `/artifacts/manifest` and `/artifacts/content` for dashboard
  artifact discovery and bounded content access.
- `agent-kernel-host enhancement artifacts manifest` builds the same manifest
  for local artifact roots.
- The manifest handles first-use empty artifact roots, indexes file kind/media
  type/size/mtime/hash, skips payload duplication, and tolerates deletion races
  during scanning.
- Dashboard artifact explorer has `Eval`, `Profiles`, `Memory`, and `Ops` modes
  that cover every current enhancement artifact family.
- Real browser e2e covers dashboard-equivalent enhancement actions against a
  production dashboard bundle and real host.
- `scripts/verify-release-install.mjs` (`pnpm run verify:release-install`)
  simulates a fresh install of the pre-built `release/` assets: copies the
  host CJS bundle and dashboard tarball into a clean temp directory, boots the
  host on an ephemeral port with clean sessions/artifacts dirs, and verifies
  that `GET /artifacts/manifest` and `GET /` return the expected shapes before
  shutting the process down. The release CI workflow runs this on every
  host/all publish.
- `agent-kernel-host enhancement artifacts prune` reads the artifact root,
  removes entries older than `--older-than-days` and/or above a
  `--max-total-bytes` global budget (oldest-first), filters by `--kinds`, and
  writes a `artifact-prune.json` summary. Protected paths (`worker-plan.json`,
  `registry/run-index.json`, prior prune reports) are never removed. Supports
  `--dry-run` for CI validation.

### Important Gaps

- No Python package exists yet for SWE-bench dataset loading, official harness
  wrapping, Phoenix/LangSmith interop, or RL framework adapters.
- No Go service exists yet for process supervision, artifact serving, worker
  orchestration, or OTLP sidecar duties.
- Artifact retention exists at the CLI, but there is no scheduled cleanup job
  or remote artifact store backend, and no access control layer.
- Dashboard action coverage exists, but long-running operations still need a
  stronger job/control-plane artifact model.

### Production Quality Criteria

Platform components are production-level when:

- Release artifacts can be installed and smoke-tested in a clean environment
  without the workspace source tree.
- Python components own Python-native integrations: SWE-bench datasets/harness,
  verifier jobs, RL adapter validation, and optional observability SDK exports.
- Go or another systems component owns long-running worker/process supervision
  only if TypeScript host supervision becomes a real bottleneck.
- Artifact storage has retention, cleanup, manifest validation, and optional
  remote backend support.
- CI separates fast default checks, browser e2e, release dry-runs, and manual
  expensive benchmark jobs.

### Next Implementation Steps

1. Add release-install smoke: build release assets, unpack them into a temp dir,
   run host/executor/dashboard, and verify `/artifacts/manifest` plus one simple
   session path.
2. Add artifact cleanup/retention CLI based on manifest kind, mtime, and size.
3. Add a Python `swebench_adapter` package only when it owns Hugging Face dataset
   loading or official harness orchestration beyond command construction.
4. Add an optional OTLP/Phoenix export script before building any custom
   observability service.
5. Defer Go components until process supervision or high-concurrency worker
   orchestration exceeds what the current host can safely handle.

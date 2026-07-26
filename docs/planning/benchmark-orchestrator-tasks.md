# Benchmark Orchestrator Task Plan

This is the execution checklist for `benchmark-orchestrator.md`. Completed means implemented and verified, not merely coded.

## A. Safety and contracts

- [x] Identify the protected historical SWE-bench root.
- [x] Record hashes for canonical historical summaries and comparisons.
- [ ] Add a read-only legacy importer with before/after checksum tests.
- [ ] Define canonical run/backend/instance/event schemas in shared browser-safe types.
- [ ] Define evidence levels and prohibit smoke from official comparisons.

## B. Durable orchestration

- [ ] Implement benchmark run filesystem store with atomic projections.
- [ ] Implement append-only sequenced run events and finite replay API.
- [ ] Implement run/instance reducer and recovery classification.
- [ ] Implement concurrency, cancellation, retry and skip-completed policy.
- [ ] Persist immutable spec, environment and backend config hashes.

## C. Agent backends

- [ ] Implement backend registry and capability descriptors.
- [ ] Extract Agent RunLab backend from the proven SWE-bench runner.
- [ ] Extract Claude Code SDK backend from the proven runner.
- [ ] Implement explicit custom-command backend.
- [ ] Isolate smoke backend and label it non-evidence.
- [ ] Add backend validation/preflight endpoints and CLI output.

## D. Benchmark adapters and grading

- [ ] Connect SWE-bench task/workspace/prediction adapter.
- [ ] Connect official SWE-bench grader and result ingest.
- [ ] Adapt Terminal-Bench, ProgramBench and SWE-Marathon to the run service.
- [ ] Preserve benchmark-native score terminology and evidence.

## E. CLI and HTTP

- [ ] Add `benchmark` CLI command family.
- [ ] Add run CRUD/control/history/instance/badcase HTTP APIs.
- [ ] Keep old commands as tested compatibility shims.
- [ ] Add machine-readable output and meaningful CI exit codes.

## F. Dashboard

- [ ] Replace smoke-default Wizard with dataset/backend/execution configuration.
- [ ] Support multiple backend/model rows.
- [ ] Add live durable run and per-instance progress.
- [ ] Add session, patch, logs, trace, usage and grading evidence views.
- [ ] Add pairwise backend comparison.
- [ ] Add complete Bad Case filters/detail/annotation/export.
- [ ] Display imported historical results without copying or editing them.

## G. Verification

- [ ] Unit and property tests.
- [ ] HTTP/CLI parity integration test.
- [ ] Local fixture end-to-end run.
- [ ] Historical read-only import and Dashboard assertion: 23/30, controlled comparisons, seven bad cases.
- [ ] Real one-case Agent RunLab run and official grading.
- [ ] Real same-model Claude Code comparison where credentials permit.
- [ ] Compare new result to matching historical case.
- [ ] Deploy to `box_agent` and verify through the real Dashboard.


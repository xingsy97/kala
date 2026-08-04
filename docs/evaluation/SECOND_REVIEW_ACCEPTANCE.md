# Evaluation Platform Second Review Acceptance

Status: implementation and working-tree acceptance complete; clean-checkout replay pending the final review commits.

## Review scope

The second review re-audited design documents, protocol wiring, Control Plane, Worker, Analyzer, adapters, Product boundaries, Web UX, CLI/SDK, Administration, maintenance, CI/release, and evidence claims. Findings and intended remedies are recorded in [SECOND_REVIEW.md](./SECOND_REVIEW.md).

## Closed findings

The remediation closes the following classes of issues:

- trial evidence and artifact signatures are now verified by the Control Plane and bound to the leased Worker's registered key;
- analysis lease token and generation fencing are mandatory across heartbeat, upload, completion, and failure;
- SDK watch supports immediate abort, media-type validation, durable reconnect, cursor resume, and deadline;
- command idempotency uses semantic payload identity and explicit options override payload metadata;
- `audit.trustedOnly`, Administration SDK/CLI parity, safe HTTP errors, and CLI option handling are implemented;
- Dashboard stale data is keyed to the current route; confirmation focus, virtual-table ARIA, reload de-duplication, cache policy, and authenticated downloads are implemented;
- the Dashboard BFF credential is explicitly read-only and is never injected into mutation requests;
- Product Artifacts and Operations restore Session navigation, use the configured Host endpoint, preview/download ordinary artifacts, advertise capabilities, and remove legacy evaluation categories;
- maintenance uses a shared data-directory fence, consistent backup boundary, serialized status updates, failure/actor records, and persistent hash-chained security reload audit;
- adapter/provider versions and build revisions are explicit; one canonical pack inventory drives manifests and runners; formal experiments require explicit credential configuration and emit per-trial cleanup receipts;
- Security CI fails closed, npm publishing no longer swallows errors, release publication is staged as draft, test discovery cannot silently return zero, and task packs are part of the extended gate;
- evidence and acceptance documents distinguish historical, superseded, working-tree, and current-release status.

## Verification completed

- Complete source build and workspace typecheck: passed.
- Extended test aggregation, including task packs and Python tests: passed.
- Evaluation Protocol: 35 tests.
- Evaluation SDK: 19 tests.
- Evaluation Orchestrator: 64 tests.
- Evaluation Worker: 23 tests.
- Evaluation Analyzer: 21 tests.
- Evaluation Dashboard: 46 tests.
- Product Dashboard: 734 tests.
- Product Host: 657 tests.
- Executor: 173 tests.
- Governance, clean-cutover, reports, CI integrations, plugin contributor, deployment policy, experiment contracts, and workflow policy gates: passed.

## Container acceptance

A fresh source Compose deployment with scoped auth, a Worker signing key, an Analyzer signing key, and a trusted public-key registry reached healthy state for Control Plane, Analyzer, Dashboard, and Docker Worker.

A credential-free deterministic subset completed through:

```text
Control Plane
→ authenticated Worker
→ child Docker sandbox
→ Agent
→ verifier
→ signed artifact and result commit
→ Analyzer
```

Result: `completed`, 16 durable events, 41 ms wall time.

A pinned Chromium container verified all ten routes without route-load errors. The read-only BFF returned HTTP 200 for capabilities and did not authorize mutation; an unauthenticated mutation returned HTTP 401. All Compose containers, networks, volumes, and managed trial containers were removed after acceptance.

## Remaining limitations

- Detector validation remains explicitly synthetic-derived until an independently annotated real-trace corpus exists.
- No claim of controlled three-Agent parity is made without identical model, budget, tool, and dataset coordinates.
- Credential-bearing three-Agent and public benchmark runs remain manual or scheduled container-only experiments.
- The Control Plane remains a fenced standalone writer, not multi-leader HA.
- Worker hosts are trusted execution-plane infrastructure and should be dedicated or disposable.
- Cross-platform release matrices and external scanner/publisher workflows require CI-provider execution; local policy tests prove fail-closed configuration but do not simulate GitHub/npm services.

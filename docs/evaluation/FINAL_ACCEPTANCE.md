# Evaluation Platform Final Acceptance

## Release identity

- Clean-checkout tested revision: `392d895`
- Package manager: `pnpm@11.3.0`
- Node.js: 22
- Acceptance policy: workloads execute only inside Docker/LXD or disposable VM boundaries; the Box host only builds, orchestrates, and collects evidence.

## Completed implementation

- Independent browser-safe protocol, SDK, Control Plane, Worker, Analyzer, and Dashboard packages.
- Scoped Operator, Reviewer, Viewer, Worker, and Analyzer authentication and authorization.
- Worker/Analyzer service identity binding, lease fencing, trusted signing-key registry, rotation, and revocation.
- Durable journal recovery, stale-writer rejection, lease generation, recoverable deletion, retention, backup, restore verification, audit, and telemetry.
- Secret-safe credential helpers, imported-artifact redaction, bounded external harnesses, process-tree cancellation, and cleanup verification.
- Docker, LXD container, and LXD VM providers with explicit capability contracts.
- Agent RunLab, Claude Code, Codex, and non-ranked custom command adapters.
- SWE-Bench pinned official-harness local result semantics; all compatible local packs are explicitly labeled non-official.
- Ten-route Evaluation Dashboard, Administration, authenticated same-origin proxy, dynamic service discovery, CSP, accessibility, state recovery, and virtualized tables.
- Canonical seven-format reports, CI CLI, GitHub/GitLab/Jenkins examples, four-class plugin SDK, catalog governance, and layered CI.
- Product clean cutover: benchmark/evaluation orchestration is absent from Product Host/Shared/Dashboard while Session, Workspace, File, Git, Executor, Memory, Diagnostics, Product Outputs, and Pipeline remain.

## Verified gates

### Clean checkout

A fresh independent checkout with no pre-existing `dist` directories passed:

- frozen dependency installation;
- topological source build plus all workspace typechecks;
- full fast test aggregation;
- source ownership and clean-cutover boundaries;
- workflow policy tests;
- authenticated Worker, Analyzer, and CLI integration paths.

### Product regression

- Product Dashboard: 731 tests.
- Product Host: 657 tests.
- Executor: 173 tests.
- Complete workspace typecheck: passed.
- Governance and clean-cutover gates: passed.

### Container lifecycle

From the clean checkout, fresh source images were built for Control Plane, Analyzer, Dashboard, and Docker Worker. A credential-free deterministic subset completed:

```text
Control Plane
→ authenticated Docker Worker
→ disposable child Docker sandbox
→ custom command Agent
→ native verifier
→ signed artifact commit
→ Analyzer
```

Result:

- state: `completed`;
- durable events: 16;
- wall time: 41 ms;
- residual managed trial containers: 0.

All acceptance Compose containers, networks, and volumes were removed after the run.

### Browser and recovery

A Chromium container pinned to `sha256:6dea48646fa972c9705281ff469922e6d10e6a6c9d3426a101fd824b6261e51b` verified all ten routes with no HTTP or console errors. The slowest route was below one second. The same checks passed after recreating the Control Plane without restarting the Dashboard, proving dynamic Docker DNS recovery.

### Security and maintenance

Container probes verified:

- unauthenticated API request: HTTP 401;
- Viewer mutation attempt: HTTP 403;
- Operator read: HTTP 200;
- backup creation and hash verification: passed;
- restore verification into an empty directory: passed;
- final resource cleanup: zero containers, networks, volumes, and managed trials.

## Explicit limitations

1. The detector v2 corpus contains 60 cross-Agent train/holdout cases with noise and difficult negatives, but it is explicitly `synthetic-derived`. A sufficiently large independently annotated real-trace corpus is still required before claiming real-distribution precision/recall.
2. Historical three-Agent and SWE-Bench records remain available, but the final clean revision did not rerun credential-bearing Agent RunLab, Claude Code, and Codex model experiments. These experiments remain manual/scheduled container-only jobs.
3. SWE-Bench is a pinned official-harness **local result**, not an externally certified service result. Terminal-Bench-compatible, ProgramBench-compatible, SWE-Marathon-compatible, SDLC, memory/planning, fault, and code-understanding packs are local non-official packs.
4. The Control Plane is a fenced standalone single-writer service, not a multi-leader HA database.
5. Docker/LXD Workers remain trusted execution-plane components and should run on dedicated hosts or disposable VMs; daemon sockets are not a security boundary against a compromised Worker.

No completion claim may override these limitations.

# Evaluation Platform Second Review

Status: authoritative second-round review scope; remediation is pending final clean-HEAD acceptance.

This review deliberately re-opened previously accepted behavior and found additional design/implementation mismatches. It does not inherit a pass result from the first review and is not execution evidence. Until a clean-tree evidence generator records the remediated release HEAD, all findings and the aggregate ledger remain `IMPLEMENTED_UNVERIFIED` for release purposes.

Operational disposition is documented in [`RUNBOOK.md`](RUNBOOK.md); evidence terminology and supersession are summarized in [`README.md`](README.md); experiment integration and controlled comparison are separated in [`INTEGRATION_AND_COMPARISON_MATRIX.md`](INTEGRATION_AND_COMPARISON_MATRIX.md). [`FINAL_ACCEPTANCE.md`](FINAL_ACCEPTANCE.md) is a superseded historical narrative, not a current acceptance record.

## P1 correctness and trust findings

| ID | Finding | Required remediation |
|---|---|---|
| SR-01 | Worker signs trial evidence and artifact manifests, but result commit does not require trusted signature verification or signer-to-Worker binding. | Verify both signatures against the active trust registry at commit and bind key reference to the authenticated lease Worker. |
| SR-02 | Analysis lease token/generation fields are optional and Analyzer/Grader do not propagate them through heartbeat, artifact staging, completion, or failure. | Make fencing mandatory and reject stale generations on every analysis mutation. |
| SR-03 | Dashboard nginx replaces every client Authorization header with a shared Viewer token. | Use a same-origin BFF session or pass authenticated per-user identity; the shared token must not authorize mutation or impersonate users. |
| SR-04 | Route-switch failure can render the previous route's authoritative data as stale data for the new route. | Cache data per route/query identity or clear it before a cross-route request. |
| SR-05 | Retention and backup may run concurrently with online mutations/artifact writes; maintenance status updates can lose concurrent records. | Define online/offline maintenance modes, acquire a consistent global snapshot boundary, serialize maintenance status, and record failures plus actor. |
| SR-06 | `audit.trustedOnly` is accepted but ignored. | Implement trusted filtering or remove the field; verify journal authority in returned metadata. |
| SR-07 | SDK event watch does not reconnect, ignores an already-aborted signal, and does not validate SSE media type. | Add bounded reconnect with durable cursor, immediate abort, content-type validation, and structured stream errors. |
| SR-08 | Explicit idempotency key can be overwritten by command payload and retry timestamps change payload hashes. | Make explicit options authoritative and exclude transport retry time from semantic idempotency identity. |
| SR-09 | HTTP internal errors expose raw messages and classify status by regex. | Introduce typed domain errors with stable safe messages and server-only causes. |

## P1 product and Web findings

| ID | Finding | Required remediation |
|---|---|---|
| SR-10 | Product Operations/Artifacts receive `onOpenSession` but discard it. | Restore Session navigation from memory, profile, trace, and artifact records. |
| SR-11 | Product artifact HTTP calls use relative URLs instead of the configured Host endpoint. | Route artifact manifest/content/actions through the resolved Host endpoint and authenticated session client. |
| SR-12 | Product Host still exposes legacy evaluation artifact categories and retention protection. | Remove obsolete evaluation categories while retaining product RL, diagnostics, memory, and output artifacts. |
| SR-13 | Product capability schema cannot express Artifacts/Operations/Pipeline support; unsupported deployments appear empty. | Advertise explicit product capabilities and render unavailable states or hide unsupported navigation. |
| SR-14 | Artifact Inventory cannot open ordinary artifacts. | Add contained content preview/download with media/type limits and Session navigation. |
| SR-15 | Confirmation dialog lacks focus trapping/restoration; virtual tables lack full-row ARIA metadata and scroll throttling. | Complete keyboard/focus/a11y behavior and virtual table semantics. |
| SR-16 | Administration reload allows duplicate submissions and command persistence redaction is key-name blacklist based. | Add pending/abort state and persist only a strict allowlisted command envelope. |
| SR-17 | Static entry/cache policy is undefined. | Use no-cache for HTML and immutable caching for hashed assets. |

## P1 API, CLI, and governance findings

| ID | Finding | Required remediation |
|---|---|---|
| SR-18 | Administration status/reload are absent from SDK and resource CLI. | Add typed SDK methods and CLI commands with exact confirmation and stable exits. |
| SR-19 | CLI global option ordering and missing-value handling are surprising; many protocol resources require raw JSON. | Implement a real argument parser or normalized global-option pass and complete the high-value command/query families. |
| SR-20 | Query response typing and schema validation cover only a subset of resources. | Export response schemas/types for every query resource and validate every response. |
| SR-21 | Security reload audit is in-memory; maintenance failure audit lacks authenticated actor. | Persist security and maintenance audit records in the Control Plane journal. |
| SR-22 | Capabilities command/query lists are manually duplicated. | Derive them from canonical protocol constants and add equality tests. |

## P1 adapters and experiment findings

| ID | Finding | Required remediation |
|---|---|---|
| SR-23 | Adapter/provider descriptors and run templates use `0.0.0`. | Inject package/build version and commit identity into descriptors and environment locks. |
| SR-24 | Benchmark design manifest covers a different pack set from real runners. | Use one canonical pack inventory shared by manifests, runners, UI, and completion matrix. |
| SR-25 | Cleanup receipt is a documented schema but real runners emit only a global boolean. | Emit one signed receipt per trial with provider residue counters and credential cleanup status. |
| SR-26 | Real runner can execute a user-level Claude `apiKeyHelper` fallback. | Require explicit credential-reference configuration for formal experiments; disable implicit host fallback. |
| SR-27 | Cross-Agent comparisons do not require equal model/budget/tool coordinates. | Distinguish backend-integration runs from controlled comparisons and enforce declared pairing coordinates. |

## P1 CI, release, and evidence findings

| ID | Finding | Required remediation |
|---|---|---|
| SR-28 | Security CI succeeds when scanners are absent. | Use strict mode and install/pin required scanners, or mark the gate unavailable rather than passing. |
| SR-29 | npm dependency publish errors are swallowed with `|| echo`. | Query registry first; publish only if absent; propagate all other errors. |
| SR-30 | Release assets are published in two public phases without transaction/rollback. | Stage a draft release and publish only after all platform assets and metadata pass. |
| SR-31 | Base images/actions are not uniformly digest/SHA pinned. | Pin production image digests and high-privilege workflow actions. |
| SR-32 | Task-pack/performance/cross-platform/install tests are not all release gates. | Add explicit extended/release matrices and fail if test discovery returns zero. |
| SR-33 | Evidence revisions are stale and historical fixture/current evidence are mixed. | Apply the definitions in [`README.md`](README.md), keep detector v1 and pre-review Compose evidence superseded, enforce clean-tree generation, and reconcile final HEAD. |
| SR-34 | The former `FINAL_ACCEPTANCE` record conflicted with the ledger aggregate `IMPLEMENTED_UNVERIFIED`. | It is now a revision-independent [historical acceptance record](FINAL_ACCEPTANCE.md); create a new final record only after this review's clean-HEAD acceptance. |

## Explicit non-goals for this remediation pass

- No claim of real-distribution detector quality until an independently annotated real-trace corpus exists.
- No claim of three-Agent model parity without a declared same-model/budget/tool coordinate and container rerun.
- No multi-leader HA claim; the Control Plane remains a fenced standalone writer.
- Docker/LXD Workers remain trusted execution-plane components and should run on dedicated hosts or disposable VMs.

# Evaluation Platform Implementation Gap Matrix

Status: source-level review baseline, not completion evidence
Reviewed baseline: `58dccafb37fba85afa6f921fd1f8dc9403368b8c` plus the frozen shared working tree captured in `/tmp/agent-evaluation-review-baseline-20260804T091423Z`
Rule: implementation presence, fixture tests, source scans, and historical evidence do not by themselves establish release verification.

## 1. Completion-criterion recalibration

The current implementation ledger marks all 24 criteria `VERIFIED`. The source and evidence review does not support that classification for the current working tree.

| Criteria | Reviewed state | Reason |
|---|---|---|
| CC02 | `CONTRADICTED` | Orchestrator and Dashboard production images copy pre-existing ignored `dist` directories instead of building current source. |
| CC21 | `CONTRADICTED` | Insight ownership and reviewer authority are request data, not authenticated principals. |
| CC22 | `CONTRADICTED` | Unauthenticated callers can read evidence and perform governance, publication, deletion, Worker, and lease operations. |
| CC01, CC03–CC20, CC23–CC24 | `IMPLEMENTED_UNVERIFIED` | Substantial implementation exists, but same-release clean-source, authenticated, trusted-evidence, containerized acceptance is incomplete or not part of standard CI. |

No criterion is considered release-verified until the final clean-checkout container acceptance regenerates its evidence against the exact source revision and dirty-state digest.

## 2. P0 release blockers

| ID | Area | Existing implementation | Blocking defect | Required acceptance |
|---|---|---|---|---|
| P0-01 | Identity and authorization | Versioned HTTP command/query/Worker APIs | No authentication or RBAC; Worker, operator, reviewer, analyzer, and viewer identities are not trustworthy | Unauthenticated and cross-role requests rejected; Worker identity bound to leases/results; security audit records authenticated principal |
| P0-02 | Evidence trust | SHA-256 manifests and Ed25519 reproduction signatures | Artifact signatures are not verified against a trust root; reproduction bundles trust their embedded public key | Trusted key registry, rotation/revocation, signer scope, replay protection, forged/self-signed evidence rejection |
| P0-03 | Lease fencing | Trial commit tokens and lease expiry sweep | Artifact staging and result commit accept an expired lease before sweep; analysis leases lack opaque token/generation | Deadline checked on every mutation; lease generation fences stale Workers and analyzers under races |
| P0-04 | Source/release identity | Independent package builds and images | Orchestrator/Dashboard images copy stale ignored `dist`; old Host eval code remains under `packages/host/dist` | Clean checkout with all `dist` removed builds images and publish archives; package-content gate rejects legacy eval output |
| P0-05 | Execution trust boundary | Trial sandbox resource/network controls | One Worker receives Docker socket, LXD socket, and model credentials; daemon access is host-equivalent privilege | Separate least-privilege Worker profiles/nodes; no shared daemon authority; malicious trial cannot access host, other projects, or other credentials |
| P0-06 | Secret and evidence privacy | Canonical output redaction and artifact path containment | Imported native artifacts are not content-redacted; credential-helper failure and inherited harness environment can leak secrets | Failure-path redaction, allowlisted environment, imported artifact scanning/redaction, bounded logs, seeded-secret negative tests |

## 3. P1 correctness and product gaps

| ID | Area | Gap | Required verification |
|---|---|---|---|
| P1-01 | Journal recovery | Torn tail is ignored but not truncated, so the next append can make recovery permanently invalid | Torn byte at every boundary, restart, append, second restart |
| P1-02 | Writer authority | Only in-process serialization; no data-directory lock or multi-instance fencing | Two orchestrators sharing storage cannot both start/write/lease |
| P1-03 | Deletion | Journal tombstone precedes physical deletion; failure may leave durable state deleted and bytes present | Persistent deletion workflow, injected failures, restart-independent retries, final absence scan |
| P1-04 | Retention | Policy is stored but no retention scheduler executes it | Dry-run/impact hash, legal hold/protected refs, transitive deletion, restart recovery |
| P1-05 | Backup and restore | No consistent journal+artifact backup, restore, compatibility, RPO/RTO, or restore drill | Fresh-environment restore and hash/reference comparison; interrupted backup and version migration |
| P1-06 | Artifact filesystem | Symlink/TOCTOU checks are path-based and not handle-based | Intermediate symlink and concurrent path replacement attacks fail closed |
| P1-07 | Worker liveness | Scheduler does not require fresh Worker heartbeat/session epoch | Stale Worker cannot lease; re-registration fences previous process |
| P1-08 | Analyzer provenance | Analyzer input events are not content-bound to the canonical trace artifact | Trace/event projection hashes, sequence/native-ref validation, mutation rejection |
| P1-09 | Detectors | `PARTIAL`: v2 adds grouped train/holdout, noise, missing evidence, difficult negatives, annotation metadata, calibrated confidence, bootstrap CI, Brier and ECE; retained normalized payloads remain insufficient, so the corpus is truthfully `synthetic-derived` | Independent real-trace holdout from retained, redacted normalized payloads; external annotation review and larger calibration sample |
| P1-10 | Trace alignment/clustering | Prefix comparison and exact volatile hash are not robust semantic alignment/clustering | Human gold sets; insertion/deletion/reorder tests; pairwise cluster metrics |
| P1-11 | Counterfactual/reproduction | Harness self-reports outcome/fingerprint/fresh environment; ddmin uses one attempt | Independent verifier, sandbox attestation, repeated probabilistic minimization, success controls and cleanup receipts |
| P1-12 | Regression statistics | Incomplete evidence can pass; infrastructure failures are not mapped; significance does not drive decisions | Evidence-incomplete and ambiguous responsibility become indeterminate; paired-repeat and Monte Carlo coverage tests |
| P1-13 | Insight lifecycle | Validated insight accepts arbitrary non-empty post-fix references | Enforced defect→reproduction→pack→fix-run→passing-gate lineage |
| P1-14 | Benchmark claims | Only SWE-Bench uses a pinned official harness; other similarly named adapters are local non-official packs | Truthful names/labels/provenance; official/native integration or explicit scope reduction; representative subsets |
| P1-15 | CLI/SDK | Generic JSON command/query only; no auth, typed responses, watch, deadlines, admin, artifact, stable errors | Resource command matrix, auth, SSE resume, timeout/cancel, exit codes and CLI/API parity |
| P1-16 | Administration | UI exists but service identity, keys, Worker sessions, policy execution and trusted audit are incomplete | Browser+API role matrix and full operational workflows |
| P1-17 | Reports | Seven formats exist but semantic coverage differs; PDF silently truncates large reports | Canonical report model, format validators, no truncation, cross-format semantic hash |
| P1-18 | CI integrations | Local fixtures exist but normal CI does not run full integration contracts | GitHub/GitLab/Jenkins container fixtures, three-state exits, always-upload and report validation |
| P1-19 | Plugin SDK | Agent/task/detector examples exist; equivalent external sandbox-provider acceptance is missing | Four plugin types packed and loaded from clean external workspaces without private imports |
| P1-20 | Dataset governance | Schema fields exist but admission/publication decisions are not a complete operational workflow | License/permission/provenance rejection matrix and audit |
| P1-21 | Observability | Some metrics/spans exist, but durability SLO can be trivially green and counters reset | Persistent/recoverable telemetry, trace graph validation, failure-driven SLOs, no sensitive payloads |
| P1-22 | Deployment | Fixed private endpoint, developer home, LXD fingerprint, mutable image tags and combined Worker profile | Parameterized cross-machine profiles, pinned digests, secret files, health/readiness, upgrade/rollback |
| P1-23 | Product boundary | Old eval source is removed, but product Artifacts still mixes outputs, memory, profiles and operations under one broad concept | Inventory and rename/restructure; no benchmark/eval artifacts in product UI; product regression suite |

## 4. Test and evidence gaps

- Standard CI currently runs build, typecheck, workspace tests, evaluation boundaries, and release assets only.
- Shared tests, task-pack tests, Python tests, performance tests, many script tests, browser acceptance, real sandbox conformance, real Agent runs, fault matrices, and the completion matrix are not one coherent release gate.
- Historical evidence is mixed: some files bind the current commit, many bind only selected source hashes, and important real-run artifacts do not record a complete dirty-tree digest, image identity, dataset slice manifest, or runner identity.
- Several aggregate evidence files summarize other evidence; aggregation improves indexing but is not independent validation.
- The only identified public benchmark subset is one SWE-Bench Verified instance. Other recorded tasks are synthetic/local task packs and must be described as such.

## 5. Experiment policy

All new workloads and experiments must run inside isolated Docker/LXD workers or disposable VMs. The Box host may only orchestrate, build, inspect, and collect evidence; it must not directly execute Agent, benchmark, verifier, counterfactual, reproduction, or browser workload processes.

Representative subset validation is sufficient when it proves the integration contract:

- SWE-Bench: a small immutable multi-repository subset with official harness identity;
- each non-official task pack: at least one deterministic task per lifecycle class;
- each official Agent adapter: the same deterministic task in a fresh environment;
- security/fault experiments: deterministic adversarial fixtures covering every trust boundary;
- browser: all routes/states against a containerized authenticated Control Plane;
- cleanup: zero managed containers, LXD instances, networks, ACLs, volumes, and leaked credentials after every run.

Every regenerated evidence artifact must include source commit, dirty-tree digest, lockfile hash, command, runner identity, image digest/fingerprint, dataset/slice manifest hash, start/end time, artifact hashes, and cleanup receipt.

## 6. Delivery order

1. Identity/RBAC and trusted evidence design.
2. Lease/journal/deletion/secret/process correctness.
3. Administration, CLI/SDK, retention, backup/restore, telemetry.
4. Benchmark claim correction and analyzer validity.
5. Dashboard/product Artifacts boundary and report/CI/plugin completion.
6. Clean-source images, test aggregation, layered CI.
7. Container-only subset, fault, browser, restore, and product-regression acceptance.
8. Reconcile the implementation ledger, split reviewable commits, and run final clean-checkout acceptance.

## 7. Current remediation status

The reviewed P0 implementation defects have been remediated in the current working tree:

- scoped Operator/Reviewer/Viewer/Worker/Analyzer authentication and authorization;
- Worker/Analyzer service identity binding and lease-scoped Worker queries;
- externally trusted artifact, result, and reproduction signing with rotation/revocation semantics;
- lease deadline/generation fencing, torn-tail repair, stale-writer rejection, and recoverable deletion;
- credential-helper cancellation, imported-artifact redaction, bounded harness output, and process-group termination;
- source-built production images, clean Host builds, release-content rejection, and split Docker/LXD Worker profiles;
- truthful benchmark labels and a clear Product Artifacts boundary;
- executable retention, backup/verify/restore, telemetry, Administration, CLI/SDK, reports, CI integrations, plugin SDK, and catalog governance.

Working-tree container evidence is recorded in `docs/evidence/evaluation/container-acceptance-current.json`. It proves an authenticated Docker subset lifecycle, role rejection, ten-route browser acceptance before and after Control Plane recreation, backup/restore verification, and zero residual resources. It is not final release evidence because the source tree is not yet clean and the detector validation corpus remains explicitly synthetic-derived.

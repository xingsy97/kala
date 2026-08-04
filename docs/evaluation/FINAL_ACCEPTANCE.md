# Evaluation Platform Historical Acceptance Record

Status: **historical; superseded for current release decisions**.

This file preserves an earlier acceptance narrative. It is not bound to the current release revision, must not be cited as current acceptance, and does not change the aggregate state from `IMPLEMENTED_UNVERIFIED`. The second-round findings and current acceptance requirements are tracked in [`SECOND_REVIEW.md`](SECOND_REVIEW.md). A new final record may replace this status only after clean-checkout evidence is generated for the release HEAD.

## Historical scope

The earlier run reported the following implementation and checks:

- independent browser-safe protocol, SDK, Control Plane, Worker, Analyzer, and Dashboard packages;
- scoped Operator, Reviewer, Viewer, Worker, and Analyzer authentication and authorization;
- Worker/Analyzer service identity binding, lease fencing, trusted signing-key registry, rotation, and revocation;
- durable journal recovery, deletion, retention, backup/restore verification, audit, and telemetry;
- Docker, LXD container, and LXD VM providers;
- Agent RunLab, Claude Code, Codex, and non-ranked custom-command adapters;
- a ten-route Evaluation Dashboard and same-origin BFF;
- reports, CI examples, plugin SDK, catalog governance, and product clean cutover.

The historical clean-checkout, product-regression, container-lifecycle, browser/recovery, security, maintenance, and cleanup results remain useful as investigation inputs only. Their old source identity and Compose artifacts are superseded evidence, not proof for the current tree.

## Evidence interpretation

- **Fixture evidence** proves a deterministic contract against checked-in synthetic or canonical inputs. It does not prove that the current deployable stack, credentials, maintenance controls, or real Agent path works.
- **Working-tree current evidence** describes the source present when generated, but a dirty-tree record cannot satisfy release acceptance and the word `current` in a filename has no authority.
- **Release evidence** must be generated from a clean checkout of the final release HEAD, carry required revision and generator metadata, and reconcile every second-review finding.
- Detector v1 evidence and pre-second-review Compose evidence are **superseded**. They remain auditable historical inputs and cannot satisfy current detector, deployment, recovery, or maintenance gates.

See the terminology and evidence map in [`README.md`](README.md) and the operational procedures in [`RUNBOOK.md`](RUNBOOK.md).

## Historical limitations that still constrain claims

1. Detector v2 uses a small `synthetic-derived` corpus. It does not establish real-distribution precision or recall.
2. Historical three-Agent and SWE-Bench records do not establish a controlled comparison for the current release.
3. SWE-Bench results are pinned official-harness local results, not externally certified service results; similarly named local packs remain non-official.
4. The Control Plane is a fenced standalone writer, not a multi-leader HA database.
5. Docker/LXD Workers are trusted execution-plane components and should run on dedicated hosts or disposable VMs.

No completion, ranking, or release claim may override these limitations.

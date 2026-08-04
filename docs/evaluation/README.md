# Evaluation Documentation

## Current status

The aggregate release state is `IMPLEMENTED_UNVERIFIED` pending final clean-checkout acceptance for the second review. No historical per-row `VERIFIED` label or filename containing `final`/`current` overrides that state.

- [`SECOND_REVIEW.md`](SECOND_REVIEW.md): authoritative second-round findings and acceptance scope.
- [`FINAL_ACCEPTANCE.md`](FINAL_ACCEPTANCE.md): superseded historical acceptance narrative, not current release evidence.
- [`RUNBOOK.md`](RUNBOOK.md): CLI, SDK, Administration, BFF identity, and online/offline maintenance procedures.
- [`INTEGRATION_AND_COMPARISON_MATRIX.md`](INTEGRATION_AND_COMPARISON_MATRIX.md): backend integration versus controlled comparison rules.
- [`detector-validation-corpus.md`](detector-validation-corpus.md): detector v2 synthetic-derived corpus scope.
- [`IMPLEMENTATION_GAP_MATRIX.md`](IMPLEMENTATION_GAP_MATRIX.md): historical review baseline and remediation inventory.

## Terminology

| Term | Meaning |
|---|---|
| `IMPLEMENTED_UNVERIFIED` | Implementation exists, but final same-release clean-checkout evidence is incomplete. |
| Historical evidence | Immutable evidence from an earlier revision or review phase; useful for audit, not a current gate. |
| Superseded evidence | Historical evidence explicitly displaced by a newer scope or method; retained for audit and excluded from current decisions. |
| Fixture evidence | Deterministic contract evidence from checked-in canonical, synthetic, or synthetic-derived inputs; not deployment or real-distribution proof. |
| Working-tree evidence | Evidence generated from uncommitted source; diagnostic only, even if its filename says `current`. |
| Current release evidence | Evidence generated from a clean checkout of final HEAD with required source, generator, environment, artifact, and cleanup metadata. |
| Integration run | Demonstrates one backend/pack/provider/verifier lifecycle; always unranked. |
| Controlled comparison | Uses equal declared comparison coordinates and repeated trials; only this class may support ranking. |

Detector v1 and pre-second-review Compose deployment/recovery evidence are superseded. Detector v2 fixture results characterize only the checked-in `synthetic-derived` corpus. A current detector claim additionally requires clean-HEAD generation and, for real-distribution metrics, an independently annotated retained real-trace holdout.

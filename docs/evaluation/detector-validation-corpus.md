# Detector validation corpus v2

Status: fixture specification; detector v1 evidence is superseded and v2 remains `IMPLEMENTED_UNVERIFIED` for release purposes pending final clean-HEAD evidence.

This scope responds to [`SECOND_REVIEW.md`](SECOND_REVIEW.md#p1-ci-release-and-evidence-findings).

## Provenance and scope

The repository does not contain enough retained normalized-event payloads to construct an independent real-trace corpus. It contains recorded multi-Agent evidence metadata and normalized-event counts in `docs/evidence/evaluation/flagship-five-task-three-agent-20260803.json`. Therefore every v2 case is explicitly labeled **`synthetic-derived`**, not real trace data. Cases reuse only redacted event shapes and Agent group identities (`agent-runlab`, `claude-code`, `codex`).

## Corpus policy

- Source-trial groups are assigned wholly to `train` or `holdout`; no group may cross the boundary.
- Metrics are computed only on holdout groups. Bootstrap resampling is by group, not by row.
- Noise-injected cases add irrelevant redacted messages.
- Missing-evidence cases retain schema-valid partial references and reduced verifier coverage; confidence must decrease.
- Difficult negatives resemble positives (public test edits, recovery inspection) without satisfying the defect rule.
- Each case records provenance, source evidence, Agent, group, split, transformations, difficulty, annotation guideline, annotators, labels, adjudication, and timestamp.
- Disagreements require an adjudicator. Annotation agreement is reported, not assumed.

## Metrics

Each detector report includes confusion counts, precision/recall/F1, deterministic 95% group-bootstrap confidence intervals (1,000 samples), Brier score, 10-bin ECE, and annotation metadata. Finding confidence is an evidence-completeness score mapped through the checked-in piecewise calibration curve; it is never hard-coded to 1.

These metrics characterize this small synthetic-derived validation set only and must not be presented as real-world detector performance. They are **fixture evidence**: they validate deterministic detector behavior against checked-in cases. **Current release evidence** must regenerate the report from clean release HEAD with source and generator metadata; a real-distribution claim additionally requires an independently annotated retained real-trace holdout.

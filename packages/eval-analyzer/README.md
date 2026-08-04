# Evaluation Analyzer

Canonical standalone owner for deterministic defect detectors, measured detector validation, trace alignment, unknown-failure clustering, counterfactual result handling, and reproduction minimization. It consumes only immutable `eval-protocol` evidence and never reads product Host sessions or historical Host evaluation artifacts.

Counterfactual jobs require a continuation executor. Configure `--counterfactual-command <command>` or `AGENT_EVAL_COUNTERFACTUAL_COMMAND`; the Analyzer sends one JSON request on stdin for each intervention and accepts one JSON observation on stdout. The request contains the immutable source input, selected checkpoint, checkpoint hash, and exactly one intervention.

Detector validation v2 uses a group-isolated train/holdout manifest, difficult negatives, noise and missing-evidence variants, annotation metadata, group-bootstrap precision/recall/F1 intervals, Brier score, and ECE. Finding confidence is derived from evidence completeness through a versioned calibration curve. The checked-in corpus is explicitly `synthetic-derived` because recorded evidence retains multi-Agent normalized-event counts but not enough normalized payloads for a real-trace holdout; see [the corpus methodology](../../docs/evaluation/detector-validation-corpus.md).

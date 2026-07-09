# Eval Experiments (local-only)

This directory holds local evidence from benchmark and comparison runs: selected
cases, raw outputs, diagnostics, run summaries, pairwise comparisons, and working
notes produced while evaluating agents.

Its contents are intentionally not committed to version control.

## Why not committed

Eval workspaces often contain environment-specific details that should not be
published as repository history:

- local filesystem paths and working directories
- provider, endpoint, and model routing details
- raw prompts, traces, diagnostics, and temporary repair notes
- generated CSV, JSON, JSONL, and benchmark output files
- private narrative notes and unreleased presentation material

Keeping these files local preserves the full diagnostic context without forcing
every raw artifact through scrubbing and review.

## Ignore rules

Everything under this directory is ignored by `.gitignore` except:

- `README.md` (this file)
- `.gitignore` itself

## Where committed eval material belongs

Commit stable, reviewed eval methodology and conclusions under `docs/` or in
source files that implement reusable benchmark machinery. Keep raw run evidence,
intermediate diagnostics, and generated benchmark outputs in this local-only
directory.

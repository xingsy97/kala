# Experiments

This directory holds local experiment records that are useful for audit, replay,
and post-run analysis.

## Layout

- `evals/`: local-only benchmark and evaluation runs, including agent-vs-agent comparisons.
- `rl/`: local-only reinforcement-learning and training runs.
- `ops/`: deployment, infrastructure, and operational run records.

Experiment run directories use date-first names:

- `YYYY-MM-DD-<short-slug>` for a specific dated run.
- `YYYY-MM-<short-slug>` for a month-scoped comparison or portfolio.

Raw run records, diagnostics, generated benchmark outputs, local workspaces,
sessions, virtualenvs, and secrets stay local-only under the relevant experiment
category. Commit stable, reviewed methodology and conclusions under `docs/` or
source files that implement reusable machinery.

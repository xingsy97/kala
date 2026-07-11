# Roadmap: agent-kernel

Last updated: 2026-07-11

## Summary

Three tracks of work:

1. **Evaluation moat** — benchmarks across four capability axes (SWE-bench + Terminal-Bench + WebArena + τ-bench) plus a bad-case-to-training-data loop. See [eval-moat.md](eval-moat.md).
2. **RL end-to-end** — go from fixture data to real rollouts consumed by verl, with reward-weighted traces surfaced back. See [rl-e2e.md](rl-e2e.md).
3. **Product polish** — dashboard usability improvements. See [product-polish.md](product-polish.md).

Supporting: [streaming.md](streaming.md) (streaming and TTFT); [what-not-to-do.md](what-not-to-do.md) (explicit non-goals).

**Before starting**: every PR follows [../../meta/principles.md](../../meta/principles.md); regressions are logged in [../../meta/past-mistakes.md](../../meta/past-mistakes.md).

---

## Timeline

| Week | Eval | RL | Streaming | Product |
|---|---|---|---|---|
| W1 | Terminal-Bench adapter | verl-adapter skeleton | – | Phase 1 top-level nav |
| W2 | Bad-case mining module | verl dry-run passes | Streaming loop rewrite | Phase 2 Benchmarks page |
| W3 | Bad-case dashboard tab | verifier chain | SSE + TTFT metrics | Phase 3 + 4 copy + Ops |
| W4 | Demo script | RL Rollouts tab | Cleanup | Phase 5 + 6 finish |

**Hard milestones**:

- **End of W2**: any benchmark run can export bad-cases as training data with one click.
- **End of W3**: a SWE-bench Lite run triggers verl-adapter and shows reward-weighted rollouts in the dashboard; top-level nav + Benchmarks page + copy rewrite all landed.
- **End of W4**: all 5 dashboard tabs usable.

---

## Bottom line

- Finishing eval-moat + product-polish turns the benchmark story from "SWE-bench ran once" into "reusable evaluation platform with a bad-case loop".
- Finishing rl-e2e turns the RL story from "fixture" into "a real rollout consumed by a real trainer".
- Finishing streaming turns latency from "unmeasured" into "TTFT surfaced in the runtime metrics panel".

---

*Update this timeline as each Part lands. Log new mistakes in [../../meta/past-mistakes.md](../../meta/past-mistakes.md).*

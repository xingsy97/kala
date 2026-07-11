# Roadmap · Part B · RL end-to-end pass (2-week delivery)

## B.1 Make rl-export actually consumed once

**Goal**: complete Task #9 (Agentic RL Rollout Export). Today there is only a contract fixture — no rollout has been consumed by an external trainer. Target: SWE-bench Lite run trace → rl-export produces a rollout → verl dry-run consumes it → reward-weighted trace stored back in the registry → dashboard shows reward distribution.

**Why it matters**: the RL story has to move from "fixture" to "actually round-tripped through a trainer". Without that round trip, everything downstream (verifier design, reward shaping, cross-run comparison) is speculative.

**What to do**:

- Pick the **verl dry-run** path (lighter dependency than slime, runnable locally).
- Add `packages/host/src/rl/verl-adapter.ts`: pull traces from the registry → serialize per verl rollout schema → call the verl verification-only entrypoint → get rewards back.
- Add `packages/host/src/rl/rollout-consumer.ts`: store the returned reward-weighted trace back into the registry (new artifact kind `rl-rollout-graded`).
- Benchmark run detail page gains an **RL Rollouts** tab (shown only when a rl-graded artifact exists):
  - One row per trace, reward column + visualization
  - Export to verl / slime native formats
- Add `docs/rl-rollout-pipeline.md`: diagram of agent-kernel → verl → registry data flow, with per-layer schema.

**Acceptance**: 5 SWE-bench tasks → CLI triggers verl-adapter → dashboard RL Rollouts tab shows 5 rows with visible reward distribution.

---

## B.2 Reward modeling with a real story

**Goal**: move beyond binary pass/fail reward. Add a composable verifier chain layer.

**What to do**:

- `packages/host/src/rl/verifier-chain.ts`: composable reward components — `patch-applies (0.2)` + `tests-pass (0.5)` + `no-regression (0.2)` + `trace-brevity-bonus (0.1)`.
- Each component independently testable and toggleable.
- RL Rollouts tab displays reward breakdown — which component earned how much.

**Design rationale**: outcome-only reward causes credit-assignment problems on long-horizon tasks. Process reward as a composable chain gives per-step signal and makes reward shaping legible in the UI.

**Acceptance**: run bad-cases with verifier chain enabled; dashboard shows independent scores for all 4 reward components.

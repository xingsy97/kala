# Roadmap · Part A · Evaluation moat (3-week delivery)

## Goal

Benchmarks cannot stop at SWE-bench. The target set covers four mainstream agent capability axes:

| Benchmark | Capability axis | Why chosen | agent-kernel value |
|---|---|---|---|
| SWE-bench | Coding agent / real GitHub issue repair | ICLR 2024 oral, de-facto industry standard | patch, trace, official harness, bad-case all first-class |
| Terminal-Bench | Terminal agent / long-running CLI tasks | Real shell workflows, exercises executor | Directly validates cwd, shell, file edit, test script, recording |
| WebArena | Web agent / browser navigation | Classic self-hosted web agent benchmark | Maps to browser runtime, trajectory replay, page evaluator |
| τ-bench / τ³-bench | General tool-use / user-interaction agent | Representative benchmark for tool calls, user simulation, policy compliance | Maps to tool protocol, multi-turn state, reward breakdown |

**Explicitly not chosen**: OSWorld-class desktop/computer-use benchmarks are not in the first batch (GUI/VM-heavy, dilutes the main thread).

**Domain reading**: each benchmark must start from its domain doc before implementation:

- [SWE-bench Evaluation](../../evals/domain-knowledge/swe-bench-evaluation.md)
- [Terminal-Bench Evaluation](../../evals/domain-knowledge/terminal-bench-evaluation.md)
- [WebArena Evaluation](../../evals/domain-knowledge/webarena-evaluation.md)
- [Tau-Bench / Tau3-Bench Evaluation](../../evals/domain-knowledge/tau-bench-evaluation.md)

---

## A.1 BenchmarkAdapter interface

Extract a unified adapter contract, but **do not flatten different benchmarks' scoring semantics**. Unify the run lifecycle and artifact management; do not unify verifier/scoring semantics.

```typescript
type BenchmarkKind = "swe-bench" | "terminal-bench" | "webarena" | "tau-bench" | "custom-jsonl";

interface BenchmarkAdapter {
  kind: BenchmarkKind;
  resolveTasks(input: BenchmarkTaskInput): Promise<ResolvedBenchmarkTask[]>;
  prepareRun(run: BenchmarkRun): Promise<BenchmarkPreparedRun>;
  runAgent(run: BenchmarkPreparedRun): Promise<BenchmarkAgentArtifacts>;
  runVerifier(run: BenchmarkPreparedRun): Promise<BenchmarkVerifierArtifacts>;
  importResults(run: BenchmarkPreparedRun): Promise<BenchmarkResultSummary>;
  explainScore(result: BenchmarkResultSummary): BenchmarkScoreExplanation;
}
```

**Key constraints**:

- `runVerifier`: in SWE-bench it is the official Docker harness; in Terminal-Bench it is `run-tests.sh` + parser; in WebArena it is the evaluator router; in τ-bench it is the reward evaluator.
- `explainScore` must express each benchmark's official semantics — do not collapse everything into a single `passed` boolean.
- All adapters must emit normalized failure categories, but the raw official result is kept verbatim.

---

## A.2 Terminal-Bench adapter

**Why it matters**: real shell/CLI capability is the differentiator between "code-completion demo" and "agent that operates a terminal".

**What to do**:

- Add `packages/host/src/eval/terminal-bench.ts`, reusing the `run-registry`, `content-inputs`, and `sweBenchRunLayout` patterns.
- The dashboard's "Run Benchmark" entry point picks benchmark type first.
- Terminal-Bench executor reuses the existing `packages/executor` (no new sandbox).
- Run through 5-10 official tasks and store pass rate in the registry.

**Acceptance**: Benchmarks page → pick Terminal-Bench → run 5 tasks → see pass rate, all without touching the command line.

---

## A.3 WebArena adapter

**What to do**:

- Add `packages/host/src/eval/webarena.ts` with config import, task ID range selection, site env var configuration, and auth readiness reporting.
- Wizard gains a WebArena environment check: sites reachable / auth state present / Playwright ready.
- Run Agent stage saves observations/actions/screenshots/trace zip.
- Run Verifier displays evaluator type: `string_match` / `url_match` / `program_html` + score.
- Review supports trajectory replay.

**Acceptance**: run 3-5 WebArena configs, see each task's intent / site / evaluator type / score / trace.

---

## A.4 τ-bench / τ³-bench adapter

**What to do**:

- Add `packages/host/src/eval/tau-bench.ts`, targeting `sierra-research/tau2-bench` by default.
- Wizard picks domain (airline / retail / telecom / banking_knowledge) and configures evaluated agent model + user simulator model separately.
- Result view shows reward basis: `DB` / `COMMUNICATE` / `ENV_ASSERTION` / `NL_ASSERTION` / `ACTION`.
- UI explicitly marks `actions` as reference trajectory (not required) unless `ACTION` is in `reward_basis`.
- Review shows conversation / tool calls / tool arguments / reward breakdown.

**Acceptance**: equivalent of `tau2 run --domain airline --num-tasks 5 --num-trials 1`, dashboard shows task reward, reward breakdown, agent/user/tool trajectory.

---

## A.5 Bad-case feedback loop (moat core)

**Why it matters**: bad-case mining turns evaluation from "score a run" into "systematically produce training data". This is the piece that scales.

**What to do**:

- Add `packages/host/src/eval/badcase-mining.ts`: input runId → scan all trials → filter by `status ∈ {failed, errored}` → output:
  ```
  { instanceId, failureCategory, trace[], toolCallErrors[], verifierReason,
    expectedPatchSlot: null, minimalRepro?: string }
  ```
- Add `packages/host/src/eval/badcase-export.ts`: convert into two formats — SFT (instruction + trace + gold) and RL (prompt + rollout + reward=0 signal).
- Run detail page gains a **Bad Cases** tab:
  - Grouped by failureCategory (patch-apply-failure / test-timeout / agent-error / infra-error / ...)
  - Trace summary (first 20 steps + last 10 steps)
  - Labeling dropdown: `[not-a-bug / needs-more-context / model-limitation / infra-flake / worth-retraining]`
  - "Export selected cases as training data" button → JSONL download
- Labels persist in the existing `run-registry`; no new store.
- `docs/evals/badcase-mining.md` describes category definitions and canonical cases.

**Acceptance**: SWE-bench Lite 5 tasks → Bad Cases → categorized → label 3 → export JSONL → all fields present and trainable.

---

## A.6 Demo script

- `scripts/demo-benchmark-to-badcase.mjs`: headless driver for the full demo.
- README-top 60s GIF: wizard → Bad Cases → export.

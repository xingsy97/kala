# Roadmap · Part A · translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（3 translated historical texttranslated historical texttranslated historical texttranslated historical text）

## translated historical texttranslated historical text

Benchmark translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text SWE-bench。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text 4 translated historical texttranslated historical texttranslated historical text agent translated historical texttranslated historical texttranslated historical text：

| Benchmark | translated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | agent-kernel translated historical texttranslated historical text |
|---|---|---|---|
| SWE-bench | Coding agent / real GitHub issue repair | ICLR 2024 oral，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | patch、trace、official harness、bad-case translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| Terminal-Bench | Terminal agent / long-running CLI tasks | translated historical texttranslated historical texttranslated historical texttranslated historical text shell translated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text executor translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical text cwd、shell、file edit、test script、recording |
| WebArena | Web agent / browser navigation | translated historical texttranslated historical text self-hosted web agent benchmark | translated historical texttranslated historical text browser runtime、trajectory replay、page evaluator |
| τ-bench / τ³-bench | General tool-use / user-interaction agent | translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical text、policy compliance translated historical texttranslated historical texttranslated historical texttranslated historical text benchmark | translated historical texttranslated historical text tool protocol、multi-turn state、reward breakdown |

**translated historical texttranslated historical texttranslated historical texttranslated historical text**：OSWorld translated historical texttranslated historical text desktop/computer-use benchmark translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text GUI/VM，translated historical texttranslated historical texttranslated historical texttranslated historical text）。

**translated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical text benchmark translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text domain doc translated historical texttranslated historical texttranslated historical text：

- [SWE-bench Evaluation](../../evals/domain-knowledge/swe-bench-evaluation.md)
- [Terminal-Bench Evaluation](../../evals/domain-knowledge/terminal-bench-evaluation.md)
- [WebArena Evaluation](../../evals/domain-knowledge/webarena-evaluation.md)
- [Tau-Bench / Tau3-Bench Evaluation](../../evals/domain-knowledge/tau-bench-evaluation.md)

---

## A.1 BenchmarkAdapter interface

translated historical texttranslated historical texttranslated historical texttranslated historical text adapter contract，translated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text benchmark translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text artifact translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text verifier/scoring semantics。

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

**translated historical texttranslated historical texttranslated historical texttranslated historical text**：

- `runVerifier`：SWE-bench translated historical texttranslated historical text official Docker harness；Terminal-Bench translated historical text `run-tests.sh` + parser；WebArena translated historical text evaluator router；τ-bench translated historical text reward evaluator。
- `explainScore` translated historical texttranslated historical texttranslated historical texttranslated historical text benchmark translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `passed` translated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical text adapter translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text normalized failure categories，translated historical text raw official result translated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## A.2 Terminal-Bench adapter

**translated historical texttranslated historical texttranslated historical text**：

- translated historical texttranslated historical text `packages/host/src/eval/terminal-bench.ts`，translated historical texttranslated historical text `run-registry`、`content-inputs`、`sweBenchRunLayout` translated historical texttranslated historical text。
- Dashboard 「Run Benchmark」translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text benchmark translated historical texttranslated historical text。
- Terminal-Bench translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `packages/executor`（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text 5-10 translated historical text，pass rate translated historical texttranslated historical text registry。

**translated historical texttranslated historical text**：Benchmark translated historical text → translated historical text Terminal-Bench → translated historical texttranslated historical text 5 translated historical text → translated historical texttranslated historical text pass rate，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## A.3 WebArena adapter

**translated historical texttranslated historical texttranslated historical text**：

- translated historical texttranslated historical text `packages/host/src/eval/webarena.ts`，translated historical texttranslated historical texttranslated historical texttranslated historical text config、translated historical text task ID translated historical texttranslated historical text、translated historical text site env vars、translated historical texttranslated historical text auth readiness。
- Wizard translated historical texttranslated historical texttranslated historical text WebArena translated historical texttranslated historical texttranslated historical texttranslated historical text：sites reachable / auth state present / Playwright ready。
- Run Agent translated historical texttranslated historical texttranslated historical texttranslated historical text observations/actions/screenshots/trace zip。
- Run Verifier translated historical texttranslated historical text evaluator type：`string_match` / `url_match` / `program_html` + score。
- Review translated historical texttranslated historical text trajectory replay。

**translated historical texttranslated historical text**：translated historical text 3-5 translated historical text WebArena config，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text task translated historical text intent / site / evaluator type / score / trace。

---

## A.4 τ-bench / τ³-bench adapter

**translated historical texttranslated historical texttranslated historical text**：

- translated historical texttranslated historical text `packages/host/src/eval/tau-bench.ts`，translated historical texttranslated historical texttranslated historical texttranslated historical text `sierra-research/tau2-bench`。
- Wizard translated historical texttranslated historical texttranslated historical text domain（airline / retail / telecom / banking_knowledge），translated historical texttranslated historical texttranslated historical text evaluated agent model translated historical text user simulator model。
- Result translated historical texttranslated historical text reward basis：`DB` / `COMMUNICATE` / `ENV_ASSERTION` / `NL_ASSERTION` / `ACTION`。
- UI translated historical texttranslated historical texttranslated historical texttranslated historical text `actions` translated historical text reference trajectory，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text `ACTION` translated historical text `reward_basis`。
- Review translated historical texttranslated historical text conversation / tool calls / tool arguments / reward breakdown。

**translated historical texttranslated historical text**：translated historical text `tau2 run --domain airline --num-tasks 5 --num-trials 1` translated historical texttranslated historical texttranslated historical texttranslated historical text，dashboard translated historical texttranslated historical text task reward、reward breakdown、agent/user/tool trajectory。

---

## A.5 Bad-case translated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）

**translated historical texttranslated historical texttranslated historical text**：

- translated historical texttranslated historical text `packages/host/src/eval/badcase-mining.ts`：translated historical texttranslated historical text runId → translated historical texttranslated historical texttranslated historical texttranslated historical text trial → translated historical text `status ∈ {failed, errored}` translated historical texttranslated historical text → translated historical texttranslated historical text：
  ```
  { instanceId, failureCategory, trace[], toolCallErrors[], verifierReason,
    expectedPatchSlot: null, minimalRepro?: string }
  ```
- translated historical texttranslated historical text `packages/host/src/eval/badcase-export.ts`：translated historical text SFT/RL translated historical texttranslated historical texttranslated historical texttranslated historical text（SFT: instruction + trace + gold；RL: prompt + rollout + reward=0 signal）。
- Run translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text **Bad Cases** tab：
  - translated historical text failureCategory translated historical texttranslated historical text（patch-apply-failure / test-timeout / agent-error / infra-error / ...）
  - Trace translated historical texttranslated historical text（translated historical text 20 translated historical text + translated historical texttranslated historical text 10 translated historical text）
  - translated historical texttranslated historical texttranslated historical texttranslated historical text：`[not-a-bug / needs-more-context / model-limitation / infra-flake / worth-retraining]`
  - 「translated historical texttranslated historical texttranslated historical texttranslated historical text case translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text」translated historical texttranslated historical text → JSONL translated historical texttranslated historical text
- translated historical texttranslated historical texttranslated historical texttranslated historical text `run-registry`，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- `docs/evals/badcase-mining.md` translated historical texttranslated historical text category translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text case。

**translated historical texttranslated historical text**：SWE-bench Lite 5 translated historical text → Bad Cases → translated historical texttranslated historical text → translated historical text 3 translated historical text → translated historical texttranslated historical text JSONL → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## A.6 translated historical texttranslated historical texttranslated historical texttranslated historical text

- `scripts/demo-benchmark-to-badcase.mjs`：headless translated historical texttranslated historical texttranslated historical texttranslated historical text demo。
- README translated historical texttranslated historical text 60s GIF：wizard → Bad Cases → translated historical texttranslated historical text。

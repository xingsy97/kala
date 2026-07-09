# Roadmap · Part D · translated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical text，4 translated historical texttranslated historical texttranslated historical texttranslated historical text）

**translated historical texttranslated historical texttranslated historical texttranslated historical text**：Benchmark UI translated historical text CLI translated historical texttranslated historical texttranslated historical text domain knowledge translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text benchmark translated historical texttranslated historical texttranslated historical text SWE-bench translated historical texttranslated historical text。SWE-bench translated historical text `resolved` translated historical texttranslated historical text official harness；Terminal-Bench translated historical text `is_resolved` translated historical texttranslated historical text test parser；WebArena translated historical texttranslated historical text evaluator score；τ-bench translated historical texttranslated historical text reward basis translated historical texttranslated historical texttranslated historical text。**UI translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text pipeline，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text benchmark kind translated historical texttranslated historical text。**

---

## D.0 Phase 0：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical text benchmark modal translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。Benchmark / Operations / Artifacts translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical text、translated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical text page workspace，translated historical texttranslated historical text modal。

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text route shape**：

| translated historical texttranslated historical text | URL hash translated historical texttranslated historical text | translated historical texttranslated historical text |
|---|---|---|
| Agent | `#/agent/session/:sessionId` | translated historical texttranslated historical texttranslated historical texttranslated historical text、trace、debugger |
| Benchmarks | `#/benchmarks/runs/:runId?task=:taskId&tab=review` | translated historical texttranslated historical text run、translated historical texttranslated historical texttranslated historical texttranslated historical text、bad-case review |
| Operations | `#/operations/executors/:executorId` | host/executor/job/release translated historical texttranslated historical text |
| Artifacts | `#/artifacts/:artifactId` | JSON/diff/text/log translated historical texttranslated historical texttranslated historical texttranslated historical text |
| Settings | `#/settings/models` | provider/model/notification/theme translated historical texttranslated historical text |

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：

- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `useBenchmarkRuns`、`useBenchmarkRun`、`useArtifacts`、`useOperationsStatus` hook。
- translated historical texttranslated historical texttranslated historical text Benchmarks / Operations / Artifacts translated historical texttranslated historical texttranslated historical texttranslated historical text fetch / parse / polling translated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text job/status translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

**MVP translated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text 5 tab + Benchmark run translated historical texttranslated historical text + Selected Run + Inspector + Artifact deep-link + SWE-bench translated historical texttranslated historical texttranslated historical texttranslated historical text；Terminal-Bench / WebArena / τ-bench translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text adapter-ready translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text mock translated historical texttranslated historical texttranslated historical text。

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：

- translated historical texttranslated historical text icon-only action translated historical texttranslated historical texttranslated historical text tooltip translated historical text aria-label；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text icon translated historical texttranslated historical texttranslated historical text。
- ≥1024px translated historical texttranslated historical text；768-1023 translated historical texttranslated historical text；<768 Inspector translated historical text drawer。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text scrollbar translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text native scrollbar。
- Playwright translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text desktop translated historical text mobile translated historical texttranslated historical text viewport。

---

## D.1 Phase 1：translated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text 1 translated historical text）

**translated historical texttranslated historical text**：translated historical text「Agent + translated historical texttranslated historical texttranslated historical text Artifacts translated historical texttranslated historical texttranslated historical text 5 translated historical texttranslated historical texttranslated historical text」translated historical texttranslated historical text 5 translated historical texttranslated historical texttranslated historical text tab：

```
Agent | Benchmarks | Operations | Artifacts | Settings
```

**translated historical texttranslated historical texttranslated historical text**：

- translated historical texttranslated historical text `packages/dashboard/src/app-shell/` translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical text nav + translated historical texttranslated historical text。
- URL hash translated historical texttranslated historical text；deep-link translated historical texttranslated historical text；session translated historical texttranslated historical texttranslated historical texttranslated historical text。
- Command Palette translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（`Open eval dashboard` → `Open Benchmarks`；`Open ops artifacts` → `Open Operations`）。
- translated historical text ArtifactExplorerDialog translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical text tab translated historical text「Advanced / Raw actions」translated historical texttranslated historical texttranslated historical text。

**translated historical texttranslated historical text**：translated historical texttranslated historical text 5 tab；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；Command Palette translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## D.2 Phase 2：Benchmarks translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text 2 translated historical text）

**translated historical texttranslated historical texttranslated historical text**：

- `packages/dashboard/src/pages/BenchmarksPage.tsx`：translated historical texttranslated historical text（Runs list / Selected Run / Inspector）。
- Runs list translated historical texttranslated historical text `run-registry` translated historical texttranslated historical text API。
- Selected Run translated historical texttranslated historical text **benchmark-aware** pipeline；translated historical texttranslated historical text step translated historical text Details translated historical texttranslated historical text。
- Inspector：artifacts translated historical texttranslated historical text + JSON viewer。
- 「New benchmark run」translated historical texttranslated historical texttranslated historical text wizard。
- Bad Cases tab translated historical text Selected Run translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text tab。

**Benchmark picker translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：

| Label | Benchmark kind | translated historical texttranslated historical texttranslated historical texttranslated historical text |
|---|---|---|
| Software Engineering | SWE-bench | Fix real GitHub issues; score with official Docker harness. |
| Terminal Tasks | Terminal-Bench | Complete real shell tasks; score with task test script and parser. |
| Web Navigation | WebArena | Operate self-hosted websites; score with string/url/html evaluators. |
| Tool/User Interaction | τ-bench | Serve simulated users with domain tools; score with reward basis. |

**translated historical texttranslated historical text benchmark translated historical text pipeline label**：

| Benchmark | Pipeline |
|---|---|
| SWE-bench | Choose Tasks → Run Agent → Official Score → Import Results → Review |
| Terminal-Bench | Choose Tasks → Run Agent → Run Verifier → Import Results → Review |
| WebArena | Choose Tasks → Prepare Environment → Run Agent → Run Evaluator → Review |
| τ-bench | Choose Tasks → Configure Roles → Run Simulation → Compute Reward → Review |

**translated historical texttranslated historical texttranslated historical text**：

| translated historical texttranslated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
|---|---|---|
| Task | SWE-bench instance | instance（translated historical texttranslated historical texttranslated historical texttranslated historical text）、case |
| Prediction ready | translated historical texttranslated historical texttranslated historical text `model_patch` | resolved、passed |
| Patch applied | harness translated historical texttranslated historical texttranslated historical texttranslated historical text `model_patch` | tests passed |
| Official tests ran | `eval.sh` translated historical texttranslated historical texttranslated historical texttranslated historical text | resolved |
| Resolved | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `resolved=true` | agent done |
| Regression check | `PASS_TO_PASS` | unrelated tests |
| Terminal verifier | Terminal-Bench `run-tests.sh` + parser | official score |
| Web score | WebArena evaluator result | resolved |
| Reward basis | τ-bench components that gate reward | reference actions |
| Reference trajectory | one valid τ-bench tool-call path | required actions, unless `ACTION` is in reward basis |

---

## D.3 Phase 3：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text 3 translated historical texttranslated historical text）

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：

| translated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical text） | translated historical text（translated historical texttranslated historical texttranslated historical text） |
|---|---|
| Plan | Choose Tasks |
| Predictions / Infer | Run Agent |
| Grade | Official Score |
| Ingest | Import Results |
| Review | Review |
| instances / instance_id | tasks / task_id（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text） |
| patchesDir / predictionsPath / resultsDir | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text「Show technical details」translated historical text |

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**（translated historical texttranslated historical text lint / translated historical texttranslated historical text）：

- **`resolved` translated historical texttranslated historical texttranslated historical text Import Results translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text UI translated historical texttranslated historical texttranslated historical text**。Run Agent translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text「predictions ready / N completed / M agent-failure」，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text resolved。
- **`model_patch` translated historical text `test_patch` translated historical texttranslated historical texttranslated historical texttranslated historical text**。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text「Agent patch」translated historical text「Official test patch」；raw JSON translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- **translated historical texttranslated historical text benchmark translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**。SWE-bench translated historical texttranslated historical texttranslated historical text `resolved`；Terminal-Bench translated historical texttranslated historical texttranslated historical text `resolved/unresolved` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text parser；WebArena translated historical texttranslated historical texttranslated historical text `score`；τ-bench translated historical texttranslated historical texttranslated historical text `reward`。
- **τ-bench translated historical text `actions` translated historical texttranslated historical texttranslated historical text Reference trajectory**，translated historical texttranslated historical texttranslated historical text Required actions（translated historical texttranslated historical text `ACTION` translated historical text `reward_basis`）。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `Input / Action / Output` translated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `<details>` translated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical text。

**translated historical texttranslated historical texttranslated historical text**：

- `packages/dashboard/src/i18n/resources.ts` translated historical texttranslated historical texttranslated historical texttranslated historical text（en + zh translated historical texttranslated historical text）。
- translated historical texttranslated historical text `packages/dashboard/src/features/benchmarks/StepCard.tsx` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical text `BenchmarksPage.test.tsx` translated historical texttranslated historical text：`Run Agent completed` translated historical text DOM translated historical texttranslated historical text `resolved`。
- translated historical texttranslated historical text copy snapshot translated historical texttranslated historical text：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `predictionsPath` / `patchesDir` / `resultsDir` / translated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical text benchmark copy matrix translated historical texttranslated historical text：Terminal-Bench translated historical texttranslated historical texttranslated historical text `Official Score`；WebArena translated historical texttranslated historical text score translated historical texttranslated historical text resolved；τ-bench translated historical texttranslated historical text reference trajectory translated historical texttranslated historical text required actions。

---

## D.4 Phase 4：Operations translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text 3 translated historical texttranslated historical text）

**translated historical texttranslated historical texttranslated historical text**：

- `packages/dashboard/src/pages/OperationsPage.tsx`：translated historical texttranslated historical text sections（Host / Executors / Jobs / Reliability / Releases / Notifications），translated historical texttranslated historical text selected section content，translated historical texttranslated historical text Inspector（Logs / Artifacts / Raw JSON / Actions）。
- Host section translated historical texttranslated historical text `artifact-manifest` + `executor-capabilities`。
- Executors section translated historical text executor translated historical texttranslated historical texttranslated historical texttranslated historical text，`[Copy connect command] [View logs] [Disconnect]`。
- Jobs section translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- Reliability section translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `reliability-supervisor` translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical text JSON。

**translated historical texttranslated historical text**：translated historical texttranslated historical text Operations tab，translated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical text executor translated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## D.5 Phase 5：Artifacts translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text 4 translated historical text）

**translated historical texttranslated historical texttranslated historical text**：

- `packages/dashboard/src/pages/ArtifactsPage.tsx`：translated historical texttranslated historical text browser，translated historical texttranslated historical text filters（kind / run / session / time），translated historical texttranslated historical text viewer（JSON / diff / text）。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text artifact translated historical texttranslated historical texttranslated historical texttranslated historical text「translated historical text Artifacts translated historical texttranslated historical texttranslated historical text」translated historical texttranslated historical texttranslated historical text「translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text」。
- translated historical texttranslated historical text ArtifactExplorerDialog translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text inline link translated historical texttranslated historical text。
- Artifact URL translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

**translated historical texttranslated historical text**：Artifacts tab translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；Benchmarks translated historical texttranslated historical texttranslated historical text artifact translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text Artifacts tab translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

---

## D.6 Phase 6：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text 4 translated historical texttranslated historical text）

- translated historical texttranslated historical texttranslated historical texttranslated historical text：translated historical texttranslated historical texttranslated historical text card-in-card、translated historical texttranslated historical texttranslated historical text native scrollbar、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical text sticky header。
- translated historical texttranslated historical texttranslated historical texttranslated historical text：`packages/dashboard/scripts/verify-visual-pages.mjs` translated historical text tab translated historical texttranslated historical texttranslated historical texttranslated historical text/AI translated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical text：Benchmark run list translated historical texttranslated historical text、minimap/translated historical texttranslated historical texttranslated historical texttranslated historical text、Inspector artifact deep-link、mobile drawer translated historical texttranslated historical texttranslated historical texttranslated historical text。

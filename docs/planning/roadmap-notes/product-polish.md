# Roadmap · Part D · Product polish (parallel, 4-week phased)

Product polish is the 100 → 120 delta. **Required, and must be done in Phase order — do not skip.**

**Semantic baseline**: Benchmark UI and CLI must follow domain knowledge, not force every benchmark into SWE-bench vocabulary. `resolved` in SWE-bench comes from the official harness; `is_resolved` in Terminal-Bench comes from the test parser; WebArena reports evaluator score; τ-bench reports a product of reward basis components. **The pipeline can be unified, but scoring explanations must remain benchmark-specific.**

---

## D.0 Phase 0: page-level design constraints (before starting)

**Why first**: the earlier benchmark modal was hard to use not because a button was misplaced, but because a page-level workflow was crammed into a short-action popup. Benchmark / Operations / Artifacts all require dwelling, comparing, revisiting, deep-linking, and post-mortems — page workspaces, not modals.

**Route shape (required)**:

| Page | URL hash example | Purpose |
|---|---|---|
| Agent | `#/agent/session/:sessionId` | Current session, trace, debugger |
| Benchmarks | `#/benchmarks/runs/:runId?task=:taskId&tab=review` | Eval run, task detail, bad-case review |
| Operations | `#/operations/executors/:executorId` | Host/executor/job/release status |
| Artifacts | `#/artifacts/:artifactId` | Full-page JSON/diff/text/log view |
| Settings | `#/settings/models` | Provider/model/notification/theme config |

**Shared data boundaries**:

- Add or consolidate `useBenchmarkRuns`, `useBenchmarkRun`, `useArtifacts`, `useOperationsStatus` hooks.
- Benchmarks / Operations / Artifacts must not each duplicate fetch / parse / polling logic.
- Long-running tasks go through the unified job/status model; pages just subscribe to state.

**MVP boundary**: v1 requires only 5 tabs + Benchmark run list + Selected Run + Inspector + Artifact deep-link + SWE-bench actually runnable; Terminal-Bench / WebArena / τ-bench may show adapter-ready empty states and environment checklists, but the empty state must explain exactly what input is needed next — no mock data.

**Accessibility and responsiveness acceptance**:

- Every icon-only action needs a tooltip or aria-label; the main nav must have both icon and text.
- ≥1024px three-column; 768-1023 two-column; <768 Inspector becomes drawer.
- All scroll regions use the project's unified scrollbar style — no bare native scrollbar.
- Playwright screenshots cover at least desktop and mobile viewports.

---

## D.1 Phase 1: top-level navigation (Week 1)

**Goal**: move from "Agent + one big Artifacts dialog stuffing 5 features" to 5 top-level tabs:

```
Agent | Benchmarks | Operations | Artifacts | Settings
```

**What to do**:

- Add `packages/dashboard/src/app-shell/` directory for top nav + routing.
- URL hash routing; deep-link recovery; session state preserved.
- Command Palette labels updated (`Open eval dashboard` → `Open Benchmarks`; `Open ops artifacts` → `Open Operations`).
- The old ArtifactExplorerDialog is kept but demoted from the main entry point — reachable under each tab's "Advanced / Raw actions" submenu.

**Acceptance**: 5 top tabs, switching preserves state, Command Palette copy updated, screenshot evidence.

---

## D.2 Phase 2: Benchmarks as a standalone page (Week 2)

**What to do**:

- `packages/dashboard/src/pages/BenchmarksPage.tsx`: three-column (Runs list / Selected Run / Inspector).
- Runs list reuses the `run-registry` list API.
- Selected Run shows a **benchmark-aware** pipeline; each step has a Details fold.
- Inspector: artifact index + JSON viewer.
- "New benchmark run" opens the wizard.
- Bad Cases tab appears under Selected Run as a secondary tab.

**Benchmark picker organized by capability axis**:

| Label | Benchmark kind | First-screen description |
|---|---|---|
| Software Engineering | SWE-bench | Fix real GitHub issues; score with official Docker harness. |
| Terminal Tasks | Terminal-Bench | Complete real shell tasks; score with task test script and parser. |
| Web Navigation | WebArena | Operate self-hosted websites; score with string/url/html evaluators. |
| Tool/User Interaction | τ-bench | Serve simulated users with domain tools; score with reward basis. |

**Pipeline labels per benchmark**:

| Benchmark | Pipeline |
|---|---|
| SWE-bench | Choose Tasks → Run Agent → Official Score → Import Results → Review |
| Terminal-Bench | Choose Tasks → Run Agent → Run Verifier → Import Results → Review |
| WebArena | Choose Tasks → Prepare Environment → Run Agent → Run Evaluator → Review |
| τ-bench | Choose Tasks → Configure Roles → Run Simulation → Compute Reward → Review |

**Glossary**:

| User-facing | Technical meaning | Must not misspell as |
|---|---|---|
| Task | SWE-bench instance | instance (default view), case |
| Prediction ready | `model_patch` generated | resolved, passed |
| Patch applied | harness applied `model_patch` successfully | tests passed |
| Official tests ran | `eval.sh` completed | resolved |
| Resolved | official report has `resolved=true` | agent done |
| Regression check | `PASS_TO_PASS` | unrelated tests |
| Terminal verifier | Terminal-Bench `run-tests.sh` + parser | official score |
| Web score | WebArena evaluator result | resolved |
| Reward basis | τ-bench components that gate reward | reference actions |
| Reference trajectory | one valid τ-bench tool-call path | required actions, unless `ACTION` is in reward basis |

---

## D.3 Phase 3: copy and state model rewrite (early Week 3)

**Renames (strict)**:

| Old (internal term) | New (user-facing) |
|---|---|
| Plan | Choose Tasks |
| Predictions / Infer | Run Agent |
| Grade | Official Score |
| Ingest | Import Results |
| Review | Review |
| instances / instance_id | tasks / task_id (technical detail keeps original) |
| patchesDir / predictionsPath / resultsDir | Hidden from default view, only under "Show technical details" |

**Semantic rules (enforced via lint / tests)**:

- **`resolved` only appears in UI after Import Results completes**. After Run Agent completes, the wording is "predictions ready / N completed / M agent-failure" — never `resolved`.
- **`model_patch` and `test_patch` do not mix**. Default view: "Agent patch" and "Official test patch"; raw JSON keeps the original field names.
- **Different benchmarks' result vocabulary do not mix**. SWE-bench may say `resolved`; Terminal-Bench may say `resolved/unresolved` but must annotate the parser source; WebArena defaults to `score`; τ-bench defaults to `reward`.
- **τ-bench's `actions` defaults to Reference trajectory**, not Required actions (except when `ACTION` is in `reward_basis`).
- Each step's output panel must be an `Input / Action / Output` three-section layout.
- Each step's technical details go into a `<details>` fold, collapsed by default.

**What to do**:

- `packages/dashboard/src/i18n/resources.ts` full rewrite (en + zh).
- Add `packages/dashboard/src/features/benchmarks/StepCard.tsx` enforcing the three-section layout.
- Add `BenchmarksPage.test.tsx` assertion: when `Run Agent completed`, DOM does not contain `resolved`.
- Add copy snapshot test: default view does not show `predictionsPath` / `patchesDir` / `resultsDir` / absolute paths.
- Add benchmark copy matrix test: Terminal-Bench does not show `Official Score`; WebArena does not spell score as resolved; τ-bench does not spell reference trajectory as required actions.

---

## D.4 Phase 4: Operations as a standalone page (late Week 3)

**What to do**:

- `packages/dashboard/src/pages/OperationsPage.tsx`: left-side sections (Host / Executors / Jobs / Reliability / Releases / Notifications), center is selected section content, right is Inspector (Logs / Artifacts / Raw JSON / Actions).
- Host section reuses `artifact-manifest` + `executor-capabilities`.
- Executors section: one card per executor, `[Copy connect command] [View logs] [Disconnect]`.
- Jobs section shows background long tasks.
- Reliability section presents `reliability-supervisor` output in product language, not raw JSON.

**Acceptance**: opening Operations tab shows host health, connected executors, and active tasks at a glance.

---

## D.5 Phase 5: Artifacts as a supporting full page (Week 4)

**What to do**:

- `packages/dashboard/src/pages/ArtifactsPage.tsx`: full-page browser, left filters (kind / run / session / time), right viewer (JSON / diff / text).
- Artifact links from other pages now open in the Artifacts page rather than a dialog.
- ArtifactExplorerDialog stays as a quick preview but only from inline links on other pages.
- Artifact URLs must be copyable and refreshable.

**Acceptance**: Artifacts tab is a full-page browsing experience; clicking an artifact link on Benchmarks jumps to Artifacts and focuses that file.

---

## D.6 Phase 6: visual consistency cleanup (end of Week 4)

- Global audit: no card-in-card, no native scrollbar, no long explanatory prose inside workflow bodies.
- Every page has a sticky header.
- Visual tests: `packages/dashboard/scripts/verify-visual-pages.mjs` captures per-tab screenshots for human/AI comparison.
- Interaction tests: Benchmark run list selection, minimap/list sync, Inspector artifact deep-link, mobile drawer are all covered.

# Dashboard Navigation, Benchmark, and Operations Redesign Advice

Last updated: 2026-07-11

## Executive Summary

The current dashboard puts Benchmark, Operations, Profiles, Memory, and raw
Artifacts into one modal-style artifact explorer. That structure is the main
reason Benchmark feels confusing. Benchmark and Operations are not temporary
dialogs; they are long-running workspaces with history, state, logs, artifacts,
and follow-up analysis. They should be promoted to top-level pages/tabs.

The default dashboard should be named clearly as the agent workbench. A good
top-level navigation model is:

```text
Agent | Benchmarks | Operations | Artifacts | Settings
```

Recommended page names:

- `Agent`: the current default chat/debugger/runtime workspace.
- `Benchmarks`: SWE-bench and future benchmark workflows.
- `Operations`: host/executor health, reliability, release, update, background jobs.
- `Artifacts`: raw artifact browser and detail viewer.
- `Settings`: models, providers, notification, and UI configuration.

The key design rule is: pages own workflows; modals own short actions and
details. Benchmark creation can still use a small modal, but benchmark run
management should be a page.

## Why The Current Design Feels Wrong

### 1. The Artifact Modal Has Too Many Jobs

The current implementation routes Eval, Ops, Profiles, Memory, and Artifacts
through the same artifact dialog. From the user's perspective, this creates a
mixed mental model:

```text
Am I browsing files?
Am I starting a benchmark?
Am I inspecting an existing run?
Am I doing operations work?
Am I looking at internal evidence?
```

These are different tasks. Putting them behind one modal makes every tab feel
secondary, even when the task is actually central.

### 2. Benchmark Is A Long-Running Workflow, Not A Temporary Dialog

A benchmark run has lifecycle state:

```text
Choose tasks -> Run agent -> Produce predictions -> Run official scoring -> Import results -> Review failures
```

It also has persistent objects:

- run id
- dataset and split
- task list
- worker plan
- predictions JSONL
- official scoring command
- imported official results
- per-instance traces, patches, logs, and verdicts
- comparisons against other runs

This is the shape of a page-level workspace. A modal does not provide enough
space, navigation, or permanence for it.

### 3. Operations Is Also A Workspace

Operations is not just a list of artifact actions. It should answer questions
like:

- Is the host healthy?
- Which executors are connected?
- Are background jobs running or stuck?
- Is a release/update available?
- Are reliability checks passing?
- Which notifications fired and why?

Those questions require a persistent status page, not a modal tab hidden under
Artifacts.

### 4. The Current Benchmark Wizard Exposes Internal Concepts Too Early

The wizard currently exposes concepts such as task JSONL, `instance_id`, worker
plans, predictions, official harness, patches, result ingestion, and artifact
paths in one flow. Those concepts are real and useful for teaching, but they
need layered disclosure:

```text
Default view: user task and current status.
Detail view: generated artifacts and protocol fields.
Raw view: JSON, paths, requests, responses, and logs.
```

The teaching goal is not to show everything at once. It is to make the internal
pipeline inspectable when the user asks for detail.

### 5. Modal UI Weakens Production-Level Navigation

Benchmark and Operations need deep links and durable navigation. A production
user should be able to return to:

```text
/benchmarks/run/swebench-2026-07-11
/benchmarks/run/swebench-2026-07-11/failures
/operations/executors
/operations/reliability
/artifacts/runs/swebench/.../summary.json
```

Even if the app does not immediately implement URL routing, the UI should be
designed as if these locations exist. Modal-only workflows make that harder.

## Proposed Top-Level Information Architecture

### Global Navigation

Use a stable top-level navigation bar or app rail:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Agent Kernel                                                         │
│ [Agent] [Benchmarks] [Operations] [Artifacts]              [Settings]│
└──────────────────────────────────────────────────────────────────────┘
```

Recommended behavior:

- `Agent` is the default page after loading the dashboard.
- `Benchmarks` opens the benchmark workspace, not a modal.
- `Operations` opens the operations workspace, not the artifact dialog.
- `Artifacts` opens a full-page artifact explorer.
- Small detail modals are still allowed inside each page.

### Page Responsibilities

#### Agent

Purpose: run and teach the agent loop.

Contains:

- workspace/session explorer
- chat composer
- transcript
- debugger side panel
- trace/state/tool/LLM API views
- current runtime status

Suggested page title: `Agent Workspace`.

This keeps the current default UI recognizable while giving it a product name.

#### Benchmarks

Purpose: create, monitor, score, import, compare, and review benchmark runs.

Contains:

- run list
- run overview
- benchmark pipeline
- failure review table
- official scoring handoff
- artifact inspector
- comparison tools

This page should not feel like a generic artifact browser. It should feel like a
benchmark control room.

#### Operations

Purpose: operate the host/executor system.

Contains:

- host status
- connected executors
- executor launch/connect instructions
- release/update status
- background jobs
- reliability reports
- notifications
- operational logs and artifact links

This page should not require users to know which artifact file stores which
report.

#### Artifacts

Purpose: browse raw persisted evidence.

Contains:

- artifact manifest
- filters by kind/run/session
- raw file viewer
- JSON/diff/text rendering
- open-from-other-page detail target

Artifacts is a supporting page. It should not be the primary surface for
Benchmark or Operations workflows.

## Ideal Benchmark Page Design

### Page Layout

```text
Benchmarks
┌──────────────────────────────────────────────────────────────────────┐
│ Header                                                               │
│  New run   Import results   Compare runs          Dataset: SWE-bench │
├───────────────┬──────────────────────────────────────┬───────────────┤
│ Runs          │ Selected Run                         │ Inspector     │
│               │                                      │               │
│ swebench-a    │ Pipeline                             │ Artifacts     │
│ swebench-b    │ Tasks -> Agent -> Official -> Import │ Raw details   │
│ swebench-c    │                                      │ Command       │
│               │ Summary                              │ Trace links   │
│ filters       │ Failures                             │ Harness logs  │
└───────────────┴──────────────────────────────────────┴───────────────┘
```

Recommended dimensions:

- Left run list: 260-320px.
- Main content: flexible.
- Right inspector: 320-420px, collapsible.
- Use the existing restrained dashboard style: `bg-background`, `bg-card`,
  `bg-muted/20-40`, subtle rings, compact rows, no nested card stacks.

### Benchmark Run List

Each run row should show only scan-critical information:

```text
✓ swebench-lite-gpt-5-001
  SWE-bench Lite · gpt-5.5 · 12 tasks · 7 resolved

◌ swebench-local-test
  predictions ready · official results not imported
```

Avoid showing artifact paths in the run list. Paths belong in the inspector.

### Benchmark Pipeline

The selected run should always show its lifecycle:

```text
┌────────────┐   ┌───────────┐   ┌────────────────┐   ┌──────────────┐   ┌────────┐
│ 1 Tasks    │ → │ 2 Agent   │ → │ 3 Official     │ → │ 4 Import     │ → │ Review │
│ ready: 12  │   │ done: 12  │   │ command ready  │   │ 7/12 resolved│   │ open   │
└────────────┘   └───────────┘   └────────────────┘   └──────────────┘   └────────┘
```

Each step should have:

- user-facing status
- one primary action
- a short output summary
- a `Details` disclosure for teaching/debug info

### New Benchmark Run Flow

Do not start with five fields and three data source tabs. Start with intent.

Step 0: choose workflow.

```text
New Benchmark Run

[ Run agent-kernel on SWE-bench tasks ]
Use a dataset or JSONL task list. agent-kernel runs the agent and writes predictions.

[ Import existing predictions or patches ]
Use artifacts produced elsewhere, then score/import official results here.
```

This removes the current confusion where the user discovers the external-patch
path only inside an advanced section of the Infer step.

### Step 1: Choose Tasks

Default UI:

```text
Choose tasks

Source
(*) SWE-bench Lite     300 tasks
( ) SWE-bench Verified 500 tasks
( ) SWE-bench Full     2294 tasks
( ) Upload JSONL
( ) Paste JSONL

Limit for this run: [ 12 ]

[Prepare task list]
```

After preparing:

```text
12 tasks ready
Source: SWE-bench Lite, split=test, limit=12

[Show technical details]
  Artifact: runs/swebench/<runId>/instances.jsonl
  Required field: instance_id
  Rows: 12
```

Use `tasks` in default UI. Reserve `instances` and `instance_id` for technical
details because those are SWE-bench protocol terms.

### Step 2: Run Agent

Default UI:

```text
Run agent

Agent runtime: agent-kernel executor
Model: openai/gpt-5.5
Workers: 4

[Run predictions]
```

During run:

```text
Running predictions
8 / 12 tasks completed
Current: django__django-11815

Completed: 8   Agent failures: 1   Infrastructure errors: 0
```

After run:

```text
Predictions ready
11 predictions completed, 1 agent failure, 0 infrastructure errors

[Show technical details]
  Artifact: predictions.jsonl
  Official fields: instance_id, model_name_or_path, model_patch
  Not scored yet: true
```

The text must never imply `resolved` at this step.

### Step 3: Official Score

This step is a handoff to SWE-bench's official Docker harness.

Default UI:

```text
Official scoring

SWE-bench scoring runs outside the dashboard. It applies each predicted patch in
Docker and runs the official FAIL_TO_PASS / PASS_TO_PASS tests.

Requirements
Docker · SWE-bench installed · enough disk and memory

Command
python -m swebench.harness.run_evaluation ...

[Copy command]
```

Do not make this look like a dashboard-owned scoring button unless the host is
actually going to run and supervise the Docker job.

### Step 4: Import Results

Rename `Ingest` to `Import official results` in user-facing UI.

Default UI:

```text
Import official results

Drop or paste official SWE-bench output files:
- instance_results.jsonl
- instance_results.json
- results.json

[Import official results]
```

After import:

```text
Official results imported
7 / 12 resolved
5 unresolved
```

This is the first step where `resolved` should appear.

### Step 5: Review

Default UI:

```text
Review run

Tasks: 12
Predictions: 11 completed, 1 agent failure
Official results: imported
Resolved: 7 / 12

Failures
django__django-11815  test_failure       Open trace   Open patch   Open harness log
sympy__sympy-20590    patch_apply_error  Open trace   Open patch   Open harness log
```

The review view should be optimized for debugging failed tasks, not just
displaying aggregate numbers.

## Ideal Operations Page Design

### Page Layout

```text
Operations
┌──────────────────────────────────────────────────────────────────────┐
│ Header: Host online · 3 executors · release v0.4.2 · notifications on │
├───────────────┬──────────────────────────────────────┬───────────────┤
│ Sections      │ Main                                 │ Inspector     │
│ Host          │ Selected section content              │ Logs          │
│ Executors     │                                      │ Artifacts     │
│ Jobs          │                                      │ Raw JSON      │
│ Reliability   │                                      │ Actions       │
│ Releases      │                                      │               │
│ Notifications │                                      │               │
└───────────────┴──────────────────────────────────────┴───────────────┘
```

### Operations Sections

#### Host

Show:

- host version
- dashboard version
- uptime
- artifact root
- connected socket status
- background reload status
- last error

#### Executors

Show executor cards:

```text
executor-laptop
online · <home>ser/project · node 22 · auto-update available

[Copy connect command] [View logs] [Disconnect]
```

The existing connect-workspace modal can become a short action modal opened from
this page.

#### Jobs

Show long-running tasks:

- benchmark runs
- official scoring jobs, if host-supervised in the future
- release asset checks
- artifact pruning
- reliability checks

#### Reliability

Show reliability reports in product language:

- pass/fail
- failure categories
- affected sessions
- linked artifacts

#### Releases / Updates

Show:

- current version
- latest GitHub release
- update reminder state
- checksum/verification status
- one-line install/update command

#### Notifications

Show desktop notification settings and event types:

- approval needed
- question/tool selection needed
- benchmark complete
- operation failed
- executor disconnected

This matches the earlier design principle: use hooks/subscriptions or a similar
extension mechanism so notification behavior does not inflate core state-machine
logic.

## What Should Stay Modal-Based

Modals are still useful, but only for bounded tasks:

- New benchmark run setup.
- Import official results.
- Artifact detail viewer.
- Raw LLM request/response detail.
- Session metadata.
- Connect executor command.
- Confirm delete/prune actions.
- Settings subsections.

Rule of thumb:

```text
If the user might stay there for several minutes, compare multiple objects, or
return later, it should be a page.

If the user completes one focused action and closes it, it can be a modal.
```

## Migration Plan

### Phase 1: Add Top-Level Navigation Without Moving Logic

Goal: give the product a correct shape without a large rewrite.

Changes:

1. Add top-level tabs: `Agent`, `Benchmarks`, `Operations`, `Artifacts`,
   `Settings`.
2. Rename the current default view to `Agent Workspace`.
3. Keep existing artifact dialog code available, but open it from the relevant
   top-level page as an implementation detail.
4. Update command palette labels:
   - `Open eval dashboard` -> `Open Benchmarks`
   - `Open ops artifacts` -> `Open Operations`
   - `Open artifacts` remains raw artifact browser.

Acceptance criteria:

- User can identify the current page from the top nav.
- Benchmark and Operations no longer look like secondary modal features.
- Existing tests continue to pass.

### Phase 2: Promote Benchmarks To A Real Page

Goal: stop using the artifact dialog as the primary benchmark surface.

Changes:

1. Create a `BenchmarksPage` that reuses the existing manifest loading and eval
   row parsing logic.
2. Move run list, run summary, worker plans, comparisons, and trial details into
   page layout.
3. Keep the raw `Eval Artifact Actions` form only inside an `Advanced` or
   `Raw actions` section.
4. Replace the current inline guided wizard with a `New benchmark run` flow.
5. Add a right inspector for artifacts and protocol details.

Acceptance criteria:

- Benchmark page can show existing runs without opening a modal.
- Creating a new run starts from user intent: run agent-kernel or import
  existing predictions/patches.
- The main page always shows pipeline state for the selected run.
- Raw artifact paths are available but not dominant.

### Phase 3: Redesign Benchmark Flow Copy And State Model

Goal: make the benchmark flow understandable while preserving teaching detail.

Changes:

1. Rename user-facing steps:
   - `Plan` -> `Choose Tasks`
   - `Predictions` -> `Run Agent`
   - `Grade` -> `Official Score`
   - `Ingest` -> `Import Results`
   - `Review` -> `Review`
2. Use `tasks` in default UI and keep `instance_id` only in technical details.
3. Add per-step output cards with `Input`, `Action`, and `Output` sections.
4. Add details disclosures for generated artifacts:
   - `instances.jsonl`
   - `worker-plan.json`
   - `predictions.jsonl`
   - official command
   - imported results
5. Ensure `resolved` appears only after official result import.

Acceptance criteria:

- A first-time user can explain what each step does without knowing internal
  action names.
- A technical user can still inspect artifact paths and protocol fields.
- The UI never implies predictions are official results.

### Phase 4: Promote Operations To A Real Page

Goal: make operational state visible without forcing users through artifact
names.

Changes:

1. Create `OperationsPage` with sections for Host, Executors, Jobs,
   Reliability, Releases, and Notifications.
2. Reuse existing ops artifacts as evidence, but render product-level summaries.
3. Move executor connect/run commands into focused modals opened from Operations.
4. Add operational status cards and linked raw artifacts.

Acceptance criteria:

- User can tell whether host and executors are healthy from one page.
- Reliability reports are readable without opening raw JSON first.
- Release/update state is visible and copyable.
- Raw artifacts remain accessible from the inspector.

### Phase 5: Make Artifacts A Supporting Full Page

Goal: keep raw evidence powerful without making it the main UX for everything.

Changes:

1. Convert artifact browser to a full page.
2. Support deep linking or route-like internal state for artifact paths.
3. Keep JSON/diff/text viewers and search/filter controls.
4. Allow other pages to open selected artifacts in the right inspector or detail
   modal.

Acceptance criteria:

- Benchmark and Operations pages link to raw artifacts.
- Artifact browsing is still available for debugging.
- Users are not forced to start workflows from the artifact browser.

## Detailed UI Copy Recommendations

### Navigation

Use:

```text
Agent
Benchmarks
Operations
Artifacts
Settings
```

Avoid:

```text
Eval Artifact Actions
Ops Artifacts
Run Benchmark (guided)
```

Those labels describe implementation details, not user goals.

### Benchmark Step Copy

Use:

```text
Choose Tasks
Pick a SWE-bench dataset or provide a JSONL task list.

Run Agent
Run agent-kernel on the selected tasks and write predictions.

Official Score
Copy the SWE-bench official Docker scoring command. Nothing is marked resolved here.

Import Results
Import official harness output so resolved counts and failure labels become available.

Review
Inspect failures, traces, patches, and official harness logs.
```

Avoid exposing these in the main flow unless expanded:

```text
instancesJsonl
patchesDir
resultsDir
ingest
artifact action
enhancement action
```

### Operations Copy

Use:

```text
Host
Executors
Background Jobs
Reliability
Releases
Notifications
```

Avoid:

```text
Ops Artifact Actions
Reliability chaos replay
Trace export OTLP
```

Those can exist in advanced/debug sections.

## Visual Design Principles

Use the existing dashboard style, but give page-level workflows more room.

Recommended:

- Compact cards for repeated items only.
- Full-width page sections for workflow areas.
- Subtle `bg-muted/20-40`, `bg-card`, `ring-border/30-60` surfaces.
- Clear dividers between left list, main content, and inspector.
- Sticky page headers for long pages.
- Custom scrollbars only; no native bare scrollbars.
- Details in collapsible panels or modals, not always-on text blocks.

Avoid:

- Cards inside cards.
- Large modal containing a full product area.
- Long explanatory paragraphs in the active workflow body.
- Artifact paths as primary labels.
- Showing internal protocol fields before user-facing status.

## Testing Plan

### Unit/Component Tests

- Top navigation switches between pages without losing the selected session.
- Benchmark page renders existing runs from artifact manifest.
- Benchmark pipeline shows correct state for:
  - no task list
  - task list ready
  - predictions ready but not scored
  - official command generated
  - results imported
  - failed agent run
- Operations page renders host/executor/job/reliability states.
- Artifact inspector opens linked artifacts from Benchmarks and Operations.

### E2E Tests

- Open dashboard -> default page is `Agent`.
- Navigate to `Benchmarks`, create a small run through dry-run official scoring,
  import fixture official results, and verify resolved count appears only after
  import.
- Navigate to `Operations`, copy executor connect command, inspect a reliability
  report, and open the linked raw artifact.
- Navigate to `Artifacts`, search for a benchmark artifact and open JSON/diff
  content.

### Visual Tests

- Desktop and mobile screenshots for all top-level pages.
- Verify page-level layouts do not use nested card stacks.
- Verify no native bare scrollbar appears.
- Verify text does not overflow compact buttons or status pills.

## Risks And Mitigations

### Risk: The Rewrite Becomes Too Large

Mitigation: first add top-level navigation and reuse existing components. Move
layout before rewriting data flows.

### Risk: Teaching Details Become Hidden

Mitigation: every workflow step should have `Show technical details`. The
default page should be simple, but details must be one click away.

### Risk: Artifact Explorer Loses Importance

Mitigation: make Artifacts a first-class top-level page, but position it as raw
evidence rather than the owner of Benchmark/Ops workflows.

### Risk: Benchmark Boundary Becomes Ambiguous Again

Mitigation: enforce this copy and state rule in tests:

```text
Predictions ready != resolved.
Official results imported => resolved may appear.
```

## Final Target Shape

The ideal product should feel like this:

```text
Agent
  I work with the agent and inspect its internal runtime.

Benchmarks
  I run and review SWE-bench-style evaluations end to end.

Operations
  I operate the host, executors, jobs, releases, and reliability checks.

Artifacts
  I inspect raw evidence generated by all workflows.

Settings
  I configure models, policies, notifications, and UI preferences.
```

This structure matches the project's motivation: a production agent dashboard
that is also teaching-oriented. The main user path stays clear, while internal
state, protocol data, raw requests/responses, artifacts, and official harness
boundaries remain inspectable when needed.

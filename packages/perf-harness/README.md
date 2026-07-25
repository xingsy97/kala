# @agent-kernel/perf-harness

Reusable front-end **performance & rendering diagnostics** for the dashboard.

This package captures the tooling used to find and fix a series of real dashboard
issues (streaming-markdown flicker, status-indicator jank, inspector open cost,
mobile overflow) so the next investigation starts from a library instead of a
throwaway script — and so those fixes can be regression-tested.

It is `private` (never published) and depends only on the workspace's host/
executor/shared packages plus `puppeteer-core` and `source-map`.

## Layers

```
src/
  fixtures/     boot a real stack + shape the load
    local-stack.ts    startLocalStack(): in-process host + executor + a static
                      server for the built dashboard + a ready session. One
                      close() tears it all down. Dashboard and host live on
                      separate origins; the dashboard connects via ?host=.
    scripted-llm.ts   programmable no-API-key LLMs: toolLoopLlm (tool-heavy
                      turns, optional big payloads), streamingMarkdownLlm
                      (token-by-token markdown), replyOnceLlm.
    repo-paths.ts     repo-relative path + Chrome resolution (no absolute paths).

  probes/       measure the browser
    browser-session.ts  openDashboard(): launches Chrome with a throwaway
                        profile (so a stale service-worker bundle can't skew
                        results), optional mobile emulation + CPU throttle.
    dom-churn.ts        measureDomChurn() / measureEarlyRegionChanges():
                        how often elements are torn down/rebuilt (the flicker
                        signal).
    frame-timing.ts     measureFrameTiming(): rAF interval stats — dropped
                        frames, worst hitch (the "is it smooth?" signal).
    cpu-profile.ts      profileMainThread(): CDP CPU profile with **source-map**
                        resolution, so a minified hot spot resolves back to e.g.
                        `toolRiskWeight @ human-attention/evaluator.ts`.
    layout-overflow.ts  detectHorizontalOverflow(): content spilling past the
                        viewport edge (mobile layout bugs).

  scenarios/    concrete reproductions of real issues (each documents the bug,
                the fix, the metric, and a suggested threshold)
    streaming-markdown-flicker.ts
    status-indicator-jank.ts
    inspector-open-cost.ts
    mobile-inspector-overflow.ts
    index.ts            SCENARIOS registry (name → llm + browser conditions + run)

  run-scenario.ts   runScenarioOnce(): boot stack + browser, run one scenario,
                    clean up. Used by the CLI and the tests.

bin/run-scenario.ts   CLI to run scenarios ad hoc.
tests/                environment-sensitive regression tests (self-skip when a
                      dashboard build or Chrome is missing).
```

## Prerequisites

- A **built dashboard bundle**: `pnpm --filter @agent-kernel/dashboard build`.
  For source-mapped CPU hot spots, build with source maps:
  `pnpm --filter @agent-kernel/dashboard build -- --sourcemap`.
- A local **Chrome/Chromium**. Set `PUPPETEER_EXECUTABLE_PATH` (or `CHROME_PATH`)
  if it isn't in a standard location.

## Run scenarios ad hoc

```bash
# list scenarios
pnpm --filter @agent-kernel/perf-harness scenario

# run one (prints metrics + notes)
pnpm --filter @agent-kernel/perf-harness scenario streaming-markdown-flicker

# run all
pnpm --filter @agent-kernel/perf-harness scenario --all

# override CPU throttle (approximate a phone)
THROTTLE=6 pnpm --filter @agent-kernel/perf-harness scenario status-indicator-jank
```

## Run the regression tests

```bash
pnpm --filter @agent-kernel/perf-harness perf
```

They self-skip when the dashboard isn't built or Chrome isn't found, and assert
**structural/relative** signals (e.g. "earlier markdown blocks change ≤ 8 times",
"status indicator re-mounts == 0") rather than absolute milliseconds — headless-
on-a-server timings differ from a real phone.

## Add a new scenario

1. Add a scripted-LLM shape in `fixtures/scripted-llm.ts` if the load isn't
   already covered.
2. Add a probe in `probes/` if you need a new measurement.
3. Create `scenarios/<name>.ts` exporting a `run<Name>(ctx): ScenarioResult`
   that documents the symptom/root-cause/fix and computes metrics + a suggested
   threshold.
4. Register it in `scenarios/index.ts` (`SCENARIOS`). The CLI and tests pick it
   up automatically.

## Known gotchas (baked into the harness)

- **Service-worker caching.** The dashboard registers a service worker; a reused
  browser profile will serve a *stale* bundle and silently invalidate a
  measurement. `openDashboard` uses a fresh throwaway profile + disabled HTTP
  cache every time.
- **Cross-origin.** Dashboard and host run on separate origins; the dashboard
  connects via `?host=`. The host's socket.io CORS defaults to `*`, so this
  works out of the box.
- **CPU throttling.** A fast dev machine hides jank that a phone shows. Use a
  `cpuThrottleRate` (6 ≈ mid-range phone) to surface it.

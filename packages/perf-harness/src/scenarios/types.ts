import type { LocalStack } from '../fixtures/index.js'
import type { BrowserSession } from '../probes/index.js'

/**
 * A scenario is a self-contained reproduction of a specific real-world
 * front-end problem, plus the measurement of it. Each scenario documents:
 *   - what user-facing problem it reproduces,
 *   - the metric(s) it measures,
 *   - a suggested pass/fail threshold (relative/structural, not absolute-ms,
 *     because headless-on-a-server numbers differ from a real phone).
 *
 * Scenarios can be run ad hoc (see bin/run-scenario) or asserted in the
 * regression tests (see tests/). They receive an already-booted stack + browser
 * session so the caller controls lifecycle and can compose them.
 */
export type ScenarioContext = {
  stack: LocalStack
  session: BrowserSession
}

export type ScenarioResult<Metrics extends Record<string, unknown> = Record<string, unknown>> = {
  /** Machine name of the scenario. */
  name: string
  /** One-line description of the problem it reproduces. */
  reproduces: string
  /** The measured metrics. */
  metrics: Metrics
  /** Whether the scenario met its suggested threshold. `null` = advisory only. */
  pass: boolean | null
  /** Human-readable notes / threshold explanation. */
  notes: string
}

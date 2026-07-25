/**
 * @agent-kernel/perf-harness
 *
 * Reusable front-end performance & rendering diagnostics for the dashboard.
 * Three layers:
 *   - fixtures/  : an in-process local stack (host + executor + served dashboard)
 *                  and programmable scripted-LLM load shapes.
 *   - probes/    : browser measurements (DOM churn, frame timing, source-mapped
 *                  CPU profiling, layout overflow).
 *   - scenarios/ : concrete reproductions of real issues, each measuring a
 *                  specific signal with a suggested threshold.
 *
 * See README.md for how to run scenarios and add new ones.
 */
export * from './fixtures/index.js'
export * from './probes/index.js'
export * from './scenarios/index.js'
export { runScenarioOnce, type RunScenarioOptions } from './run-scenario.js'

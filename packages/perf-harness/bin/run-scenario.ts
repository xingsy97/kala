#!/usr/bin/env node
/**
 * CLI: run one (or all) perf-harness scenarios ad hoc and print a report.
 *
 * Usage:
 *   pnpm --filter @agent-kernel/perf-harness scenario                 # list scenarios
 *   pnpm --filter @agent-kernel/perf-harness scenario <name>          # run one
 *   pnpm --filter @agent-kernel/perf-harness scenario --all           # run all
 *   THROTTLE=6 pnpm --filter @agent-kernel/perf-harness scenario <name>
 *
 * Requires a built dashboard bundle. For source-mapped CPU hot spots, build with
 * source maps first:  `pnpm --filter @agent-kernel/dashboard build -- --sourcemap`
 */
import process from 'node:process'

import { isDashboardBuilt } from '../src/fixtures/index.js'
import { SCENARIOS, findScenario, type ScenarioResult } from '../src/scenarios/index.js'
import { runScenarioOnce } from '../src/run-scenario.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const runAll = args.includes('--all')
  const name = args.find((a) => !a.startsWith('--'))
  const throttleEnv = process.env.THROTTLE ? Number(process.env.THROTTLE) : undefined

  if (!runAll && !name) {
    console.log('Available scenarios:\n')
    for (const s of SCENARIOS) console.log(`  ${s.name.padEnd(28)} ${s.reproduces}`)
    console.log('\nRun one:  pnpm --filter @agent-kernel/perf-harness scenario <name>')
    console.log('Run all:  pnpm --filter @agent-kernel/perf-harness scenario --all')
    return
  }

  if (!isDashboardBuilt()) {
    console.error('Dashboard bundle not built. Run: pnpm --filter @agent-kernel/dashboard build')
    process.exit(1)
  }

  const definitions = runAll ? SCENARIOS : [findScenario(name!)].filter((d): d is NonNullable<typeof d> => Boolean(d))
  if (definitions.length === 0) {
    console.error(`Unknown scenario: ${name}. Run with no args to list scenarios.`)
    process.exit(1)
  }

  const results: ScenarioResult[] = []
  for (const def of definitions) {
    process.stdout.write(`\n▶ ${def.name} … `)
    const result = await runScenarioOnce(def, throttleEnv ? { cpuThrottleRate: throttleEnv } : {})
    results.push(result)
    const badge = result.pass === null ? 'INFO' : result.pass ? 'PASS' : 'FAIL'
    console.log(badge)
    console.log(`   reproduces: ${result.reproduces}`)
    console.log(`   metrics:    ${JSON.stringify(result.metrics)}`)
    console.log(`   notes:      ${result.notes}`)
  }

  const failed = results.filter((r) => r.pass === false)
  if (failed.length > 0) {
    console.error(`\n${failed.length} scenario(s) failed their threshold.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * A complete auto-evolve cycle, runnable end-to-end.
 *
 *   pnpm --filter @agent-kernel/substrate exec tsx examples/auto-evolve/run.ts
 *
 * It starts from a deliberately weak harness whose agent creates a config file
 * with invalid JSON (a trailing comma) and never checks its work. A meta-agent
 * reads the failing trajectory, proposes one bounded change to the harness
 * (append the missing "produce valid JSON and validate" instruction), and the
 * evolve loop re-runs, evaluates, and adopts the change because it scores
 * higher. The run prints a before/after report showing the score climb.
 *
 * Everything is deterministic: a scripted LLM models "a better prompt yields a
 * better agent", so the demo is reproducible with no API keys and no network.
 * Swap `scriptedConfigLlm()` for a real `LLMAdapter` and `ruleMetaAgent(...)`
 * for `llmMetaAgent(realModel)` to run the identical loop against a live model.
 *
 * Nothing here reaches below the harness layer — the kernel, host, and executor
 * are untouched (ADR 0015). The evaluator is invoked only by the evolve
 * orchestrator, never by the meta-agent.
 */

import { evolve, formatEvolveReport } from '../../src/index.js'
import { ruleMetaAgent } from '../../src/index.js'
import {
  seedHarness,
  configTask,
  configGoalCheck,
  scriptedConfigLlm,
  KEY_INSTRUCTION,
} from '../../src/fixtures.js'

async function main(): Promise<void> {
  const seed = seedHarness()

  console.log('Task:', configTask.goal)
  console.log('\nSeed harness system prompt:')
  console.log(`  "${seed.systemPrompt}"`)
  console.log('\nRunning auto-evolve (seed → evaluate → propose → re-run → adopt)…\n')

  const result = await evolve({
    seed,
    task: configTask,
    llm: scriptedConfigLlm(),
    // The reproducible, no-API-key meta-agent. It knows the one instruction
    // that could fix a JSON task; a live LLM meta-agent would discover this
    // from the trajectory instead.
    metaAgent: ruleMetaAgent({ missingInstruction: KEY_INSTRUCTION }),
    goalCheck: configGoalCheck,
    onRound: (r) => {
      const tag = r.round === 0 ? 'seed ' : r.adopted ? 'ADOPT' : 'rejct'
      console.log(
        `  round ${r.round} [${tag}] score=${r.score.toFixed(2)} passed=${r.passed}` +
          (r.appliedMutation ? `  ← ${r.appliedMutation}` : ''),
      )
    },
  })

  console.log('\n' + formatEvolveReport(result))

  console.log('\nEvolved harness system prompt:')
  console.log(`  "${result.bestHarness.systemPrompt}"`)

  const verdict = result.improved
    ? `SUCCESS: score rose ${result.seedScore.toFixed(2)} → ${result.bestScore.toFixed(2)}`
    : `no improvement found`
  console.log(`\n${verdict}`)

  // Non-zero exit if the demo failed to improve, so CI/scripts can gate on it.
  process.exit(result.improved ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

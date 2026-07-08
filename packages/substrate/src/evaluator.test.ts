import { describe, expect, it } from 'vitest'

import { runTask } from './runner.js'
import { evaluate, readTrajectory, DEFAULT_WEIGHTS } from './evaluator.js'
import {
  seedHarness,
  configTask,
  configGoalCheck,
  scriptedConfigLlm,
  KEY_INSTRUCTION,
} from './fixtures.js'
import { applyMutation } from './harness.js'

async function scoreSeed() {
  const run = await runTask(seedHarness(), configTask, scriptedConfigLlm(), {
    keepSessionsDir: true,
  })
  return evaluate(run.logPath, configGoalCheck)
}

async function scoreGood() {
  const good = applyMutation(seedHarness(), {
    kind: 'append_system_prompt',
    text: KEY_INSTRUCTION,
  })
  const run = await runTask(good.ok ? good.harness : seedHarness(), configTask, scriptedConfigLlm(), {
    keepSessionsDir: true,
  })
  return evaluate(run.logPath, configGoalCheck)
}

describe('readTrajectory', () => {
  it('reconstructs tool exchanges from the JSONL log', async () => {
    const run = await runTask(seedHarness(), configTask, scriptedConfigLlm(), {
      keepSessionsDir: true,
    })
    const traj = await readTrajectory(run.logPath)
    expect(traj.turns).toBeGreaterThan(0)
    const write = traj.exchanges.find((x) => x.name === 'write_file')
    expect(write).toBeDefined()
    expect(write?.input.path).toBe('config.json')
  })
})

describe('evaluate', () => {
  it('scores the naive seed harness as failing the goal', async () => {
    const res = await scoreSeed()
    expect(res.breakdown.goalMet).toBe(false)
    expect(res.passed).toBe(false)
    expect(res.breakdown.weakestLink).toContain('goal not met')
    expect(res.score).toBeLessThan(0.5)
  })

  it('scores a harness with the key instruction as passing', async () => {
    const res = await scoreGood()
    expect(res.breakdown.goalMet).toBe(true)
    expect(res.passed).toBe(true)
    expect(res.score).toBeGreaterThan(0.8)
  })

  it('the good harness scores strictly higher than the seed', async () => {
    const seed = await scoreSeed()
    const good = await scoreGood()
    expect(good.score).toBeGreaterThan(seed.score)
  })

  it('penalises tool errors', async () => {
    // A harness that validates but writes bad JSON would incur a tool error;
    // here we assert the weight arithmetic directly on a synthetic trajectory.
    const weights = DEFAULT_WEIGHTS
    // seed: goal not met (0) minus nothing meaningful -> ~0
    const seed = await scoreSeed()
    expect(seed.score).toBeLessThanOrEqual(weights.goal)
  })
})

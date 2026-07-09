import { describe, expect, it } from 'vitest'

import { runTask, harnessToConfig } from './runner.js'
import { readTrajectory } from './evaluator.js'
import {
  seedHarness,
  configTask,
  scriptedConfigLlm,
  KEY_INSTRUCTION,
} from './fixtures.js'
import { applyMutation } from './harness.js'

describe('harnessToConfig', () => {
  it('maps the harness onto an AgentConfig', () => {
    const cfg = harnessToConfig(seedHarness())
    expect(cfg.systemPrompt).toContain('coding agent')
    expect(cfg.tools).toHaveLength(2)
    expect(cfg.hardThreshold).toBe(0.92)
  })
})

describe('runTask', () => {
  it('drives a full session to done and writes a readable log', async () => {
    const run = await runTask(seedHarness(), configTask, scriptedConfigLlm())
    expect(run.finalState.status).toBe('done')
    expect(run.sessionId).toMatch(/^evolve-/)
    // The log path is returned but the sessionsDir is cleaned by default;
    // when keepSessionsDir is set we can read it back.
  })

  it('with keepSessionsDir, the log reflects the naive (buggy) behaviour', async () => {
    const run = await runTask(seedHarness(), configTask, scriptedConfigLlm(), {
      keepSessionsDir: true,
    })
    const traj = await readTrajectory(run.logPath)
    // naive agent wrote the file but never validated
    expect(traj.exchanges.some((x) => x.name === 'write_file')).toBe(true)
    expect(traj.exchanges.some((x) => x.name === 'validate_json')).toBe(false)
  })

  it('a harness carrying the key instruction produces the good behaviour', async () => {
    const good = applyMutation(seedHarness(), {
      kind: 'append_system_prompt',
      text: KEY_INSTRUCTION,
    })
    expect(good.ok).toBe(true)
    const run = await runTask(good.ok ? good.harness : seedHarness(), configTask, scriptedConfigLlm(), {
      keepSessionsDir: true,
    })
    const traj = await readTrajectory(run.logPath)
    const validate = traj.exchanges.find((x) => x.name === 'validate_json')
    expect(validate?.ok).toBe(true)
  })

  it('isolates runs — two runs do not share world state', async () => {
    const a = await runTask(seedHarness(), configTask, scriptedConfigLlm(), {
      keepSessionsDir: true,
    })
    const b = await runTask(seedHarness(), configTask, scriptedConfigLlm(), {
      keepSessionsDir: true,
    })
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(a.logPath).not.toBe(b.logPath)
  })
})

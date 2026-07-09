import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildTrajectory, validateSlimeSampleReadiness } from './trajectory-builder.js'
import { writeTokenCaptureArtifact } from './token-capture.js'
import { runCommandVerifier } from './verifier.js'
import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

async function writeCapture(rootDir: string, rolloutId: string, idx: number, weightVersion: string) {
  const { artifact } = await writeTokenCaptureArtifact({
    rootDir,
    capture: {
      rolloutId,
      sessionId: 'se-1',
      callId: `call-${idx}`,
      provider: 'policy-gateway',
      backend: 'sglang',
      model: 'mock',
      tokenizer: { nameOrPath: 'mock', chatTemplate: 'mock' },
      promptIds: [1, 2, 3],
      outputIds: [10 + idx, 20 + idx, 30 + idx],
      responseMask: [1, 1, 1],
      outputLogProbs: [-0.1, -0.2, -0.3],
      usage: { promptTokens: 3, completionTokens: 3 },
      weightVersion,
    },
  })
  return join(rootDir, artifact.uri)
}

function task(): AgentRlTask {
  return {
    schemaVersion: 'agent.rl.task.v1',
    taskId: 'traj-mt',
    source: { kind: 'local-fixture' },
    prompt: 'noop',
    workspace: { kind: 'empty-tempdir' },
    verifier: { kind: 'command', command: ['bash', '-lc', 'echo REWARD_PASS_RATE=1.0; exit 0'], timeoutMs: 5000 },
    governance: { trainingAllowed: true, redactionStatus: 'not_required', retentionClass: 'training_allowed' },
  }
}

describe('buildTrajectory: multi-turn', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ak-traj-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('assembles one turn per token capture in input order', async () => {
    const paths = [
      await writeCapture(dir, 'ro-mt', 0, '1'),
      await writeCapture(dir, 'ro-mt', 1, '1'),
      await writeCapture(dir, 'ro-mt', 2, '2'),
    ]
    const { trajectory } = await buildTrajectory({
      rootDir: dir,
      rolloutId: 'ro-mt',
      taskId: 'traj-mt',
      sessionId: 'se-1',
      tokenCapturePaths: paths,
    })
    expect(trajectory.turns.length).toBe(3)
    expect(trajectory.turns.map((t) => t.turnIndex)).toEqual([0, 1, 2])
    expect(trajectory.turns.map((t) => t.callId)).toEqual(['call-0', 'call-1', 'call-2'])
    expect(trajectory.readiness).toBe('token-captured')
  })

  it('validates slime-sample readiness across multi-turn trajectory with reward', async () => {
    const paths = [
      await writeCapture(dir, 'ro-slime', 0, '1'),
      await writeCapture(dir, 'ro-slime', 1, '2'),
    ]
    const { reward } = await runCommandVerifier({
      rootDir: dir,
      rolloutId: 'ro-slime',
      task: task(),
      cwd: dir,
    })
    const { artifact: trajArt } = await buildTrajectory({
      rootDir: dir,
      rolloutId: 'ro-slime',
      taskId: 'traj-mt',
      sessionId: 'se-1',
      tokenCapturePaths: paths,
      rewardPath: join(dir, `rl-rewards/ro-slime.json`),
    })
    const { validation } = await validateSlimeSampleReadiness({
      rootDir: dir,
      trajectoryPath: join(dir, trajArt.uri),
      rewardPath: join(dir, `rl-rewards/ro-slime.json`),
      requireLogprobs: true,
    })
    expect(validation.status).toBe('ready')
    expect(validation.readiness).toBe('slime-sample-ready')
    expect(validation.metadata?.tokenCaptureCount).toBe(2)
    expect(reward.metadata?.passRate).toBe(1)
  })
})

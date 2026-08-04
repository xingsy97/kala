import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { verifyReward } from './rl-reward.js'

describe('verifyReward', () => {
  let root: string
  let source: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-reward-'))
    source = mkdtempSync(join(tmpdir(), 'ak-reward-src-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(source, { recursive: true, force: true })
  })

  it('emits reward=1.0 for a resolved SWE-bench trial', async () => {
    const trialPath = join(source, 'trial.json')
    writeFileSync(
      trialPath,
      JSON.stringify({
        trialId: 'run:sympy__sympy-20590',
        experimentId: 'exp-1',
        instanceId: 'sympy__sympy-20590',
        sessionId: 'session-1',
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      }),
      'utf8',
    )
    const { reward, artifact } = await verifyReward({ rootDir: root, trialPath })
    expect(reward.reward).toBe(1)
    expect(reward.resolved).toBe(true)
    expect(reward.shapedLabels).toEqual(['resolved'])
    expect(reward.reasonCodes).toContain('resolved')
    expect(reward.taskId).toBe('sympy__sympy-20590')
    expect(reward.sessionId).toBe('session-1')
    expect(artifact.uri).toBe('rl-rewards/sympy__sympy-20590.json')
    const written = JSON.parse(await readFile(join(root, artifact.uri), 'utf8'))
    expect(written.reward).toBe(1)
    expect(written.shapedLabels).toEqual(['resolved'])
  })

  it('emits reward=0.0 and a shaped label for a failed SWE-bench trial', async () => {
    const trialPath = join(source, 'trial.json')
    writeFileSync(
      trialPath,
      JSON.stringify({
        trialId: 'run:foo-1',
        experimentId: 'exp-1',
        instanceId: 'foo-1',
        status: 'completed',
        resolved: false,
        failureLabel: 'empty_patch',
        artifacts: [],
        metrics: {},
      }),
      'utf8',
    )
    const { reward } = await verifyReward({ rootDir: root, trialPath })
    expect(reward.reward).toBe(0)
    expect(reward.resolved).toBe(false)
    expect(reward.shapedLabels).toEqual(['empty_patch'])
    expect(reward.reasonCodes).toContain('failure:empty_patch')
  })

  it('reads an eval score summary and preserves failing scorer labels', async () => {
    const scorePath = join(source, 'score.json')
    writeFileSync(
      scorePath,
      JSON.stringify({
        instanceId: 'inst-42',
        resolved: false,
        failureLabel: 'test_failed',
        score: 0,
        results: [
          { scorer: 'test-scorer', passed: false, label: 'test_failed', score: 0, metrics: {}, artifactRefs: [] },
          { scorer: 'other', passed: false, label: 'agent_error', score: 0, metrics: {}, artifactRefs: [] },
        ],
      }),
      'utf8',
    )
    const { reward } = await verifyReward({ rootDir: root, scorePath, sessionId: 'session-9' })
    expect(reward.reward).toBe(0)
    expect(reward.sourceKind).toBe('score_result')
    expect(reward.sessionId).toBe('session-9')
    expect(new Set(reward.shapedLabels)).toEqual(new Set(['test_failed', 'agent_error']))
  })

  it('rejects when neither trial nor score is provided', async () => {
    await expect(verifyReward({ rootDir: root })).rejects.toThrow(/trial or --score/)
  })

  it('rejects when both trial and score are provided', async () => {
    const trialPath = join(source, 'trial.json')
    const scorePath = join(source, 'score.json')
    writeFileSync(trialPath, '{}', 'utf8')
    writeFileSync(scorePath, '{}', 'utf8')
    await expect(verifyReward({ rootDir: root, trialPath, scorePath })).rejects.toThrow(/either --trial or --score/)
  })

  it('sanitizes task ids with unsafe characters for the artifact filename', async () => {
    const trialPath = join(source, 'trial.json')
    writeFileSync(
      trialPath,
      JSON.stringify({
        trialId: 't',
        experimentId: 'exp',
        instanceId: 'foo bar/baz',
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      }),
      'utf8',
    )
    const { artifact, reward } = await verifyReward({ rootDir: root, trialPath })
    expect(reward.taskId).toBe('foo bar/baz')
    expect(artifact.uri).toBe('rl-rewards/foo_bar_baz.json')
  })
})

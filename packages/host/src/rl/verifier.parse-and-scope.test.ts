import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCommandVerifier } from './verifier.js'
import { snapshotWriteScope } from './write-scope.js'
import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

function makeTask(overrides: Partial<AgentRlTask['verifier']> = {}): AgentRlTask {
  return {
    schemaVersion: 'agent.rl.task.v1',
    taskId: 'parse-scope-test',
    source: { kind: 'local-fixture' },
    prompt: 'noop',
    workspace: { kind: 'empty-tempdir' },
    verifier: {
      kind: 'command',
      command: ['bash', '-lc', 'echo REWARD_PASS_RATE=0.75; exit 0'],
      timeoutMs: 5000,
      ...overrides,
    },
    governance: { trainingAllowed: true, redactionStatus: 'not_required', retentionClass: 'training_allowed' },
  }
}

describe('runCommandVerifier: parse + scope', () => {
  let dir: string
  let cwd: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ak-verify-'))
    cwd = join(dir, 'ws')
    await mkdir(cwd, { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses REWARD_PASS_RATE into metadata.passRate', async () => {
    const { reward } = await runCommandVerifier({
      rootDir: dir,
      rolloutId: 'ro-parse',
      task: makeTask({ rewardParsePattern: 'REWARD_PASS_RATE=([0-9.]+)' }),
      cwd,
    })
    expect(reward.metadata?.passRate).toBe(0.75)
    expect(reward.reward).toBe(1)
  })

  it('uses default pattern when none provided', async () => {
    const { reward } = await runCommandVerifier({
      rootDir: dir,
      rolloutId: 'ro-default',
      task: makeTask(),
      cwd,
    })
    expect(reward.metadata?.passRate).toBe(0.75)
  })

  it('clamps reward to 0 and records violations when writeScope is breached', async () => {
    await mkdir(join(cwd, 'tests'), { recursive: true })
    await writeFile(join(cwd, 'tests', 'test_a.py'), 'orig\n')
    const task = makeTask()
    task.verifier.writeScope = { allowGlobs: ['src/**'], denyGlobs: ['tests/**'] }
    const snapshot = await snapshotWriteScope(cwd, task)
    expect(snapshot).not.toBeNull()
    await writeFile(join(cwd, 'tests', 'test_a.py'), 'evil\n')
    const originalMtime = new Date(snapshot!.files[0]!.mtimeMs)
    await utimes(join(cwd, 'tests', 'test_a.py'), originalMtime, originalMtime)
    const { reward } = await runCommandVerifier({
      rootDir: dir,
      rolloutId: 'ro-scope',
      task,
      cwd,
      writeScopeSnapshot: snapshot,
    })
    expect(reward.reward).toBe(0)
    expect(reward.label).toBe('unresolved')
    const violations = reward.metadata?.writeScopeViolations as string[] | undefined
    expect(violations).toBeDefined()
    expect(violations!.some((v) => v.includes('tests/test_a.py'))).toBe(true)
    const sidecar = await readFile(join(dir, 'rl-verifier', 'ro-scope', 'mtimes.json'), 'utf8')
    expect(sidecar).toContain('tests/test_a.py')
  })

  it('passes through cleanly when no writeScope snapshot is provided', async () => {
    const { reward } = await runCommandVerifier({
      rootDir: dir,
      rolloutId: 'ro-noscope',
      task: makeTask(),
      cwd,
    })
    expect(reward.reward).toBe(1)
    expect(reward.metadata?.writeScopeViolations).toBeUndefined()
  })
})

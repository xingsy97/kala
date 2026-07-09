import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { exportRollouts, exportRolloutsSlime, exportRolloutsVerl } from './rollout-export.js'
import { sweBenchRunLayout } from '../swebench/swebench.js'
import { terminalBenchRunLayout } from '../terminal-bench/terminal-bench.js'

async function seedSweBenchTrials(rootDir: string, runId: string): Promise<void> {
  const layout = sweBenchRunLayout(rootDir, runId)
  await mkdir(layout.trialsDir, { recursive: true })
  await writeFile(
    join(layout.trialsDir, 'inst-pass.json'),
    JSON.stringify({
      trialId: `${runId}:inst-pass`,
      experimentId: runId,
      instanceId: 'inst-pass',
      sessionId: 'sess-pass',
      status: 'completed',
      resolved: true,
      artifacts: [],
      metrics: {},
    }),
    'utf8',
  )
  await writeFile(
    join(layout.trialsDir, 'inst-fail.json'),
    JSON.stringify({
      trialId: `${runId}:inst-fail`,
      experimentId: runId,
      instanceId: 'inst-fail',
      status: 'failed',
      resolved: false,
      failureLabel: 'test_failed',
      artifacts: [],
      metrics: {},
    }),
    'utf8',
  )
  await writeFile(
    join(layout.trialsDir, 'inst-timeout.json'),
    JSON.stringify({
      trialId: `${runId}:inst-timeout`,
      experimentId: runId,
      instanceId: 'inst-timeout',
      status: 'timed_out',
      resolved: false,
      artifacts: [],
      metrics: {},
    }),
    'utf8',
  )
}

async function seedTerminalBenchTrial(rootDir: string, runId: string): Promise<void> {
  const layout = terminalBenchRunLayout(rootDir, runId)
  await mkdir(layout.trialsDir, { recursive: true })
  await writeFile(
    join(layout.trialsDir, 'task-ok.json'),
    JSON.stringify({
      taskId: 'task-ok',
      status: 'resolved',
      parserOutput: { parser: 'exit-code', allPassed: true },
      agentExitCode: 0,
      agentTimedOut: false,
      testExitCode: 0,
      testTimedOut: false,
      durationMs: 12,
      agentStdout: '',
      agentStderr: '',
      testStdout: '',
      testStderr: '',
    }),
    'utf8',
  )
}

describe('rollout export', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ak-rollout-export-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exports one verl JSONL row per trial with reward=1 for resolved and 0 otherwise', async () => {
    await seedSweBenchTrials(dir, 'r1')
    await seedTerminalBenchTrial(dir, 'r1')
    const content = await exportRolloutsVerl({ rootDir: dir, runId: 'r1' })
    const rows = content.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(rows).toHaveLength(4)
    const byTask = new Map(rows.map((r) => [r.taskId as string, r]))
    expect(byTask.get('inst-pass')).toMatchObject({
      schemaVersion: 1,
      frameworkTarget: 'verl',
      taskId: 'inst-pass',
      rolloutId: 'rollout_r1__inst-pass',
      reward: 1,
    })
    expect((byTask.get('inst-pass')!.metadata as Record<string, unknown>).sessionId).toBe('sess-pass')
    expect(byTask.get('inst-fail')!.reward).toBe(0)
    expect(byTask.get('inst-timeout')!.reward).toBe(0)
    expect(byTask.get('task-ok')).toMatchObject({ reward: 1, taskId: 'task-ok' })
  })

  it('exports slime rows with entrypoint=custom_rollout_manifest', async () => {
    await seedSweBenchTrials(dir, 'r2')
    const content = await exportRolloutsSlime({ rootDir: dir, runId: 'r2' })
    const rows = content.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.frameworkTarget).toBe('slime')
      expect(row.entrypoint).toBe('custom_rollout_manifest')
      expect(row.schemaVersion).toBe(1)
    }
  })

  it('filters by includeStatuses', async () => {
    await seedSweBenchTrials(dir, 'r3')
    const { content, rolloutCount } = await exportRollouts({
      rootDir: dir,
      runId: 'r3',
      target: 'verl',
      includeStatuses: ['completed'],
    })
    expect(rolloutCount).toBe(1)
    const row = JSON.parse(content.trim()) as Record<string, unknown>
    expect(row.taskId).toBe('inst-pass')
    expect(row.reward).toBe(1)
  })

  it('returns empty string when no trials exist', async () => {
    expect(await exportRolloutsVerl({ rootDir: dir, runId: 'missing' })).toBe('')
    expect(await exportRolloutsSlime({ rootDir: dir, runId: 'missing' })).toBe('')
  })
})

import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getAdapter, listAdapters } from '../core/adapter-registry.js'
import {
  importSweMarathonResults,
  resolveSweMarathonTasks,
  runSweMarathonRun,
} from './swe-marathon.js'

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HAS_DOCKER = dockerAvailable()

describe('SWE-Marathon benchmark runner', () => {
  it('registers the swe-marathon adapter', () => {
    expect(listAdapters()).toContain('swe-marathon')
    expect(getAdapter('swe-marathon').kind).toBe('swe-marathon')
  })

  describe('harbor task resolution', () => {
    let tasksDir: string
    let root: string

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'ak-swemara-'))
      tasksDir = join(root, 'tasks')
      // Two harbor-format task dirs; one complete, one missing tests/test.sh.
      const complete = join(tasksDir, 'demo-complete')
      await mkdir(join(complete, 'environment'), { recursive: true })
      await mkdir(join(complete, 'tests'), { recursive: true })
      await writeFile(join(complete, 'task.toml'), [
        'version = "1.0"',
        '[metadata]',
        'difficulty = "easy"',
        'category = "demo"',
        '[verifier]',
        'type = "shell"',
        'timeout_sec = 60.0',
        '[environment]',
        'network_mode = "none"',
        '',
      ].join('\n'), 'utf8')
      await writeFile(join(complete, 'instruction.md'), '# demo\nDo the thing.\n', 'utf8')
      await writeFile(join(complete, 'environment', 'Dockerfile'), 'FROM ubuntu:24.04\nRUN mkdir -p /app\n', 'utf8')
      await writeFile(join(complete, 'tests', 'test.sh'), '#!/usr/bin/env bash\nmkdir -p /logs/verifier\necho 1 > /logs/verifier/reward.txt\n', 'utf8')
      await chmod(join(complete, 'tests', 'test.sh'), 0o755)

      const partial = join(tasksDir, 'demo-partial')
      await mkdir(join(partial, 'environment'), { recursive: true })
      await writeFile(join(partial, 'task.toml'), 'version = "1.0"\n', 'utf8')
      await writeFile(join(partial, 'instruction.md'), 'partial\n', 'utf8')
      await writeFile(join(partial, 'environment', 'Dockerfile'), 'FROM ubuntu:24.04\n', 'utf8')
    })

    afterAll(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('resolves only complete harbor task directories and reads task.toml', async () => {
      const tasks = await resolveSweMarathonTasks({ tasksDir })
      expect(tasks.map((t) => t.taskId)).toEqual(['demo-complete'])
      expect(tasks[0]?.difficulty).toBe('easy')
      expect(tasks[0]?.category).toBe('demo')
      expect(tasks[0]?.verifierTimeoutSec).toBe(60)
      expect(tasks[0]?.networkMode).toBe('none')
    })

    it.runIf(HAS_DOCKER)('runs a real docker build + verifier and scores reward==1 (isolated, --rm, prefixed image)', async () => {
      const runId = `test-${Date.now()}`
      const { summary } = await runSweMarathonRun({
        rootDir: root,
        runId,
        tasksDir,
        taskIds: ['demo-complete'],
        timeoutMs: 180_000,
      })
      expect(summary.total).toBe(1)
      expect(summary.resolved).toBe(1)
      expect(summary.accuracy).toBe(1)
      const reimported = await importSweMarathonResults({ rootDir: root, runId })
      expect(reimported.resolved).toBe(1)
      // The prefixed image must have been cleaned up.
      const images = execFileSync('docker', ['images', '--format', '{{.Repository}}'], { encoding: 'utf8' })
      expect(images).not.toContain(`ak-eval-swemara-${runId}`.slice(0, 40))
    }, 200_000)
  })

  describe('real SWE-Marathon reference dataset (if present)', () => {
    const referenceTasks = join(
      process.cwd(),
      '..', '..',
      'experiments/evals/2026-07-agent-benchmark-comparison/references/swe-marathon/tasks',
    )
    it.runIf(existsSync(referenceTasks))('resolves the vendored harbor tasks', async () => {
      const tasks = await resolveSweMarathonTasks({ tasksDir: referenceTasks })
      expect(tasks.length).toBeGreaterThan(0)
      // Every resolved task must have the four required harbor files.
      for (const task of tasks) {
        expect(existsSync(join(task.taskDir, 'task.toml'))).toBe(true)
        expect(existsSync(join(task.taskDir, 'tests', 'test.sh'))).toBe(true)
      }
    })
  })
})

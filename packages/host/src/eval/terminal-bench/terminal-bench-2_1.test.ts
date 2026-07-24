import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveTerminalBench21TaskTree, runTerminalBench21DockerTrial } from './terminal-bench-2_1.js'
import { runTerminalBenchRun } from './terminal-bench.js'
import { execFileSync } from 'node:child_process'

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const HAS_DOCKER = dockerAvailable()

describe('Terminal-Bench 2.1 task-tree resolver', () => {
  let root: string
  let datasetDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ak-tb21-'))
    datasetDir = join(root, 'dataset')
    // A 2.1-style task dir: task.yaml (block instruction) + tests/run-tests.sh.
    const pass = join(datasetDir, 'hello-pass')
    await mkdir(join(pass, 'tests'), { recursive: true })
    await writeFile(join(pass, 'task.yaml'), [
      'instruction: |',
      '  Print hello to stdout.',
      '  Second line of the instruction.',
      'max_test_timeout_sec: 30',
      '', ].join('\n'), 'utf8')
    await writeFile(join(pass, 'tests', 'run-tests.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    await chmod(join(pass, 'tests', 'run-tests.sh'), 0o755)
    // A task whose tests fail (exit 1) → unresolved.
    const fail = join(datasetDir, 'hello-fail')
    await mkdir(fail, { recursive: true })
    await writeFile(join(fail, 'task.yaml'), 'instruction: "single line instruction"\n', 'utf8')
    await writeFile(join(fail, 'run-tests.sh'), '#!/usr/bin/env bash\nexit 1\n', 'utf8')
    await chmod(join(fail, 'run-tests.sh'), 0o755)
    // A directory missing task.yaml → skipped.
    await mkdir(join(datasetDir, 'not-a-task'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('ingests official 2.1 task directories into normalized tasks', async () => {
    const tasks = await resolveTerminalBench21TaskTree({ datasetDir })
    expect(tasks.map((t) => t.taskId)).toEqual(['hello-fail', 'hello-pass'])
    const pass = tasks.find((t) => t.taskId === 'hello-pass')!
    expect(pass.instruction).toBe('Print hello to stdout.\nSecond line of the instruction.')
    expect(pass.timeoutSec).toBe(30)
    const fail = tasks.find((t) => t.taskId === 'hello-fail')!
    expect(fail.instruction).toBe('single line instruction')
  })

  it('runs resolved 2.1 tasks through the generic terminal-bench runner', async () => {
    const tasks = await resolveTerminalBench21TaskTree({ datasetDir })
    const inline = tasks.map((t) => JSON.stringify(t)).join('\n')
    const runId = 'tb21-run'
    const { summary } = await runTerminalBenchRun({
      rootDir: root,
      runId,
      agentCommand: 'true',
      inlineTasksContent: inline,
      dataset: 'terminal-bench/2.1-local',
    })
    expect(summary.total).toBe(2)
    expect(summary.resolved).toBe(1)
    expect(summary.unresolved).toBe(1)
  })

  it.runIf(HAS_DOCKER)('runs a real docker build + verifier trial and discriminates pass vs fail (isolated, --rm, prefixed image)', async () => {
    // A minimal but real harbor-style task: Dockerfile + run-tests.sh + pytest.
    const taskDir = join(root, 'docker-task')
    await mkdir(join(taskDir, 'tests'), { recursive: true })
    await writeFile(join(taskDir, 'task.yaml'), 'instruction: |\n  Write ok to /app/out.txt\nparser_name: pytest\n', 'utf8')
    await writeFile(join(taskDir, 'Dockerfile'), 'FROM python:3.11-slim\nRUN pip install pytest==8.4.1\nWORKDIR /app\n', 'utf8')
    await writeFile(join(taskDir, 'solution.sh'), '#!/usr/bin/env bash\necho ok > /app/out.txt\n', 'utf8')
    await writeFile(join(taskDir, 'run-tests.sh'), '#!/usr/bin/env bash\ncd "$TEST_DIR" && python -m pytest test_outputs.py -rA\n', 'utf8')
    await writeFile(join(taskDir, 'tests', 'test_outputs.py'), 'def test_out():\n    assert open("/app/out.txt").read().strip() == "ok"\n', 'utf8')

    const runId = `tb21-docker-${Date.now()}`
    const resolved = await runTerminalBench21DockerTrial({ taskDir, taskId: 'demo', runId, agent: 'solution', timeoutMs: 300_000 })
    expect(resolved.buildExitCode).toBe(0)
    expect(resolved.status).toBe('resolved')

    const unresolved = await runTerminalBench21DockerTrial({ taskDir, taskId: 'demo-noagent', runId, agent: 'none', timeoutMs: 300_000 })
    expect(unresolved.status).toBe('unresolved')

    const images = execFileSync('docker', ['images', '--format', '{{.Repository}}'], { encoding: 'utf8' })
    expect(images).not.toContain(`ak-eval-tb21-${runId}`.slice(0, 40))
  }, 320_000)
})

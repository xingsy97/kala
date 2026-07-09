import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  importTerminalBenchResults,
  resolveTerminalBenchTasks,
  runTerminalBenchRun,
  runTerminalBenchTrial,
  terminalBenchRunLayout,
} from '../terminal-bench/terminal-bench.js'

describe('Terminal-Bench adapter', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-tb-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('marks a trial resolved only when tests pass', async () => {
    const result = await runTerminalBenchTrial({
      task: {
        taskId: 'passing',
        instruction: 'Create marker.txt',
        testScript: 'test -f marker.txt',
        parser: 'exit-code',
      },
      agentCommand: 'touch marker.txt',
    })
    expect(result.status).toBe('resolved')
    expect(result.parserOutput.allPassed).toBe(true)
    expect(result.testExitCode).toBe(0)
  })

  it('marks a trial unresolved when the agent succeeds but tests fail', async () => {
    const result = await runTerminalBenchTrial({
      task: {
        taskId: 'wrong-file',
        instruction: 'Create marker.txt',
        testScript: 'test -f marker.txt',
        parser: 'exit-code',
      },
      // Agent exits 0 but does the wrong thing: creates a different file.
      agentCommand: 'touch other.txt',
    })
    expect(result.status).toBe('unresolved')
    expect(result.status).not.toBe('resolved')
    expect(result.parserOutput.allPassed).toBe(false)
    expect(result.testExitCode).not.toBe(0)
  })

  it('marks a trial errored when the agent itself fails', async () => {
    const result = await runTerminalBenchTrial({
      task: {
        taskId: 'agent-crash',
        instruction: 'Do something',
        testScript: 'true',
        parser: 'exit-code',
      },
      agentCommand: 'exit 3',
    })
    expect(result.status).toBe('errored')
    expect(result.agentExitCode).toBe(3)
    expect(result.testExitCode).toBeNull()
  })

  it('resolveTerminalBenchTasks parses JSONL and filters by taskIds/limit', async () => {
    const jsonl = [
      { taskId: 't1', instruction: 'i1', testScript: 'true' },
      { taskId: 't2', instruction: 'i2', testScript: 'true' },
      { taskId: 't3', instruction: 'i3', testScript: 'true' },
    ].map((row) => JSON.stringify(row)).join('\n')
    const filtered = await resolveTerminalBenchTasks({ inlineContent: jsonl, taskIds: ['t1', 't3'] })
    expect(filtered.map((t) => t.taskId)).toEqual(['t1', 't3'])
    const limited = await resolveTerminalBenchTasks({ inlineContent: jsonl, limit: 2 })
    expect(limited.map((t) => t.taskId)).toEqual(['t1', 't2'])
  })

  it('runTerminalBenchRun aggregates counts and writes progress + summary', async () => {
    const tasksPath = join(dir, 'tasks.jsonl')
    await writeFile(
      tasksPath,
      [
        { taskId: 'pass', instruction: 'x', testScript: 'test -f pass.txt' },
        { taskId: 'fail', instruction: 'x', testScript: 'test -f neverExists' },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8',
    )
    const artifactsRoot = join(dir, 'artifacts')
    const { layout, summary } = await runTerminalBenchRun({
      rootDir: artifactsRoot,
      runId: 'run-1',
      agentCommand: 'if [ "$AGENT_KERNEL_TB_TASK_ID" = "pass" ]; then touch pass.txt; fi',
      tasksJsonl: tasksPath,
    })
    expect(summary.total).toBe(2)
    expect(summary.resolved).toBe(1)
    expect(summary.unresolved).toBe(1)
    expect(summary.errored).toBe(0)
    expect(summary.accuracy).toBeCloseTo(0.5)
    const progress = JSON.parse(await readFile(layout.progressPath, 'utf8')) as { status: string; completed: number }
    expect(progress.status).toBe('completed')
    expect(progress.completed).toBe(2)
    const imported = await importTerminalBenchResults({ rootDir: artifactsRoot, runId: 'run-1' })
    expect(imported.resolved).toBe(1)
    expect(imported.unresolved).toBe(1)
    // Registry entry with kind=terminal-bench must be present.
    const registry = JSON.parse(await readFile(join(artifactsRoot, 'registry', 'run-index.json'), 'utf8')) as {
      entries: Array<{ runId: string; kind?: string }>
    }
    const entry = registry.entries.find((e) => e.runId === 'run-1')
    expect(entry?.kind).toBe('terminal-bench')
  })

  it('layout returns derived paths under rootDir/runId', () => {
    const layout = terminalBenchRunLayout('/tmp/root', 'my-run')
    expect(layout.tasksJsonl).toBe('/tmp/root/my-run/tasks.jsonl')
    expect(layout.resultsJsonl).toBe('/tmp/root/my-run/results.jsonl')
    expect(layout.progressPath).toBe('/tmp/root/my-run/progress.json')
    expect(layout.summaryPath).toBe('/tmp/root/my-run/summary.json')
  })
})

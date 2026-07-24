import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getAdapter, listAdapters } from '../core/adapter-registry.js'
import {
  importProgramBenchResults,
  programBenchRunLayout,
  resolveProgramBenchTasks,
  runProgramBenchRun,
  runProgramBenchTrial,
} from './programbench.js'

describe('ProgramBench benchmark runner', () => {
  let root: string
  let workspaceResolved: string
  let workspaceUnresolved: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ak-pb-test-'))
    // A workspace that satisfies the contract and compiles to ./executable.
    workspaceResolved = join(root, 'ws-ok')
    await mkdir(workspaceResolved, { recursive: true })
    await writeFile(join(workspaceResolved, 'main.c'), 'int main(){return 0;}\n', 'utf8')
    await writeFile(join(workspaceResolved, 'compile.sh'), '#!/usr/bin/env bash\nset -e\ncc main.c -o executable\n', 'utf8')
    await chmod(join(workspaceResolved, 'compile.sh'), 0o755)
    // A workspace missing compile.sh — unresolved.
    workspaceUnresolved = join(root, 'ws-bad')
    await mkdir(workspaceUnresolved, { recursive: true })
    await writeFile(join(workspaceUnresolved, 'notes.txt'), 'no build here\n', 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registers the program-bench adapter', () => {
    expect(listAdapters()).toContain('program-bench')
    expect(getAdapter('program-bench').kind).toBe('program-bench')
  })

  it('resolves task rows from JSONL with camelCase and snake_case keys', async () => {
    const jsonl = [
      JSON.stringify({ instanceId: 'a', workspaceRoot: workspaceResolved, language: 'c' }),
      JSON.stringify({ instance_id: 'b', workspace_root: workspaceUnresolved }),
    ].join('\n')
    const tasks = await resolveProgramBenchTasks({ inlineContent: jsonl })
    expect(tasks.map((t) => t.instanceId)).toEqual(['a', 'b'])
    expect(tasks[0]?.language).toBe('c')
  })

  it('refuses to compile an untrusted workspace on the host by default (security)', async () => {
    const blocked = await runProgramBenchTrial({ task: { instanceId: 'ok', workspaceRoot: workspaceResolved } })
    expect(blocked.status).toBe('errored')
    expect(blocked.reasonCodes).toContain('host_compile_blocked')
    // A non-trivial agent command is also refused on the host by default.
    const blockedAgent = await runProgramBenchTrial({
      task: { instanceId: 'ok', workspaceRoot: workspaceResolved },
      agentCommand: 'echo pwned',
    })
    expect(blockedAgent.status).toBe('errored')
    expect(blockedAgent.reasonCodes).toContain('host_execution_blocked')
  })

  it('marks a compiling workspace resolved and a bare workspace unresolved (opt-in host compile)', async () => {
    const ok = await runProgramBenchTrial({ task: { instanceId: 'ok', workspaceRoot: workspaceResolved }, allowHostExecution: true })
    expect(ok.status).toBe('resolved')
    expect(ok.contractSatisfied).toBe(true)
    expect(ok.compileStatus).toBe('passed')

    const bad = await runProgramBenchTrial({ task: { instanceId: 'bad', workspaceRoot: workspaceUnresolved }, allowHostExecution: true })
    expect(bad.status).toBe('unresolved')
    expect(bad.reasonCodes).toContain('executable_missing')
  })

  it('runs an end-to-end batch and writes summary + registry entry', async () => {
    const jsonl = [
      JSON.stringify({ instanceId: 'ok', workspaceRoot: workspaceResolved }),
      JSON.stringify({ instanceId: 'bad', workspaceRoot: workspaceUnresolved }),
    ].join('\n')
    const runId = 'pb-run-1'
    const { summary } = await runProgramBenchRun({ rootDir: root, runId, inlineTasksContent: jsonl, allowHostExecution: true })
    expect(summary.total).toBe(2)
    expect(summary.resolved).toBe(1)
    expect(summary.unresolved).toBe(1)
    expect(summary.accuracy).toBeCloseTo(0.5, 5)

    const layout = programBenchRunLayout(root, runId)
    expect(layout.summaryPath.endsWith('summary.json')).toBe(true)
    const reimported = await importProgramBenchResults({ rootDir: root, runId })
    expect(reimported.resolved).toBe(1)
  })
})

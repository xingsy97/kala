import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EvalTrial } from '@agent-kernel/shared/enhancement'

import { classifyFailure, mineBadCases } from './badcase-mining.js'
import { sweBenchRunLayout } from './swebench.js'
import { terminalBenchRunLayout, type TerminalBenchTrialResult } from './terminal-bench.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ak-badcase-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function baseSweBenchTrial(id: string, overrides: Partial<EvalTrial>): EvalTrial {
  return {
    trialId: `run:${id}`,
    experimentId: 'run',
    instanceId: id,
    status: 'failed',
    resolved: false,
    artifacts: [],
    metrics: {},
    ...overrides,
  }
}

async function writeSweTrial(runId: string, trial: EvalTrial): Promise<void> {
  const layout = sweBenchRunLayout(root, runId)
  await mkdir(layout.trialsDir, { recursive: true })
  await writeFile(join(layout.trialsDir, `${trial.instanceId}.json`), JSON.stringify(trial), 'utf8')
}

async function writeStdout(runId: string, id: string, text: string): Promise<void> {
  const layout = sweBenchRunLayout(root, runId)
  await mkdir(join(layout.artifactsDir, id), { recursive: true })
  await writeFile(join(layout.artifactsDir, id, 'agent.stdout.log'), text, 'utf8')
}

describe('classifyFailure — SWE-bench trials', () => {
  it('maps patch_apply_failed to patch-apply-failure', () => {
    expect(classifyFailure(baseSweBenchTrial('a', { failureLabel: 'patch_apply_failed' }))).toBe('patch-apply-failure')
  })
  it('maps empty_patch to patch-apply-failure', () => {
    expect(classifyFailure(baseSweBenchTrial('a', { failureLabel: 'empty_patch' }))).toBe('patch-apply-failure')
  })
  it('maps agent_timeout to test-timeout', () => {
    expect(classifyFailure(baseSweBenchTrial('a', { failureLabel: 'agent_timeout' }))).toBe('test-timeout')
  })
  it('maps agent_error to agent-error', () => {
    expect(classifyFailure(baseSweBenchTrial('a', { failureLabel: 'agent_error' }))).toBe('agent-error')
  })
  it('maps infrastructure_error to infra-error', () => {
    expect(classifyFailure(baseSweBenchTrial('a', { failureLabel: 'infrastructure_error' }))).toBe('infra-error')
  })
  it('maps harness_error to infra-error', () => {
    expect(classifyFailure(baseSweBenchTrial('a', { failureLabel: 'harness_error' }))).toBe('infra-error')
  })
  it('maps test_failed to verifier-failure', () => {
    expect(classifyFailure(baseSweBenchTrial('a', { failureLabel: 'test_failed' }))).toBe('verifier-failure')
  })
  it('falls back to unresolved-other with no label', () => {
    expect(classifyFailure(baseSweBenchTrial('a', { status: 'completed' }))).toBe('unresolved-other')
  })
})

describe('classifyFailure — Terminal-Bench trials', () => {
  const base: TerminalBenchTrialResult = {
    taskId: 't1',
    status: 'unresolved',
    parserOutput: { parser: 'exit-code', allPassed: false },
    agentExitCode: 0,
    agentTimedOut: false,
    testExitCode: 1,
    testTimedOut: false,
    durationMs: 10,
    agentStdout: '',
    agentStderr: '',
    testStdout: '',
    testStderr: '',
  }
  it('detects agent timeout as test-timeout', () => {
    expect(classifyFailure({ ...base, agentTimedOut: true, status: 'errored' })).toBe('test-timeout')
  })
  it('detects agent error via errorMessage', () => {
    expect(classifyFailure({ ...base, status: 'errored', errorMessage: 'agent exit 1' })).toBe('agent-error')
  })
  it('detects verifier failure when parser reports not all passed', () => {
    expect(classifyFailure(base)).toBe('verifier-failure')
  })
})

describe('mineBadCases', () => {
  it('scans SWE-bench trials, groups by category, skips resolved', async () => {
    await writeSweTrial('r1', baseSweBenchTrial('inst-a', { failureLabel: 'patch_apply_failed' }))
    await writeSweTrial('r1', baseSweBenchTrial('inst-b', { failureLabel: 'agent_timeout' }))
    await writeSweTrial('r1', baseSweBenchTrial('inst-ok', { status: 'completed', resolved: true, failureLabel: 'resolved' as never }))
    await writeStdout('r1', 'inst-a', 'first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh')

    const result = await mineBadCases({ rootDir: root, runId: 'r1' })
    expect(result.cases.map((c) => c.instanceId).sort()).toEqual(['inst-a', 'inst-b'])
    expect(result.counts['patch-apply-failure']).toBe(1)
    expect(result.counts['test-timeout']).toBe(1)
    expect(result.counts['verifier-failure']).toBe(0)
    const a = result.cases.find((c) => c.instanceId === 'inst-a')!
    expect(a.traceHead).toEqual(['first', 'second', 'third', 'fourth', 'fifth'])
    expect(a.traceTail.length).toBe(5)
  })

  it('scans terminal-bench trials', async () => {
    const layout = terminalBenchRunLayout(root, 'r2')
    await mkdir(layout.trialsDir, { recursive: true })
    const trial: TerminalBenchTrialResult = {
      taskId: 'task-1',
      status: 'unresolved',
      parserOutput: { parser: 'exit-code', allPassed: false, details: 'exit 1' },
      agentExitCode: 0,
      agentTimedOut: false,
      testExitCode: 1,
      testTimedOut: false,
      durationMs: 10,
      agentStdout: 'agent-line-1\nagent-line-2',
      agentStderr: 'ERROR: boom',
      testStdout: '',
      testStderr: '',
    }
    await writeFile(join(layout.trialsDir, 'task-1.json'), JSON.stringify(trial), 'utf8')
    const result = await mineBadCases({ rootDir: root, runId: 'r2' })
    expect(result.cases).toHaveLength(1)
    expect(result.cases[0]!.failureCategory).toBe('verifier-failure')
    expect(result.cases[0]!.toolCallErrors).toEqual(['ERROR: boom'])
    expect(result.cases[0]!.verifierReason).toBe('exit 1')
  })

  it('returns empty cases and zero counts for an empty run', async () => {
    const result = await mineBadCases({ rootDir: root, runId: 'nope' })
    expect(result.cases).toEqual([])
    expect(result.counts['patch-apply-failure']).toBe(0)
  })
})

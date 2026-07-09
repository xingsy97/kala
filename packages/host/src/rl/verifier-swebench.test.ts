import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runSwebenchVerifier, type CommandRunner, type ReportReader } from './verifier-swebench.js'
import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

const INSTANCE_ID = 'django__django-12345'
const AGENT_PATCH = 'diff --git a/foo.py b/foo.py\n--- a/foo.py\n+++ b/foo.py\n@@\n-old\n+new\n'

function makeTask(): AgentRlTask {
  return {
    schemaVersion: 'agent.rl.task.v1',
    taskId: `swebench-${INSTANCE_ID}`,
    source: { kind: 'swebench' },
    prompt: 'fix the bug',
    workspace: { kind: 'git', repoUrl: 'https://github.com/django/django.git', baseCommit: 'abc' },
    verifier: { kind: 'swebench', timeoutMs: 300_000 } as unknown as AgentRlTask['verifier'],
    governance: { trainingAllowed: true, redactionStatus: 'not_required', retentionClass: 'training_allowed' },
    metadata: { instanceId: INSTANCE_ID },
  }
}

function runnerScript(script: Record<string, () => { exitCode: number | null; signal?: string | null; stdout: string; stderr: string; timedOut?: boolean }>): CommandRunner {
  return async (command, args) => {
    const key = `${command} ${args[0] ?? ''}${args[1] ? ' ' + args[1] : ''}`.trim()
    for (const k of Object.keys(script)) {
      if (key.startsWith(k)) {
        const r = script[k]!()
        return { exitCode: r.exitCode, signal: r.signal ?? null, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut ?? false }
      }
    }
    throw new Error(`unexpected command: ${key}`)
  }
}

describe('runSwebenchVerifier', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ak-swev-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reward=1 when harness reports resolved=true', async () => {
    const runner = runnerScript({
      'git add': () => ({ exitCode: 0, stdout: '', stderr: '' }),
      'git diff': () => ({ exitCode: 0, stdout: AGENT_PATCH, stderr: '' }),
      'python3 -m': () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    })
    const reader: ReportReader = async () => ({ resolved: true, f2p: ['test_a'], p2p: ['test_b'] })
    const { reward } = await runSwebenchVerifier(
      { rootDir: dir, rolloutId: 'r1', task: makeTask(), cwd: join(dir, 'ws') },
      { runner, reportReader: reader },
    )
    expect(reward.reward).toBe(1)
    expect(reward.label).toBe('resolved')
    expect(reward.verifierKind).toBe('swebench')
    expect(reward.metadata?.f2pPassed).toEqual(['test_a'])
  })

  it('reward=0 when harness reports resolved=false', async () => {
    const runner = runnerScript({
      'git add': () => ({ exitCode: 0, stdout: '', stderr: '' }),
      'git diff': () => ({ exitCode: 0, stdout: AGENT_PATCH, stderr: '' }),
      'python3 -m': () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    const reader: ReportReader = async () => ({ resolved: false })
    const { reward } = await runSwebenchVerifier(
      { rootDir: dir, rolloutId: 'r2', task: makeTask(), cwd: join(dir, 'ws') },
      { runner, reportReader: reader },
    )
    expect(reward.reward).toBe(0)
    expect(reward.label).toBe('unresolved')
  })

  it('reward=0 label=timeout when harness exceeds timeout', async () => {
    const runner = runnerScript({
      'git add': () => ({ exitCode: 0, stdout: '', stderr: '' }),
      'git diff': () => ({ exitCode: 0, stdout: AGENT_PATCH, stderr: '' }),
      'python3 -m': () => ({ exitCode: null, stdout: '', stderr: 'killed', timedOut: true }),
    })
    const reader: ReportReader = async () => null
    const { reward } = await runSwebenchVerifier(
      { rootDir: dir, rolloutId: 'r3', task: makeTask(), cwd: join(dir, 'ws') },
      { runner, reportReader: reader },
    )
    expect(reward.reward).toBe(0)
    expect(reward.label).toBe('timeout')
    expect(reward.metadata?.reason).toBe('timeout')
  })

  it('reward=0 reason=empty_patch when agent produced no diff and skips harness', async () => {
    let harnessCalled = false
    const runner: CommandRunner = async (command, args) => {
      if (command === 'git' && args[0] === 'diff') return { exitCode: 0, signal: null, stdout: '\n', stderr: '', timedOut: false }
      if (command === 'python' || command === 'python3') harnessCalled = true
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    const reader: ReportReader = async () => null
    const { reward } = await runSwebenchVerifier(
      { rootDir: dir, rolloutId: 'r4', task: makeTask(), cwd: join(dir, 'ws') },
      { runner, reportReader: reader },
    )
    expect(reward.reward).toBe(0)
    expect(reward.label).toBe('unresolved')
    expect(reward.metadata?.reason).toBe('empty_patch')
    expect(harnessCalled).toBe(false)
    // The patch artifact still exists (empty)
    const written = await readFile(join(dir, 'rl-verifier', 'r4', 'patch.diff'), 'utf8')
    expect(written.trim()).toBe('')
  })
})

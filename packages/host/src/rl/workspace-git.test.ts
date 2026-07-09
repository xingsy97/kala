import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedGitWorkspace, WorkspaceSeedError, type GitRunner } from './workspace-git.js'
import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

const REPO = 'https://github.com/example/repo.git'
const BASE = 'abc123def4567890'
const TEST_PATCH = 'diff --git a/tests/test_x.py b/tests/test_x.py\n--- a/tests/test_x.py\n+++ b/tests/test_x.py\n'

function makeTask(overrides: Partial<AgentRlTask['workspace']> = {}, testPatch?: string): AgentRlTask {
  return {
    schemaVersion: 'agent.rl.task.v1',
    taskId: 'git-test',
    source: { kind: 'swebench' },
    prompt: 'noop',
    workspace: { kind: 'git', repoUrl: REPO, baseCommit: BASE, ...overrides },
    verifier: { kind: 'command', command: ['true'], timeoutMs: 1000 },
    governance: { trainingAllowed: true, redactionStatus: 'not_required', retentionClass: 'training_allowed' },
    ...(testPatch ? { metadata: { testPatch } } : {}),
  }
}

describe('seedGitWorkspace', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ak-git-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('happy path: clone, checkout, apply testPatch', async () => {
    const calls: string[][] = []
    const runner: GitRunner = vi.fn(async (args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${BASE}\n`, stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const workspace = join(dir, 'ws')
    const result = await seedGitWorkspace(workspace, makeTask({}, TEST_PATCH), { runner })
    expect(result.headSha).toBe(BASE)
    expect(result.applied).toBe(true)

    expect(calls[0]).toEqual(['clone', '--depth=200', REPO, workspace])
    expect(calls[1]).toEqual(['checkout', BASE])
    expect(calls[2]).toEqual(['rev-parse', 'HEAD'])
    expect(calls[3]?.[0]).toBe('apply')
    expect(calls[3]?.[1]).toBe('--index')

    const patchOnDisk = await readFile(join(workspace, '.agent-kernel-test.patch'), 'utf8').catch((err) => err.code)
    expect(patchOnDisk).toBe('ENOENT')
  })

  it('deep-fetch fallback when initial checkout misses baseCommit', async () => {
    let checkoutCall = 0
    const runner: GitRunner = async (args) => {
      if (args[0] === 'clone') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'checkout') {
        checkoutCall += 1
        if (checkoutCall === 1) return { exitCode: 1, stdout: '', stderr: 'unknown revision' }
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${BASE}\n`, stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const result = await seedGitWorkspace(join(dir, 'ws'), makeTask(), { runner })
    expect(result.headSha).toBe(BASE)
    expect(result.applied).toBe(false)
    expect(checkoutCall).toBe(2)
  })

  it('throws WorkspaceSeedError on clone failure', async () => {
    const runner: GitRunner = async (args) => {
      if (args[0] === 'clone') return { exitCode: 128, stdout: '', stderr: 'fatal: could not read Username' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await expect(
      seedGitWorkspace(join(dir, 'ws'), makeTask(), { runner }),
    ).rejects.toBeInstanceOf(WorkspaceSeedError)
  })

  it('throws WorkspaceSeedError on patch conflict, log includes patch head', async () => {
    const runner: GitRunner = async (args) => {
      if (args[0] === 'apply') return { exitCode: 1, stdout: '', stderr: 'error: patch does not apply' }
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${BASE}\n`, stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await expect(
      seedGitWorkspace(join(dir, 'ws'), makeTask({}, TEST_PATCH), { runner }),
    ).rejects.toThrow(/patch does not apply|apply testPatch failed/)
  })

  it('rejects missing repoUrl or baseCommit', async () => {
    const runner: GitRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' })
    await expect(
      seedGitWorkspace(join(dir, 'ws'), makeTask({ repoUrl: undefined }), { runner }),
    ).rejects.toThrow(/repoUrl/)
    await expect(
      seedGitWorkspace(join(dir, 'ws'), makeTask({ baseCommit: undefined }), { runner }),
    ).rejects.toThrow(/baseCommit/)
  })
})

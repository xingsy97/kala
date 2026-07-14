import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { seedWorkspace } from './workspace-seeder.js'
import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

const taskBase: Omit<AgentRlTask, 'workspace'> = {
  schemaVersion: 'agent.rl.task.v1',
  taskId: 'seeder-test',
  source: { kind: 'local-fixture' },
  prompt: 'noop',
  verifier: { kind: 'command', command: ['bash', '-lc', 'true'], timeoutMs: 1000 },
  governance: { trainingAllowed: true, redactionStatus: 'not_required', retentionClass: 'training_allowed' },
}

function runShell(cmd: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-lc', cmd], { cwd, stdio: 'ignore' })
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`bash exit ${code}`))))
  })
}

describe('seedWorkspace', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ak-seed-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates the workdir for empty-tempdir', async () => {
    const workdir = join(dir, 'ws')
    await seedWorkspace(workdir, { ...taskBase, workspace: { kind: 'empty-tempdir' } })
    const contents = await readFile(join(workdir, '.keep')).catch(() => null)
    expect(contents).toBeNull()
    // Directory must exist though — a subsequent write should succeed
    await writeFile(join(workdir, 'probe'), 'x')
  })

  it('extracts a tar.gz into the workdir preserving flat root layout', async () => {
    // Build a small tarball with src/foo.py + tests/test_foo.py at the root
    const tarSrc = join(dir, 'src-tree')
    await mkdir(join(tarSrc, 'src'), { recursive: true })
    await mkdir(join(tarSrc, 'tests'), { recursive: true })
    await writeFile(join(tarSrc, 'src', 'foo.py'), 'def foo():\n    return 1\n')
    await writeFile(join(tarSrc, 'tests', 'test_foo.py'), 'from foo import foo\ndef test(): assert foo() == 1\n')
    const tarball = join(dir, 'fixture.tar.gz')
    await runShell(`tar -czf ${JSON.stringify(tarball)} -C ${JSON.stringify(tarSrc)} .`, dir)

    const workdir = join(dir, 'ws')
    await seedWorkspace(workdir, {
      ...taskBase,
      workspace: { kind: 'archive', archiveRef: pathToFileURL(tarball).href },
    })

    const foo = await readFile(join(workdir, 'src', 'foo.py'), 'utf8')
    expect(foo).toContain('def foo():')
    const test = await readFile(join(workdir, 'tests', 'test_foo.py'), 'utf8')
    expect(test).toContain('assert foo() == 1')
  })

  it('rejects missing archiveRef', async () => {
    const workdir = join(dir, 'ws')
    await expect(
      seedWorkspace(workdir, { ...taskBase, workspace: { kind: 'archive' } }),
    ).rejects.toThrow(/archiveRef/)
  })

  it('rejects non-file archive URLs', async () => {
    const workdir = join(dir, 'ws')
    await expect(
      seedWorkspace(workdir, {
        ...taskBase,
        workspace: { kind: 'archive', archiveRef: 'https://example.com/x.tar.gz' },
      }),
    ).rejects.toThrow(/file:\/\/|absolute/i)
  })

  it('rejects missing archive file', async () => {
    const workdir = join(dir, 'ws')
    await expect(
      seedWorkspace(workdir, {
        ...taskBase,
        workspace: { kind: 'archive', archiveRef: pathToFileURL(join(dir, 'nope.tar.gz')).href },
      }),
    ).rejects.toThrow(/not found/)
  })

  it('dispatches git kind to seedGitWorkspace (validates repoUrl requirement)', async () => {
    const workdir = join(dir, 'ws')
    await expect(
      seedWorkspace(workdir, { ...taskBase, workspace: { kind: 'git' } }),
    ).rejects.toThrow(/repoUrl/)
  })
})

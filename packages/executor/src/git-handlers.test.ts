import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSandbox } from './sandbox.js'
import { gitDiff, gitStatus, parsePorcelainStatus } from './git-handlers.js'

describe('parsePorcelainStatus', () => {
  it('parses staged, unstaged, untracked, and renamed entries', () => {
    const parsed = parsePorcelainStatus('## main\0 M src/a.ts\0A  src/b.ts\0?? src/c.ts\0R  src/new.ts\0src/old.ts\0')

    expect(parsed.branch).toBe('main')
    expect(parsed.files).toEqual([
      { path: 'src/a.ts', status: 'modified', staged: false, unstaged: true },
      { path: 'src/b.ts', status: 'added', staged: true, unstaged: false },
      { path: 'src/c.ts', status: 'untracked', staged: false, unstaged: true },
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed', staged: true, unstaged: false },
    ])
  })
})

describe('git handlers', () => {
  let root = ''
  let extraRoots: string[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-git-'))
    git(['init'])
    git(['config', 'user.email', 'agent-kernel@example.invalid'])
    git(['config', 'user.name', 'agent-kernel'])
    writeFileSync(join(root, 'tracked.txt'), 'one\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'initial'])
  })

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    for (const extraRoot of extraRoots) rmSync(extraRoot, { recursive: true, force: true })
    extraRoots = []
  })

  it('reports changed files and returns a read-only worktree diff', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'two\n')
    writeFileSync(join(root, 'new.txt'), 'new\n')

    const sandbox = createSandbox({ roots: [root] })
    const status = await gitStatus({ requestId: 'status-1', workspaceId: 'ws-1' }, sandbox)

    expect(status.error).toBeUndefined()
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', status: 'modified', unstaged: true }),
      expect.objectContaining({ path: 'new.txt', status: 'untracked', unstaged: true }),
    ]))

    const diff = await gitDiff({ requestId: 'diff-1', workspaceId: 'ws-1', path: 'tracked.txt' }, sandbox)
    expect(diff.error).toBeUndefined()
    expect(diff.oldText).toBe('one\n')
    expect(diff.newText).toBe('two\n')
  })

  it('returns staged diffs from HEAD to index', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'staged\n')
    git(['add', 'tracked.txt'])

    const diff = await gitDiff({ requestId: 'diff-2', workspaceId: 'ws-1', path: 'tracked.txt', staged: true }, createSandbox({ roots: [root] }))

    expect(diff.error).toBeUndefined()
    expect(diff.oldText).toBe('one\n')
    expect(diff.newText).toBe('staged\n')
  })

  it('uses the old path for renamed staged files', async () => {
    git(['mv', 'tracked.txt', 'renamed.txt'])

    const diff = await gitDiff({ requestId: 'diff-3', workspaceId: 'ws-1', path: 'renamed.txt', staged: true }, createSandbox({ roots: [root] }))

    expect(diff.error).toBeUndefined()
    expect(diff.oldText).toBe('one\n')
    expect(diff.newText).toBe('one\n')
  })

  it('resolves git status and diffs from the selected session cwd inside the sandbox', async () => {
    rmSync(root, { recursive: true, force: true })
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'ak-git-sandbox-'))
    extraRoots.push(sandboxRoot)
    const repoRoot = join(sandboxRoot, 'workspace', 'repo')
    const subdir = join(repoRoot, 'packages', 'app')
    mkdirSync(subdir, { recursive: true })
    root = repoRoot
    git(['init'])
    git(['config', 'user.email', 'agent-kernel@example.invalid'])
    git(['config', 'user.name', 'agent-kernel'])
    writeFileSync(join(repoRoot, 'tracked.txt'), 'one\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'initial'])
    writeFileSync(join(repoRoot, 'tracked.txt'), 'two\n')

    const sandbox = createSandbox({ roots: [sandboxRoot] })
    const status = await gitStatus({ requestId: 'status-cwd', workspaceId: 'ws-1', cwd: subdir }, sandbox)

    expect(status.error).toBeUndefined()
    expect(status.repo?.root).toBe(repoRoot)
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', status: 'modified', unstaged: true }),
    ]))

    const diff = await gitDiff({ requestId: 'diff-cwd', workspaceId: 'ws-1', cwd: subdir, path: 'tracked.txt' }, sandbox)
    expect(diff.error).toBeUndefined()
    expect(diff.oldText).toBe('one\n')
    expect(diff.newText).toBe('two\n')
  })

  function git(args: readonly string[]): void {
    const result = spawnSync('git', args as string[], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  }
})

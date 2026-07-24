import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listDirs, listFiles } from './fs-handlers.js'
import { createSandbox } from './sandbox.js'

/**
 * The `readWorkspaceFile` handler was removed as part of the workspace-exec
 * refactor (docs/planning/roadmap-notes/workspace-exec-refactor.md). File
 * reads now flow through `workspaceReadBinary` (see workspace-exec.test.ts)
 * and the MIME/kind classification lives in the dashboard.
 */
describe('filesystem inspection handlers', () => {
  let root: string

  beforeEach(() => {
    root = join(tmpdir(), `ak-fs-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists directories and files with stable type metadata', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'README.md'), 'hello', 'utf8')

    const result = await listDirs('r1', 'w1', root, createSandbox({ roots: [root] }))

    expect(result.error).toBeUndefined()
    expect(result.entries.map((entry) => ({ name: entry.name, type: entry.type }))).toEqual([
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file' },
    ])
  })

  it('lists searchable workspace files with ignore rules and limit caps', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'a', 'utf8')
    writeFileSync(join(root, 'src', 'b.ts'), 'b', 'utf8')
    writeFileSync(join(root, '.hidden.ts'), 'hidden', 'utf8')
    writeFileSync(join(root, 'node_modules/pkg', 'ignored.ts'), 'ignored', 'utf8')
    writeFileSync(join(root, '.git', 'ignored.ts'), 'ignored', 'utf8')

    const result = await listFiles({ requestId: 'r2', workspaceId: 'w1', query: '.ts', limit: 1 }, createSandbox({ roots: [root] }))

    expect(result.error).toBeUndefined()
    expect(result.files).toEqual([{ path: 'src/a.ts', size: 1 }])
    expect(result.truncated).toBe(true)
  })
})

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeTool } from './write.js'
import { makeCtx } from './_test-helpers.js'

describe('write', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-write-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('creates a new file and reports bytes', async () => {
    const p = join(root, 'sub', 'new.txt')
    const out = await writeTool.run(
      { path: p, content: 'hello' },
      makeCtx(root),
    )
    expect(out).toContain('Created')
    expect(readFileSync(p, 'utf8')).toBe('hello')
  })

  it('overwrites an existing file', async () => {
    const p = join(root, 'x.txt')
    writeFileSync(p, 'old')
    const out = await writeTool.run(
      { path: p, content: 'new' },
      makeCtx(root),
    )
    expect(out).toContain('Wrote')
    expect(readFileSync(p, 'utf8')).toBe('new')
  })

  it('rejects paths outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ak-write-out-'))
    try {
      await expect(
        writeTool.run(
          { path: join(outside, 'nope.txt'), content: 'x' },
          makeCtx(root),
        ),
      ).rejects.toThrow(/EACCES/)
      expect(existsSync(join(outside, 'nope.txt'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('aborts without touching the filesystem when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const p = join(root, 'guard.txt')
    await expect(
      writeTool.run({ path: p, content: 'x' }, makeCtx(root, ctrl.signal)),
    ).rejects.toThrow(/ECANCELED/)
    expect(existsSync(p)).toBe(false)
  })

  it('does not overwrite an existing file when aborted before mutation', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const p = join(root, 'keep.txt')
    writeFileSync(p, 'ORIGINAL')
    await expect(
      writeTool.run({ path: p, content: 'REPLACED' }, makeCtx(root, ctrl.signal)),
    ).rejects.toThrow(/ECANCELED/)
    expect(readFileSync(p, 'utf8')).toBe('ORIGINAL')
  })
})

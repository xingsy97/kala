import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { editTool } from './edit.js'
import { makeCtx } from './_test-helpers.js'

describe('edit', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-edit-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('replaces a unique occurrence', async () => {
    const p = join(root, 'a.txt')
    writeFileSync(p, 'one two three')
    const out = await editTool.run(
      { path: p, old_string: 'two', new_string: 'TWO' },
      makeCtx(root),
    )
    expect(out).toContain('Replaced 1')
    expect(readFileSync(p, 'utf8')).toBe('one TWO three')
  })

  it('throws EAMBIG on multiple matches without replace_all', async () => {
    const p = join(root, 'a.txt')
    writeFileSync(p, 'a a a')
    await expect(
      editTool.run(
        { path: p, old_string: 'a', new_string: 'b' },
        makeCtx(root),
      ),
    ).rejects.toThrow(/EAMBIG/)
  })

  it('replaces all with replace_all=true', async () => {
    const p = join(root, 'a.txt')
    writeFileSync(p, 'a a a')
    const out = await editTool.run(
      { path: p, old_string: 'a', new_string: 'b', replace_all: true },
      makeCtx(root),
    )
    expect(out).toContain('Replaced 3')
    expect(readFileSync(p, 'utf8')).toBe('b b b')
  })

  it('throws ENOTFOUND when old_string is not present', async () => {
    const p = join(root, 'a.txt')
    writeFileSync(p, 'nothing')
    await expect(
      editTool.run(
        { path: p, old_string: 'missing', new_string: 'x' },
        makeCtx(root),
      ),
    ).rejects.toThrow(/ENOTFOUND/)
  })

  it('throws ENOENT for missing files', async () => {
    await expect(
      editTool.run(
        { path: join(root, 'nope.txt'), old_string: 'a', new_string: 'b' },
        makeCtx(root),
      ),
    ).rejects.toThrow(/ENOENT/)
  })

  it('honours an already-aborted signal and leaves the file untouched', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const p = join(root, 'a.txt')
    writeFileSync(p, 'one two three')
    await expect(
      editTool.run(
        { path: p, old_string: 'two', new_string: 'TWO' },
        makeCtx(root, ctrl.signal),
      ),
    ).rejects.toThrow(/ECANCELED/)
    expect(readFileSync(p, 'utf8')).toBe('one two three')
  })
})

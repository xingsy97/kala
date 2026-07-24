import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeCtx } from './_test-helpers.js'
import { replaceManyInFileTool } from './replace-many-in-file.js'

describe('replace_many_in_file', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ak-replace-many-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('applies multiple replacements and commits once', async () => {
    const p = join(root, 'a.txt')
    writeFileSync(p, 'alpha beta gamma')
    const out = await replaceManyInFileTool.run({ path: p, edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'gamma', new_string: 'GAMMA' },
    ] }, makeCtx(root))
    expect(readFileSync(p, 'utf8')).toBe('ALPHA beta GAMMA')
    expect(JSON.parse(out)).toMatchObject({ ok: true, files: [{ replacements: [{ index: 0, count: 1 }, { index: 1, count: 1 }] }] })
  })

  it('does not write when a later replacement fails', async () => {
    const p = join(root, 'a.txt')
    writeFileSync(p, 'alpha beta gamma')
    await expect(replaceManyInFileTool.run({ path: p, edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'missing', new_string: 'MISSING' },
    ] }, makeCtx(root))).rejects.toThrow(/ENOTFOUND/)
    expect(readFileSync(p, 'utf8')).toBe('alpha beta gamma')
  })
})

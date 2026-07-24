import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyFilePatchTool } from './apply-file-patch.js'
import { makeCtx } from './_test-helpers.js'

describe('apply_file_patch', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ak-patch-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('adds and updates files from patch format', async () => {
    const p = join(root, 'a.txt')
    writeFileSync(p, 'one\ntwo\nthree\n')
    const out = await applyFilePatchTool.run({ patch: `*** Begin Patch
*** Add File: ${join(root, 'b.txt')}
+hello
*** Update File: ${p}
@@
 one
-two
+TWO
 three

*** End Patch` }, makeCtx(root))
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(p, 'utf8')).toBe('one\nTWO\nthree\n')
    expect(JSON.parse(out)).toMatchObject({ ok: true, files: [{ operation: 'created' }, { operation: 'modified' }] })
  })

  it('deletes files', async () => {
    const p = join(root, 'gone.txt')
    writeFileSync(p, 'bye')
    await applyFilePatchTool.run({ patch: `*** Begin Patch
*** Delete File: ${p}
*** End Patch` }, makeCtx(root))
    expect(existsSync(p)).toBe(false)
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { lsTool } from './ls.js'
import { makeCtx } from './_test-helpers.js'

describe('ls', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-ls-'))
    writeFileSync(join(root, 'b.txt'), '')
    writeFileSync(join(root, 'a.txt'), '')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, '.hidden'), '')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns sorted entries with a trailing slash for dirs', async () => {
    const out = await lsTool.run({ path: root }, makeCtx(root))
    expect(out.split('\n')).toEqual(['a.txt', 'b.txt', 'sub/'])
  })

  it('includes dotfiles when hidden=true', async () => {
    const out = await lsTool.run({ path: root, hidden: true }, makeCtx(root))
    expect(out.split('\n')).toContain('.hidden')
  })

  it('throws ENOTDIR on files', async () => {
    await expect(
      lsTool.run({ path: join(root, 'a.txt') }, makeCtx(root)),
    ).rejects.toThrow(/ENOTDIR/)
  })

  it('throws ENOENT on missing paths', async () => {
    await expect(
      lsTool.run({ path: join(root, 'no') }, makeCtx(root)),
    ).rejects.toThrow(/ENOENT/)
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readFileTool } from './read-file.js'
import { makeCtx } from './_test-helpers.js'
import { ToolError } from './registry.js'

describe('read_file', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-read-'))
    writeFileSync(join(root, 'file.txt'), 'alpha\nbeta\ngamma')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns content with cat -n style line numbers', async () => {
    const out = await readFileTool.run(
      { path: join(root, 'file.txt') },
      makeCtx(root),
    )
    expect(out).toBe('1\talpha\n2\tbeta\n3\tgamma')
  })

  it('supports offset and limit', async () => {
    const out = await readFileTool.run(
      { path: join(root, 'file.txt'), offset: 1, limit: 1 },
      makeCtx(root),
    )
    expect(out).toBe('2\tbeta')
  })

  it('throws ENOENT for missing files', async () => {
    await expect(
      readFileTool.run({ path: join(root, 'nope.txt') }, makeCtx(root)),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('throws EISDIR for directories', async () => {
    await expect(readFileTool.run({ path: root }, makeCtx(root))).rejects.toThrow(
      /EISDIR/,
    )
  })

  it('throws EINVAL when path is missing', async () => {
    await expect(readFileTool.run({}, makeCtx(root))).rejects.toThrow(/EINVAL/)
  })

  it('rejects paths outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ak-read-out-'))
    try {
      writeFileSync(join(outside, 'x.txt'), 'no')
      await expect(
        readFileTool.run({ path: join(outside, 'x.txt') }, makeCtx(root)),
      ).rejects.toThrow(/EACCES/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

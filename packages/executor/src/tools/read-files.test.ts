import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeCtx } from './_test-helpers.js'
import { readFilesTool } from './read-files.js'

describe('read_files', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-read-files-'))
    writeFileSync(join(root, 'a.txt'), 'alpha\nbeta')
    writeFileSync(join(root, 'b.txt'), 'one\ntwo\nthree')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns batcat-style sections', async () => {
    const out = await readFilesTool.run({ files: [
      { path: join(root, 'a.txt') },
      { path: join(root, 'b.txt'), offset: 1, limit: 1 },
    ] }, makeCtx(root))
    expect(out).toContain(`===== ${join(root, 'a.txt')} =====`)
    expect(out).toContain('1\talpha')
    expect(out).toContain(`===== ${join(root, 'b.txt')} =====`)
    expect(out).toContain('2\ttwo')
  })

  it('keeps truncated multi-file output within the byte budget', async () => {
    writeFileSync(join(root, 'large.txt'), '界'.repeat(500))
    const maxBytes = 180
    const out = await readFilesTool.run({
      files: [
        { path: join(root, 'a.txt') },
        { path: join(root, 'large.txt') },
      ],
      max_bytes: maxBytes,
    }, makeCtx(root))

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect(out).toContain(`... read_files output truncated at ${maxBytes} bytes ...`)
    expect(out).not.toContain('�')
  })
})

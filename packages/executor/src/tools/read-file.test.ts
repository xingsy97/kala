import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeCtx } from './_test-helpers.js'
import { readFileTool } from './read-file.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('read_file binary handling', () => {
  it('fails with an actionable binary-preview error instead of corrupt text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'read-file-binary-')); dirs.push(root)
    const path = join(root, 'image.png')
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    await expect(readFileTool.run({ path }, makeCtx(root))).rejects.toMatchObject({ code: 'EBINARY' })
  })
})

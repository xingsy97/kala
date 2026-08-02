import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJsonFile, writeJsonFile } from './atomic-json-file.js'
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
describe('atomic JSON persistence', () => {
  it('writes mode 0600 and leaves no temporary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-json-')); roots.push(root); const path = join(root, 'state.json')
    await writeJsonFile(path, { value: 1 })
    expect(await readJsonFile(path)).toEqual({ value: 1 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

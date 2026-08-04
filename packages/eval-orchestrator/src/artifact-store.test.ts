import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ContainedArtifactStore } from './artifact-store.js'

describe('path-contained artifact store', () => {
  it('reads only regular contained files whose size and hash match authority metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-artifacts-'))
    const store = new ContainedArtifactStore(join(directory, 'root')); await store.initialize()
    const content = Buffer.from('canonical evidence')
    await mkdir(join(directory, 'root', 'run'), { recursive: true }); await writeFile(join(directory, 'root', 'run', 'result.json'), content)
    const sha256 = createHash('sha256').update(content).digest('hex')
    await expect(store.readEntry({ path: 'run/result.json', mediaType: 'application/json', bytes: content.length, sha256 })).resolves.toMatchObject({ path: 'run/result.json', sha256 })
    await expect(store.readEntry({ path: '../result.json', mediaType: 'application/json', bytes: content.length, sha256 })).rejects.toThrow('contained and relative')
    await expect(store.readEntry({ path: '/etc/passwd', mediaType: 'text/plain', bytes: content.length, sha256 })).rejects.toThrow('contained and relative')
    await expect(store.readEntry({ path: 'run/result.json', mediaType: 'application/json', bytes: content.length, sha256: 'a'.repeat(64) })).rejects.toThrow('integrity mismatch')
  })

  it('rejects symlink files even when they point inside or outside the root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-artifacts-'))
    const store = new ContainedArtifactStore(join(directory, 'root')); await store.initialize()
    await writeFile(join(directory, 'outside'), 'private')
    await symlink(join(directory, 'outside'), join(directory, 'root', 'link'))
    const sha256 = createHash('sha256').update('private').digest('hex')
    await expect(store.readEntry({ path: 'link', mediaType: 'text/plain', bytes: 7, sha256 })).rejects.toThrow('non-symlink')
  })
})

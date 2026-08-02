import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionArtifactRegistry } from './session-artifact-registry.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

describe('SessionArtifactRegistry', () => {
  it('copies and reloads a session-bound image snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ak-session-artifact-'))
    const registry = new SessionArtifactRegistry(root)
    await registry.load()
    const record = await registry.registerImage({ sessionId: 's1', fileName: 'image.png', title: 'Image', data: png })
    expect(record.mediaType).toBe('image/png')
    expect(await readFile(registry.contentPath(record))).toEqual(png)
    const restarted = new SessionArtifactRegistry(root)
    await restarted.load()
    expect(restarted.get(record.artifactId)?.sessionId).toBe('s1')
  })

  it('rejects non-image payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ak-session-artifact-'))
    const registry = new SessionArtifactRegistry(root)
    await expect(registry.registerImage({ sessionId: 's1', fileName: 'secret.png', data: Buffer.from('not an image') })).rejects.toThrow('unsupported image type')
  })
})

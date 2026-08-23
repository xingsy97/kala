import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSandbox } from './sandbox.js'
import { publishLocalImage } from './publish-local-image.js'

const roots: string[] = []
const png = Buffer.from([137,80,78,71,13,10,26,10,0])
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
describe('publishLocalImage', () => {
  it('publishes supported images from the workspace and system temporary directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'publish-workspace-')); roots.push(workspace)
    const workspaceImage = join(workspace, 'inside.png'); await writeFile(workspaceImage, png)
    const tempRoot = await mkdtemp(join(tmpdir(), 'publish-temp-')); roots.push(tempRoot)
    const tempImage = join(tempRoot, 'outside.png'); await writeFile(tempImage, png)
    const sandbox = createSandbox({ roots: [workspace] })
    expect((await publishLocalImage({ requestId: 'w', path: workspaceImage }, sandbox)).mediaType).toBe('image/png')
    expect((await publishLocalImage({ requestId: 't', path: tempImage }, sandbox)).mediaType).toBe('image/png')
  })
  it('rejects non-images and symbolic links', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'publish-safe-')); roots.push(workspace)
    const text = join(workspace, 'fake.png'); await writeFile(text, 'not an image')
    const link = join(workspace, 'link.png'); await symlink(text, link)
    const sandbox = createSandbox({ roots: [workspace] })
    expect((await publishLocalImage({ requestId: 'x', path: text }, sandbox)).error).toContain('not a supported')
    expect((await publishLocalImage({ requestId: 'l', path: link }, sandbox)).error).toContain('symbolic links')
  })
})

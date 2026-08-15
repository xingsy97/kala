import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requestUpdateControl, startUpdateControlServer } from './update-control.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Executor update control socket', () => {
  it('reports quiescence and makes drain/resume explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runlab-update-control-')); roots.push(root)
    const socketPath = join(root, 'control.sock')
    let draining = false
    const server = await startUpdateControlServer({
      socketPath,
      status: () => ({ version: '1.2.3', workspaceId: 'ws-1', connected: true, draining, activeTools: 2, activeTerminals: 1 }),
      beginDrain: () => { draining = true },
      resume: () => { draining = false },
    })
    expect(await requestUpdateControl(socketPath, 'drain')).toMatchObject({ draining: true, activeTools: 2, activeTerminals: 1 })
    expect(await requestUpdateControl(socketPath, 'resume')).toMatchObject({ draining: false })
    await server.close()
  })
})

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bootstrapEnvironment, downloadExecutorUpdateAssets, reportInstallation, waitForApproval, writeInstallerSession } from './installer-flow.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('installer flow', () => {
  it('validates environment and writes private sessions atomically', () => {
    const env = bootstrapEnvironment({ HOST_URL: 'https://host', EXECUTOR_INSTALL_ID: 'inst', EXECUTOR_INSTALL_BOOTSTRAP: 'boot', EXECUTOR_INSTALL_MODE: 'service', EXECUTOR_INSTALL_ROOT: '/repo' })
    expect(env.EXECUTOR_INSTALL_MODE).toBe('service')
    const root = mkdtempSync(join(tmpdir(), 'installer-flow-')); roots.push(root)
    const path = join(root, 'private', 'session.json')
    writeInstallerSession(path, { version: 1, mode: 'user', executable: '/bin/runlab-executor', host: 'https://host', sandboxRoots: ['/repo'], credential: { token: 'ak_exec_test' } })
    expect(JSON.parse(readFileSync(path, 'utf8')).host).toBe('https://host')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('allows deployments without managed update assets and rejects partial publication', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    await expect(downloadExecutorUpdateAssets('https://host/')).resolves.toBeUndefined()

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('.json')
        ? new Response('{}', { status: 200 })
        : new Response('missing', { status: 404 })
    )))
    await expect(downloadExecutorUpdateAssets('https://host'))
      .rejects.toThrow('failed to download Executor update verification key: 404')
  })

  it('downloads the complete managed update metadata pair', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('.pem')
        ? new Response('PUBLIC KEY', { status: 200 })
        : new Response('{}', { status: 200 })
    )))
    await expect(downloadExecutorUpdateAssets('https://host/')).resolves.toEqual({
      manifestUrl: 'https://host/install/assets/executor-update-manifest.json',
      publicKey: 'PUBLIC KEY',
    })
  })

  it('reports status without exposing bootstrap in body and waits for approval', async () => {
    const env = bootstrapEnvironment({ HOST_URL: 'https://host', EXECUTOR_INSTALL_ID: 'inst', EXECUTOR_INSTALL_BOOTSTRAP: 'boot', EXECUTOR_INSTALL_MODE: 'temporary', EXECUTOR_INSTALL_ROOT: '/repo' })
    let reads = 0
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ status: 'asset_verified' }), { status: 200 })
      reads += 1
      return new Response(JSON.stringify({ status: reads > 1 ? 'paired' : 'pairing_pending' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await reportInstallation(env, 'asset_verified')
    await waitForApproval(env, 1)
    const postBody = String(fetchMock.mock.calls[0]?.[1]?.body)
    expect(postBody).not.toContain('boot')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer boot' })
  })
})

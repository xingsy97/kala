import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { hashFiles, isDedicatedDashboardRequest, parseDashboardManifest, parseDashboardRequest, serveDedicatedDashboard, verifyDashboardPublicRoute, writeDashboardRouteState } from './dedicated-dashboard.js'

const roots: string[] = []
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))))
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('independent Dedicated Dashboard release', () => {
  it('validates an exact versioned manifest and rejects traversal or future fields', () => {
    const files = [{ path: 'index.html', bytes: 2, sha256: digest('ok') }]
    const value = { schemaVersion: 1, product: 'agent-runlab-dashboard', version: '1.2.3', builtAt: new Date().toISOString(), source: { revision: 'a'.repeat(40), snapshotSha256: 'b'.repeat(64), dirty: false }, protocol: { min: '1.0.0', max: '1.1.0' }, assetDigest: hashFiles(files), files }
    expect(parseDashboardManifest(value)).toMatchObject({ version: '1.2.3', protocol: { min: '1.0.0', max: '1.1.0' } })
    expect(() => parseDashboardManifest({ ...value, files: [{ ...files[0], path: '../index.html' }] })).toThrow(/unsafe/)
    expect(() => parseDashboardManifest({ ...value, future: true })).toThrow(/unknown/)
    expect(() => parseDashboardRequest({ schemaVersion: 2 })).toThrow(/unknown|unsupported/)
  })

  it('claims only browser assets while API and Socket.IO remain Runtime routes', () => {
    const request = (url: string, accept?: string) => ({ method: 'GET', url, headers: { ...(accept ? { accept } : {}) } }) as never
    expect(isDedicatedDashboardRequest(request('/'))).toBe(true)
    expect(isDedicatedDashboardRequest(request('/session/one', 'text/html'))).toBe(true)
    expect(isDedicatedDashboardRequest(request('/assets/app.12345678.js'))).toBe(true)
    for (const path of ['/socket.io/', '/models', '/settings', '/runtime/capabilities', '/docs/index', '/artifacts/manifest', '/api/executor-installs']) expect(isDedicatedDashboardRequest(request(path))).toBe(false)
  })

  it('serves the active generation, SPA fallback, immutable chunks, and 404 for stale chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-dashboard-')); roots.push(root)
    const release = join(root, 'releases', 'dashboard-r1', 'assets')
    await mkdir(join(release, 'assets'), { recursive: true })
    await writeFile(join(release, 'index.html'), '<title>r1</title>')
    await writeFile(join(release, 'assets', 'app.12345678.js'), 'export{}')
    const statePath = join(root, 'route.json')
    await writeDashboardRouteState(statePath, { schemaVersion: 1, generation: 4, releaseId: 'dashboard-r1', releaseDigest: 'a'.repeat(64), assetDigest: 'b'.repeat(64), version: '1.0.0', protocol: { min: '1.0.0', max: '1.0.0' }, activatedAt: new Date().toISOString() })
    const server = createServer((request, response) => { void serveDedicatedDashboard({ request, response, statePath, releasesRoot: join(root, 'releases') }).then((served) => { if (!served) response.writeHead(418).end() }) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const shell = await fetch(`${origin}/session/one`, { headers: { accept: 'text/html' } })
    expect(await shell.text()).toContain('r1'); expect(shell.headers.get('x-agent-runlab-dashboard-generation')).toBe('4'); expect(shell.headers.get('cache-control')).toContain('no-cache')
    await expect(verifyDashboardPublicRoute(origin, { releaseId: 'dashboard-r1', generation: 4 }, 1_000)).resolves.toBeUndefined()
    await expect(verifyDashboardPublicRoute(origin, { releaseId: 'dashboard-r2', generation: 4 }, 150)).rejects.toThrow(/public verification failed/)
    const chunk = await fetch(`${origin}/assets/app.12345678.js`); expect(chunk.headers.get('cache-control')).toContain('immutable')
    const stale = await fetch(`${origin}/assets/app.deadbeef.js`); expect(stale.status).toBe(404); expect(stale.headers.get('content-type')).toContain('text/plain')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

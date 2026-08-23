import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { hashFiles, isDedicatedDashboardRequest, isHashedDashboardAssetPath, parseDashboardManifest, parseDashboardRequest, serveDedicatedDashboard, verifyDashboardPublicRoute, writeDashboardRouteState } from './dedicated-dashboard.js'

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
    for (const path of ['/socket.io/', '/admin/socket.io', '/admin/socket.io/assets/index.js', '/models', '/settings', '/runtime/capabilities', '/docs/index', '/artifacts/manifest', '/api/executor-installs']) expect(isDedicatedDashboardRequest(request(path))).toBe(false)
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
    const shellHtml = await shell.text(); expect(shellHtml).toContain('r1'); expect(shellHtml).toContain('agent-runlab-dashboard-generation'); expect(shell.headers.get('x-agent-runlab-dashboard-generation')).toBe('4'); expect(shell.headers.get('cache-control')).toContain('no-cache')
    await expect(verifyDashboardPublicRoute(origin, { releaseId: 'dashboard-r1', generation: 4 }, 1_000)).resolves.toBeUndefined()
    await expect(verifyDashboardPublicRoute(origin, { releaseId: 'dashboard-r2', generation: 4 }, 150)).rejects.toThrow(/public verification failed/)
    const chunk = await fetch(`${origin}/assets/app.12345678.js`); expect(chunk.headers.get('cache-control')).toContain('immutable')
    const stale = await fetch(`${origin}/assets/app.deadbeef.js`); expect(stale.status).toBe(404); expect(stale.headers.get('content-type')).toContain('text/plain')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('serves only manifest-verified hashed chunks from retained immutable releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-dashboard-')); roots.push(root)
    const releases = join(root, 'releases')
    const activeAssets = join(releases, 'dashboard-r2', 'assets')
    const oldAssets = join(releases, 'dashboard-r1', 'assets', 'assets')
    await mkdir(activeAssets, { recursive: true }); await mkdir(oldAssets, { recursive: true })
    const activeHtml = '<html><head></head><body>r2</body></html>'
    const oldHtml = '<html><head></head><body>r1</body></html>'
    const oldChunk = 'export const old = true'
    await writeFile(join(activeAssets, 'index.html'), activeHtml)
    await writeFile(join(releases, 'dashboard-r1', 'assets', 'index.html'), oldHtml)
    await writeFile(join(oldAssets, 'feature.deadbeef.js'), oldChunk)
    const manifest = (version: string, files: { path: string; bytes: number; sha256: string }[]) => ({ schemaVersion: 1, product: 'agent-runlab-dashboard', version, builtAt: new Date().toISOString(), source: { revision: 'a'.repeat(40), snapshotSha256: 'b'.repeat(64), dirty: false }, protocol: { min: '1.0.0', max: '1.0.0' }, assetDigest: hashFiles(files), files })
    const activeFiles = [{ path: 'index.html', bytes: Buffer.byteLength(activeHtml), sha256: digest(activeHtml) }]
    const oldFiles = [{ path: 'index.html', bytes: Buffer.byteLength(oldHtml), sha256: digest(oldHtml) }, { path: 'assets/feature.deadbeef.js', bytes: Buffer.byteLength(oldChunk), sha256: digest(oldChunk) }]
    await writeFile(join(releases, 'dashboard-r2', 'manifest.json'), JSON.stringify(manifest('2.0.0', activeFiles)))
    await writeFile(join(releases, 'dashboard-r1', 'manifest.json'), JSON.stringify(manifest('1.0.0', oldFiles)))
    const statePath = join(root, 'route.json')
    await writeDashboardRouteState(statePath, { schemaVersion: 1, generation: 2, releaseId: 'dashboard-r2', releaseDigest: 'a'.repeat(64), assetDigest: 'b'.repeat(64), version: '2.0.0', protocol: { min: '1.0.0', max: '1.0.0' }, activatedAt: new Date().toISOString() })
    const server = createServer((request, response) => { void serveDedicatedDashboard({ request, response, statePath, releasesRoot: releases }) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const response = await fetch(`${origin}/assets/feature.deadbeef.js`)
    expect(response.status).toBe(200); expect(await response.text()).toBe(oldChunk); expect(response.headers.get('x-agent-runlab-dashboard-release')).toBe('dashboard-r2'); expect(response.headers.get('x-agent-runlab-dashboard-asset-release')).toBe('dashboard-r1')
    expect((await fetch(`${origin}/assets/plain.js`)).status).toBe(404)
    expect(isHashedDashboardAssetPath('assets/feature.deadbeef.js')).toBe(true); expect(isHashedDashboardAssetPath('../feature.deadbeef.js')).toBe(false)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

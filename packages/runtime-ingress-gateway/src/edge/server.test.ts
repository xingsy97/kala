import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryRuntimeAssignmentStore } from '../assignments/store.js'
import type { LoginState, LoginStateStore } from '../auth/login-state-store.js'
import { startRuntimeIngressGateway, type RuntimeIngressGateway } from './server.js'
import { FileBrowserSessionStore } from '../auth/browser-session-store.js'
import { createSessionSecretBox } from '../auth/session-secret-box.js'
import { MemoryEnterpriseSsoResolver } from '../auth/enterprise-sso.js'
import { MemoryOrganizationStore, type OrganizationStore, type OrganizationStatus } from '../organizations/store.js'
import { SlidingWindowRateLimiter } from '../governance/rate-limit.js'
import { ServiceAccountService } from '../api/service-accounts.js'
import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class MemoryLoginStates implements LoginStateStore {
  private readonly values = new Map<string, LoginState>()
  async put(nonce: string, state: LoginState): Promise<void> { this.values.set(nonce, state) }
  async take(nonce: string): Promise<LoginState | undefined> { const value = this.values.get(nonce); this.values.delete(nonce); return value }
}

class TestOrganizationStore extends MemoryOrganizationStore {
  setStatus(organizationId: string, status: OrganizationStatus): void {
    const organization = this.organizations.get(organizationId)
    if (!organization) throw new Error('organization not found')
    this.organizations.set(organizationId, { ...organization, status })
  }
}

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())) })

describe('Private Cloud edge request path', () => {
  it('serves the versioned OpenAPI contract and envelopes method errors', async () => {
    const gateway = await createGateway('http://127.0.0.1:9')
    const openApi = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/openapi.json`)
    expect(openApi.status).toBe(200)
    expect(openApi.headers.get('x-request-id')).toEqual(expect.any(String))
    await expect(openApi.json()).resolves.toMatchObject({
      openapi: '3.1.0',
      paths: { '/api/v1/service-accounts': expect.any(Object) },
    })

    const invalid = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/openapi.json`, { method: 'POST' })
    expect(invalid.status).toBe(405)
    expect(invalid.headers.get('allow')).toBe('GET, HEAD')
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'invalid_request', requestId: expect.any(String) },
    })
  })

  it('authenticates scoped service accounts and injects one Runtime Unit authority', async () => {
    const upstreamRequests: Array<{ authorization?: string; unit?: string; organization?: string; principal?: string }> = []
    const upstream = createServer((request, response) => {
      upstreamRequests.push({
        authorization: request.headers.authorization,
        unit: request.headers['x-agent-runlab-runtime-unit'] as string | undefined,
        organization: request.headers['x-agent-runlab-organization-id'] as string | undefined,
        principal: request.headers['x-agent-runlab-principal'] as string | undefined,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ items: [] }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    const port = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })
    const serviceAccounts = new ServiceAccountService(new ServiceAccountAuthDatabase())
    const gateway = await createGateway(`http://127.0.0.1:${port}`, undefined, { serviceAccounts })

    const listed = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/sessions`, {
      headers: { authorization: 'Bearer ak_sa_test' },
    })
    expect(listed.status).toBe(200)
    expect(upstreamRequests).toEqual([{
      authorization: undefined,
      unit: 'tenant_api',
      organization: 'org_api',
      principal: 'prn_api',
    }])

    const denied = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/sessions`, {
      method: 'POST',
      headers: { authorization: 'Bearer ak_sa_test', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'forbidden', requestId: expect.any(String) } })
    expect(upstreamRequests).toHaveLength(1)
  })

  it('returns the versioned error envelope for Product API rate limits', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ items: [] }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    const port = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })
    const gateway = await createGateway(`http://127.0.0.1:${port}`, undefined, {
      serviceAccounts: new ServiceAccountService(new ServiceAccountAuthDatabase()),
      rateLimiter: new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 1 }),
    })
    const headers = { authorization: `Bearer ${['ak', 'sa', 'test-token'].join('_')}` }

    expect(await fetch(`http://127.0.0.1:${gateway.port}/api/v1/sessions`, { headers }).then((response) => response.status)).toBe(200)
    const limited = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/sessions`, { headers })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('x-kala-api-version')).toBe('v1')
    expect(limited.headers.get('x-kala-api-compatibility')).toBe('1')
    expect(limited.headers.get('x-request-id')).toEqual(expect.any(String))
    await expect(limited.json()).resolves.toMatchObject({
      error: {
        code: 'rate_limited',
        requestId: expect.any(String),
        details: { retryAfterMs: expect.any(Number) },
      },
    })
  })

  it('proxies installer and release assets without browser authentication', async () => {
    const seen: string[] = []
    const upstream = createServer((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200, { 'content-type': request.url === '/install.ps1' ? 'text/plain' : 'application/javascript' })
      response.end(request.url === '/install.ps1' ? "$ErrorActionPreference='Stop'" : '#!/usr/bin/env node')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address(); const port = typeof address === 'object' && address ? address.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })
    const gateway = await createGateway(`http://127.0.0.1:${port}`)
    const installer = await fetch(`http://127.0.0.1:${gateway.port}/install.ps1`)
    expect(installer.status).toBe(200)
    expect(await installer.text()).toContain('ErrorActionPreference')
    const asset = await fetch(`http://127.0.0.1:${gateway.port}/release-assets/kala-executor.cjs`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('/usr/bin/env node')
    expect(seen).toEqual(['/install.ps1', '/release-assets/kala-executor.cjs'])
  })

  it('binds login to one Unit, strips browser authority, and exposes account profile', async () => {
    const upstreamRequests: Array<{ headers: Record<string, string | string[] | undefined>; url?: string }> = []
    const upstream = createServer((request, response) => {
      upstreamRequests.push({ headers: request.headers, url: request.url })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamAddress = upstream.address()
    const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0
    running.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) })

    const provision = vi.fn().mockResolvedValue(undefined)
    const gateway = await createGateway(`http://127.0.0.1:${upstreamPort}`, provision)
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const loginCookie = cookieValue(login.headers.getSetCookie(), 'ak_login')
    expect(login.status).toBe(302)

    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, {
      headers: { cookie: `ak_login=${loginCookie}` }, redirect: 'manual',
    })
    const sessionCookie = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    expect(callback.status).toBe(302)
    expect(provision).toHaveBeenCalledOnce()

    const me = await fetch(`http://127.0.0.1:${gateway.port}/auth/me`, { headers: { cookie: `ak_session=${sessionCookie}` } })
    expect(await me.json()).toMatchObject({ authenticated: true, profile: { displayName: 'Alice Example', email: 'alice@example.test' } })
    const sessions = await fetch(`http://127.0.0.1:${gateway.port}/auth/sessions`, { headers: { cookie: `ak_session=${sessionCookie}` } })
    expect(await sessions.json()).toMatchObject({ sessions: [expect.objectContaining({ current: true, device: expect.any(Object) })] })

    const proxied = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, {
      headers: {
        cookie: `ak_session=${sessionCookie}; attacker=1`,
        authorization: 'Bearer browser-token',
        'x-agent-runlab-runtime-unit': 'tenant_forged',
        'x-agent-runlab-ingress-secret': 'forged',
      },
    })
    expect(proxied.status).toBe(200)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]?.headers.cookie).toBeUndefined()
    expect(upstreamRequests[0]?.headers.authorization).toBeUndefined()
    expect(upstreamRequests[0]?.headers['x-agent-runlab-runtime-unit']).toMatch(/^tenant_[a-f0-9]{26}$/u)
    expect(upstreamRequests[0]?.headers['x-agent-runlab-ingress-secret']).toBe('gateway-secret')
    // Authority headers are generated by Gateway, never accepted from the browser.
    expect(upstreamRequests[0]?.headers['x-agent-runlab-principal']).toBeUndefined()

    const logout = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`, { method: 'POST', headers: { cookie: `ak_session=${sessionCookie}`, origin: `http://127.0.0.1:${gateway.port}` } })
    expect(logout.status).toBe(204)
    const afterLogout = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers: { cookie: `ak_session=${sessionCookie}` } })
    expect(afterLogout.status).toBe(401)

    const replay = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=replay`, { headers: { cookie: `ak_login=${loginCookie}` } })
    expect(replay.status).toBe(400)
  })

  it('serves authenticated Dashboard assets from the independent Dashboard service while APIs stay on Runtime', async () => {
    const runtimePaths: string[] = []
    const runtime = createServer((request, response) => { runtimePaths.push(request.url ?? ''); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"runtime":true}') })
    const dashboardPaths: string[] = []
    const dashboard = createServer((request, response) => { dashboardPaths.push(request.url ?? ''); response.writeHead(200, { 'content-type': request.url?.endsWith('.js') ? 'application/javascript' : 'text/html' }); response.end(request.url?.endsWith('.js') ? 'globalThis.dashboard=true' : '<title>independent dashboard</title>') })
    await Promise.all([
      new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => dashboard.listen(0, '127.0.0.1', resolve)),
    ])
    running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
    running.push({ close: () => new Promise<void>((resolve) => dashboard.close(() => resolve())) })
    const runtimeAddress = runtime.address(); const dashboardAddress = dashboard.address()
    const runtimePort = typeof runtimeAddress === 'object' && runtimeAddress ? runtimeAddress.port : 0
    const dashboardPort = typeof dashboardAddress === 'object' && dashboardAddress ? dashboardAddress.port : 0
    const gateway = await createGateway(`http://127.0.0.1:${runtimePort}`, undefined, { dashboardOrigin: `http://127.0.0.1:${dashboardPort}` })
    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const headers = { cookie: `ak_session=${session}` }
    const document = await fetch(`http://127.0.0.1:${gateway.port}/workspace`, { headers: { ...headers, accept: 'text/html' } })
    expect(await document.text()).toContain('independent dashboard')
    expect(await fetch(`http://127.0.0.1:${gateway.port}/assets/app.12345678.js`, { headers }).then((value) => value.text())).toContain('dashboard=true')
    expect(await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers }).then((value) => value.json())).toEqual({ runtime: true })
    expect(dashboardPaths).toEqual(['/workspace', '/assets/app.12345678.js'])
    expect(runtimePaths).toEqual(['/runtime/capabilities'])
  })

  it('denies runtime access for inactive organizations without proxying upstream', async () => {
    const runtimePaths: string[] = []
    const runtime = createServer((request, response) => {
      runtimePaths.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"runtime":true}')
    })

    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
    const runtimeAddress = runtime.address()
    const runtimePort = typeof runtimeAddress === 'object' && runtimeAddress ? runtimeAddress.port : 0
    const organizations = new TestOrganizationStore()
    const gateway = await createGateway(`http://127.0.0.1:${runtimePort}`, undefined, { organizations })

    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const access = await organizations.findAccess({ issuer: 'http://identity.example', subject: 'alice' })
    organizations.setStatus(access!.organization.id, 'suspended')

    const me = await fetch(`http://127.0.0.1:${gateway.port}/auth/me`, { headers: { cookie: `ak_session=${session}` } })
    expect(await me.json()).toMatchObject({ authenticated: true, organization: { status: 'suspended' } })
    const runtimeResponse = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers: { cookie: `ak_session=${session}` } })
    expect(runtimeResponse.status).toBe(403)
    expect(await runtimeResponse.json()).toEqual({ error: 'organization_not_active', status: 'suspended' })
    expect(runtimePaths).toEqual([])
  })

  it('rate limits authenticated tenant requests before proxying upstream', async () => {
    const runtimePaths: string[] = []
    const runtime = createServer((request, response) => {
      runtimePaths.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"runtime":true}')
    })
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    running.push({ close: () => new Promise<void>((resolve) => runtime.close(() => resolve())) })
    const runtimeAddress = runtime.address()
    const runtimePort = typeof runtimeAddress === 'object' && runtimeAddress ? runtimeAddress.port : 0
    const gateway = await createGateway(`http://127.0.0.1:${runtimePort}`, undefined, {
      organizations: new TestOrganizationStore(),
      rateLimiter: new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 1 }),
    })

    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login`, { redirect: 'manual' })
    const nonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    const callback = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${nonce}` }, redirect: 'manual' })
    const session = cookieValue(callback.headers.getSetCookie(), 'ak_session')
    const headers = { cookie: `ak_session=${session}` }

    expect(await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers }).then((response) => response.status)).toBe(200)
    const limited = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    await expect(limited.json()).resolves.toMatchObject({ error: 'rate_limited' })
    expect(runtimePaths).toEqual(['/runtime/capabilities'])
  })

  it('directs enterprise login through a server-resolved IdP and rejects mismatched callbacks', async () => {
    let callbackProvider = 'idp_enterprise'
    const authorizationOptions: Array<{ idpHint?: string; loginHint?: string }> = []
    const enterpriseSso = new MemoryEnterpriseSsoResolver([{ id: 'sso_acme', providerId: 'idp_enterprise', loginHint: 'employee@acme.test' }])
    const gateway = await createGateway('http://127.0.0.1:9', undefined, {
      enterpriseSso,
      authorizationOptions,
      callbackIdentity: () => ({ issuer: 'http://identity.example', subject: 'alice', upstreamProviderId: callbackProvider }),
    })

    const unknown = await fetch(`http://127.0.0.1:${gateway.port}/auth/login?sso=unknown`, { redirect: 'manual' })
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toEqual({ error: 'sso_connection_not_found' })

    const login = await fetch(`http://127.0.0.1:${gateway.port}/auth/login?sso=sso_acme`, { redirect: 'manual' })
    expect(login.status).toBe(302)
    expect(authorizationOptions.at(-1)).toEqual({ idpHint: 'idp_enterprise', loginHint: 'employee@acme.test' })
    const firstNonce = cookieValue(login.headers.getSetCookie(), 'ak_login')
    callbackProvider = 'idp_attacker'
    const mismatch = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=bad`, { headers: { cookie: `ak_login=${firstNonce}` }, redirect: 'manual' })
    expect(mismatch.status).toBe(403)
    await expect(mismatch.json()).resolves.toEqual({ error: 'sso_authentication_mismatch' })

    callbackProvider = 'idp_enterprise'
    const acceptedLogin = await fetch(`http://127.0.0.1:${gateway.port}/auth/login?sso=sso_acme`, { redirect: 'manual' })
    const acceptedNonce = cookieValue(acceptedLogin.headers.getSetCookie(), 'ak_login')
    const accepted = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=ok`, { headers: { cookie: `ak_login=${acceptedNonce}` }, redirect: 'manual' })
    expect(accepted.status).toBe(302)
  })

  it('fails closed for unauthenticated APIs and enforces same-origin POST logout', async () => {
    const gateway = await createGateway('http://127.0.0.1:9')
    const api = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { redirect: 'manual' })
    expect(api.status).toBe(401)
    await expect(api.json()).resolves.toEqual({ error: 'authentication_required' })

    const navigation = await fetch(`http://127.0.0.1:${gateway.port}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    expect(navigation.status).toBe(303)
    expect(navigation.headers.get('location')).toBe('/auth/login')

    const getLogout = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`)
    expect(getLogout.status).toBe(405)
    const crossOrigin = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } })
    expect(crossOrigin.status).toBe(403)
    const logout = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${gateway.port}`, accept: 'text/html', 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    })
    expect(logout.status).toBe(303)
    expect(logout.headers.get('location')).toBe('/auth/login?prompt=login')
    expect(logout.headers.getSetCookie().join(';')).toContain('ak_session=')
    expect(logout.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    const forcedLogin = await fetch(`http://127.0.0.1:${gateway.port}${logout.headers.get('location')}`, { redirect: 'manual' })
    expect(forcedLogin.status).toBe(302)
    expect(forcedLogin.headers.get('location')).toContain('prompt=login')
  })
})

async function createGateway(
  hostOrigin: string,
  provision?: (unitId: string) => Promise<void>,
  auth?: {
    enterpriseSso?: MemoryEnterpriseSsoResolver
    authorizationOptions?: Array<{ idpHint?: string; loginHint?: string }>
    callbackIdentity?(): { issuer: string; subject: string; upstreamProviderId?: string }
    dashboardOrigin?: string
    organizations?: OrganizationStore
    rateLimiter?: SlidingWindowRateLimiter
    serviceAccounts?: ServiceAccountService
  },
): Promise<RuntimeIngressGateway> {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-sessions-'))
  const sessions = new FileBrowserSessionStore(join(dir, 'sessions.json'))
  await sessions.load()
  const gateway = await startRuntimeIngressGateway({
    port: 0,
    listenHost: '127.0.0.1',
    hostOrigin,
    ...(auth?.dashboardOrigin ? { dashboardOrigin: auth.dashboardOrigin } : {}),
    publicOrigin: 'http://127.0.0.1:0',
    sessions,
    cacheNamespaceSecret: 'test-session-secret-with-sufficient-entropy',
    secretBox: createSessionSecretBox('test', [{ id: 'test', key: Buffer.alloc(32, 7) }]),
    ingressSecret: 'gateway-secret',
    ...(auth?.organizations ? { organizations: auth.organizations } : {}),
    ...(auth?.rateLimiter ? { rateLimiter: auth.rateLimiter } : {}),
    ...(auth?.serviceAccounts ? { serviceAccounts: auth.serviceAccounts } : {}),
    directory: new MemoryRuntimeAssignmentStore(),
    loginStates: new MemoryLoginStates(),
    ...(auth?.enterpriseSso ? { enterpriseSso: auth.enterpriseSso } : {}),
    oidc: {
      async authorizationUrl(_redirectUri, authorizationOptions) {
        const url = new URL('http://identity.example/authorize')
        if (authorizationOptions?.prompt) url.searchParams.set('prompt', authorizationOptions.prompt)
        if (authorizationOptions?.idpHint) url.searchParams.set('idp_hint', authorizationOptions.idpHint)
        auth?.authorizationOptions?.push({ ...(authorizationOptions?.idpHint ? { idpHint: authorizationOptions.idpHint } : {}), ...(authorizationOptions?.loginHint ? { loginHint: authorizationOptions.loginHint } : {}) })
        return { url, codeVerifier: 'verifier', state: 'state' }
      },
      async callback() { return { identity: auth?.callbackIdentity?.() ?? { issuer: 'http://identity.example', subject: 'alice', displayName: 'Alice Example', email: 'alice@example.test' } } },
      async refresh() { return {} },
      async revokeRefreshToken() {},
    },
    ...(provision ? { provision } : {}),
  })
  running.push(gateway)
  running.push({ close: async () => { rmSync(dir, { recursive: true, force: true }) } })
  return gateway
}

class ServiceAccountAuthDatabase implements SqlExecutor {
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
    return {
      rows: [{
        principal_id: 'prn_api',
        organization_id: 'org_api',
        runtime_unit_id: 'tenant_api',
        organization_status: 'active',
        scopes: ['workspace:read'],
      } as unknown as Row],
      rowCount: 1,
      command: '',
      oid: 0,
      fields: [],
    }
  }
}

function cookieValue(headers: readonly string[], name: string): string {
  const header = headers.find((value) => value.startsWith(`${name}=`))
  if (!header) throw new Error(`missing ${name} cookie`)
  return header.slice(name.length + 1).split(';')[0] ?? ''
}

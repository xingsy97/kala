import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryRuntimeAssignmentStore } from '../assignments/store.js'
import type { LoginState, LoginStateStore } from '../auth/login-state-store.js'
import { startRuntimeIngressGateway, type RuntimeIngressGateway } from './server.js'
import { FileBrowserSessionStore } from '../auth/browser-session-store.js'
import { createSessionSecretBox } from '../auth/session-secret-box.js'
import { MemoryEnterpriseSsoResolver } from '../auth/enterprise-sso.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class MemoryLoginStates implements LoginStateStore {
  private readonly values = new Map<string, LoginState>()
  async put(nonce: string, state: LoginState): Promise<void> { this.values.set(nonce, state) }
  async take(nonce: string): Promise<LoginState | undefined> { const value = this.values.get(nonce); this.values.delete(nonce); return value }
}

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())) })

describe('SaaS edge request path', () => {
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
    const asset = await fetch(`http://127.0.0.1:${gateway.port}/release-assets/agent-kernel-executor.cjs`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('/usr/bin/env node')
    expect(seen).toEqual(['/install.ps1', '/release-assets/agent-kernel-executor.cjs'])
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

    const logout = await fetch(`http://127.0.0.1:${gateway.port}/auth/logout`, { method: 'POST', headers: { cookie: `ak_session=${sessionCookie}`, origin: 'http://127.0.0.1:0' } })
    expect(logout.status).toBe(204)
    const afterLogout = await fetch(`http://127.0.0.1:${gateway.port}/runtime/capabilities`, { headers: { cookie: `ak_session=${sessionCookie}` } })
    expect(afterLogout.status).toBe(401)

    const replay = await fetch(`http://127.0.0.1:${gateway.port}/auth/callback?code=replay`, { headers: { cookie: `ak_login=${loginCookie}` } })
    expect(replay.status).toBe(400)
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
      headers: { origin: 'http://127.0.0.1:0', accept: 'text/html', 'sec-fetch-mode': 'navigate' },
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
  },
): Promise<RuntimeIngressGateway> {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-sessions-'))
  const sessions = new FileBrowserSessionStore(join(dir, 'sessions.json'))
  await sessions.load()
  const gateway = await startRuntimeIngressGateway({
    port: 0,
    listenHost: '127.0.0.1',
    hostOrigin,
    publicOrigin: 'http://127.0.0.1:0',
    sessions,
    cacheNamespaceSecret: 'test-session-secret-with-sufficient-entropy',
    secretBox: createSessionSecretBox('test', [{ id: 'test', key: Buffer.alloc(32, 7) }]),
    ingressSecret: 'gateway-secret',
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

function cookieValue(headers: readonly string[], name: string): string {
  const header = headers.find((value) => value.startsWith(`${name}=`))
  if (!header) throw new Error(`missing ${name} cookie`)
  return header.slice(name.length + 1).split(';')[0] ?? ''
}

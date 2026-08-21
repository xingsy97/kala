import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'

import httpProxy from 'http-proxy'

import type { LoginStateStore } from '../auth/login-state-store.js'
import type { OidcClient } from '../auth/oidc-client.js'
import type { AuthenticatedIdentity, RuntimeAssignmentStore } from '../assignments/store.js'
import { permits, type OrganizationStore } from '../organizations/store.js'
import { browserDeviceFromUserAgent, browserSessionTokenHash, isLive, type BrowserSession, type BrowserSessionStore } from '../auth/browser-session-store.js'
import type { SessionSecretBox } from '../auth/session-secret-box.js'
import type { EnterpriseSsoResolver } from '../auth/enterprise-sso.js'

export type RuntimeIngressGateway = { readonly http: HttpServer; readonly port: number; close(): Promise<void> }

function publicProfile(session: AuthenticatedIdentity): { displayName: string; email?: string; initials: string } {
  const displayName = session.displayName?.trim() || session.email?.split('@')[0] || 'Agent RunLab user'
  const initials = displayName.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'AR'
  return { displayName, ...(session.email ? { email: session.email } : {}), initials }
}

function isDocumentNavigation(request: IncomingMessage): boolean {
  if (request.method !== 'GET') return false
  const accept = request.headers.accept ?? ''
  const destination = request.headers['sec-fetch-dest']
  return accept.includes('text/html') && (destination === 'document' || destination === undefined)
}

function isPublicInstallerPath(pathname: string): boolean {
  return pathname === '/install' || pathname === '/install.ps1' || pathname.startsWith('/release-assets/')
}

const DASHBOARD_API_EXACT = new Set(['/models', '/settings', '/memo', '/metrics', '/organization', '/install', '/install.ps1'])
const DASHBOARD_API_PREFIXES = [
  '/socket.io/', '/runtime/', '/internal/', '/settings/', '/auth/', '/push/', '/api/', '/user/', '/organization/',
  '/artifacts/', '/session-artifacts/', '/router/', '/enhancement/', '/install/', '/release-assets/', '/themes/',
]

function isDashboardRequest(request: IncomingMessage, pathname: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (DASHBOARD_API_EXACT.has(pathname) || DASHBOARD_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  if (pathname === '/docs/index' || pathname === '/docs/content') return false
  if (pathname === '/' || request.headers.accept?.includes('text/html')) return true
  return /\.[A-Za-z0-9]+$/u.test(pathname)
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function cookies(request: IncomingMessage): Record<string, string> {
  try {
    return Object.fromEntries((request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2) as [string, string][])
  } catch { return {} }
}

function signedOutPage(): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed out · Agent RunLab</title><style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#f8fafc;font:16px system-ui,sans-serif}.card{width:min(28rem,calc(100% - 2rem));padding:2rem;border:1px solid #27272a;border-radius:1rem;background:#18181b;box-sizing:border-box}.mark{width:3rem;height:3rem;display:grid;place-items:center;border-radius:.75rem;background:#0f766e;font-weight:800}h1{font-size:1.5rem;margin:1.25rem 0 .5rem}p{color:#a1a1aa;line-height:1.5}a{display:inline-flex;margin-top:1rem;padding:.75rem 1rem;border-radius:.65rem;background:#0f766e;color:white;text-decoration:none;font-weight:650}</style></head><body><main class="card"><div class="mark">AR</div><h1>You are signed out</h1><p>Your Agent RunLab browser session has ended. Sign in again when you are ready.</p><a href="/auth/login">Sign in</a></main></body></html>'
}

export async function startRuntimeIngressGateway(options: {
  port: number
  oidc: OidcClient
  directory: RuntimeAssignmentStore
  organizations?: OrganizationStore
  enterpriseSso?: EnterpriseSsoResolver
  loginStates: LoginStateStore
  hostOrigin: string
  dashboardOrigin?: string
  sessions: BrowserSessionStore
  cacheNamespaceSecret: string
  secretBox: SessionSecretBox
  publicOrigin: string
  listenHost?: string
  ingressSecret: string
  provision?(unitId: string): Promise<void>
}): Promise<RuntimeIngressGateway> {
  const proxy = httpProxy.createProxyServer({ ws: true, target: options.hostOrigin })
  const dashboardProxy = options.dashboardOrigin ? httpProxy.createProxyServer({ target: options.dashboardOrigin }) : undefined
  proxy.on('error', () => {})
  dashboardProxy?.on('error', () => {})
  const authenticate = async (request: IncomingMessage): Promise<BrowserSession | undefined> => {
    const token = cookies(request).ak_session
    if (!token || token.length < 32 || token.length > 128) return undefined
    let session = await options.sessions.findByTokenHash(browserSessionTokenHash(token))
    if (!session || !isLive(session, Date.now())) return undefined
    if (session.refreshToken && session.providerRefreshAfter !== undefined && session.providerRefreshAfter <= Date.now()) {
      try {
        const result = await options.oidc.refresh(options.secretBox.decrypt(session.refreshToken))
        const replacement = result.refreshToken ? options.secretBox.encrypt(result.refreshToken) : session.refreshToken
        session = await options.sessions.updateProvider(session.id, session.refreshToken, {
          refreshToken: replacement,
          providerRefreshAfter: result.accessTokenExpiresAt !== undefined ? result.accessTokenExpiresAt - 5 * 60_000 : Date.now() + 55 * 60_000,
        }) ?? session
      } catch {
        return undefined
      }
    }
    return await options.sessions.touch(session.id, Date.now(), Date.now() + 86_400_000)
  }
  const publicUrl = new URL(options.publicOrigin)
  const secure = publicUrl.protocol === 'https:' ? '; Secure' : ''
  const callbackUri = `${options.publicOrigin}/auth/callback`
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', options.publicOrigin)
    if (isPublicInstallerPath(url.pathname)) {
      request.headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1)
      request.headers['x-forwarded-host'] = publicUrl.host
      proxy.web(request, response, { target: options.hostOrigin }, () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('installer upstream unavailable')
      })
      return
    }
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === '/signed-out') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(signedOutPage())
      return
    }
    if (url.pathname === '/auth/login') {
      const forceLogin = url.searchParams.get('prompt') === 'login'
      const ssoSelector = url.searchParams.get('sso')?.trim()
      const ssoConnection = ssoSelector && options.enterpriseSso ? await options.enterpriseSso.resolve(ssoSelector) : undefined
      if (ssoSelector && !ssoConnection) {
        response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: 'sso_connection_not_found' })); return
      }
      const login = await options.oidc.authorizationUrl(callbackUri, {
        ...(forceLogin ? { prompt: 'login' as const } : {}),
        ...(ssoConnection?.loginHint ? { loginHint: ssoConnection.loginHint } : {}),
        ...(ssoConnection ? { idpHint: ssoConnection.providerId } : {}),
      })
      const nonce = randomBytes(24).toString('base64url')
      await options.loginStates.put(nonce, { ...login, redirectUri: callbackUri, expiresAt: Date.now() + 10 * 60_000, ...(ssoConnection ? { ssoConnectionId: ssoConnection.id } : {}) })
      response.writeHead(302, { location: login.url.href, 'set-cookie': `ak_login=${nonce}; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=600` }); response.end(); return
    }
    if (url.pathname === '/auth/callback') {
      const nonce = cookies(request).ak_login
      const login = nonce ? await options.loginStates.take(nonce) : undefined
      if (!login) { response.writeHead(400); response.end('invalid login state'); return }
      const authentication = await options.oidc.callback(url, login.redirectUri, login.codeVerifier, login.state)
      const identity = authentication.identity
      if (login.ssoConnectionId) {
        const connection = await options.enterpriseSso?.resolve(login.ssoConnectionId)
        if (!connection || !await options.enterpriseSso!.authorize(connection, identity)) {
          response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ error: 'sso_authentication_mismatch' })); return
        }
      }
      const access = options.organizations ? await options.organizations.getOrCreateForIdentity(identity) : undefined
      const assignment = access ? { unitId: access.organization.unitId, identity } : await options.directory.getOrCreateForIdentity(identity)
      await options.provision?.(assignment.unitId)
      const token = randomBytes(32).toString('base64url')
      const now = Date.now()
      await options.sessions.create({
        tokenHash: browserSessionTokenHash(token),
        identity,
        cacheNamespace: createHmac('sha256', options.cacheNamespaceSecret).update(access?.organization.id ?? `${identity.issuer}\0${identity.subject}`).digest('base64url').slice(0, 22),
        device: browserDeviceFromUserAgent(request.headers['user-agent']),
        createdAt: now,
        idleExpiresAt: now + 86_400_000,
        absoluteExpiresAt: now + 30 * 86_400_000,
        ...(authentication.refreshToken ? { refreshToken: options.secretBox.encrypt(authentication.refreshToken) } : {}),
        ...(authentication.accessTokenExpiresAt !== undefined ? { providerRefreshAfter: authentication.accessTokenExpiresAt - 5 * 60_000 } : {}),
      })
      response.writeHead(302, { location: publicUrl.href, 'set-cookie': [`ak_session=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=2592000`, `ak_login=; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=0`] }); response.end(); return
    }
    if (url.pathname === '/auth/me') {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' })
      const access = session && options.organizations ? await options.organizations.findAccess(session.identity) : undefined
      response.end(JSON.stringify(session ? {
        authenticated: true,
        profile: publicProfile(session.identity),
        ...(access ? { organization: { id: access.organization.id, name: access.organization.name, role: access.membership.role } } : {}),
        cacheNamespace: session.cacheNamespace,
        expiresAt: new Date(Math.min(session.idleExpiresAt, session.absoluteExpiresAt)).toISOString(),
      } : { authenticated: false }))
      return
    }
    if (url.pathname === '/auth/logout') {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }); response.end(); return }
      const origin = request.headers.origin
      if (origin && origin !== publicUrl.origin) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      if (session) await options.sessions.revoke(session.id, 'logout', Date.now())
      const formNavigation = request.headers['sec-fetch-mode'] === 'navigate' || (request.headers.accept ?? '').includes('text/html')
      response.writeHead(formNavigation ? 303 : 204, {
        ...(formNavigation ? { location: '/auth/login?prompt=login' } : {}),
        'cache-control': 'no-store',
        'clear-site-data': '"cache"',
        'set-cookie': [
          `ak_session=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`,
          `ak_login=; HttpOnly${secure}; SameSite=Lax; Path=/auth; Max-Age=0`,
        ],
      })
      response.end(); return
    }
    if (url.pathname === '/auth/logout-all') {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }); response.end(); return }
      const origin = request.headers.origin
      if (origin && origin !== publicUrl.origin) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      if (!session) { response.writeHead(401, { 'cache-control': 'no-store' }); response.end(); return }
      await options.sessions.revokeAllForIdentity(session.identity, 'logout_all', Date.now())
      response.writeHead(204, { 'cache-control': 'no-store', 'clear-site-data': '"cache"', 'set-cookie': `ak_session=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0` })
      response.end(); return
    }
    if (url.pathname === '/auth/sessions') {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      if (!session) { response.writeHead(401, { 'cache-control': 'no-store' }); response.end(); return }
      const sessions = await options.sessions.listForIdentity(session.identity, Date.now())
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ sessions: sessions.map((item) => ({ id: item.id, current: item.id === session.id, device: item.device, createdAt: new Date(item.createdAt).toISOString(), lastSeenAt: new Date(item.lastSeenAt).toISOString(), expiresAt: new Date(Math.min(item.idleExpiresAt, item.absoluteExpiresAt)).toISOString() })) }))
      return
    }
    const sessionDelete = url.pathname.match(/^\/auth\/sessions\/([^/]+)$/u)
    if (sessionDelete) {
      if (request.method !== 'DELETE') { response.writeHead(405, { allow: 'DELETE', 'cache-control': 'no-store' }); response.end(); return }
      const origin = request.headers.origin
      if (origin && origin !== publicUrl.origin) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return }
      const session = await authenticate(request)
      if (!session) { response.writeHead(401, { 'cache-control': 'no-store' }); response.end(); return }
      const owned = (await options.sessions.listForIdentity(session.identity, Date.now())).find((item) => item.id === sessionDelete[1])
      if (!owned) { response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return }
      await options.sessions.revoke(owned.id, 'remote_logout', Date.now())
      response.writeHead(204, { 'cache-control': 'no-store', ...(owned.id === session.id ? { 'set-cookie': `ak_session=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0` } : {}) })
      response.end(); return
    }
    const session = await authenticate(request)
    const identity = session?.identity
    const organizationAccess = identity && options.organizations ? await options.organizations.findAccess(identity) : undefined
    if (url.pathname.startsWith('/auth/executor-pairings') && (/\/claim$/u.test(url.pathname) || (url.pathname === '/auth/executor-pairings' && request.method === 'POST'))) {
      const body = request.method === 'POST' ? await readRequestBody(request) : undefined
      const upstream = await fetch(`${options.hostOrigin}${url.pathname}`, { method: request.method, headers: { 'content-type': request.headers['content-type'] ?? 'application/json' }, ...(body ? { body: new Uint8Array(body) } : {}) })
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });response.end(Buffer.from(await upstream.arrayBuffer()));return
    }
    if (url.pathname === '/organization' && request.method === 'GET' && organizationAccess && options.organizations) {
      const members = await options.organizations.listMembers(organizationAccess.organization.id)
      const administration = await options.organizations.administrationSnapshot?.(organizationAccess.organization.id)
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({
        organization: { id: organizationAccess.organization.id, name: organizationAccess.organization.name }, role: organizationAccess.membership.role,
        permissions: ['runtime:read', 'runtime:write', 'workspace:manage', 'organization:manage', 'policy:manage'].filter((permission) => permits(organizationAccess.membership.role, permission as Parameters<typeof permits>[1])),
        members: members.map((member) => ({ issuer: member.identity.issuer, subject: member.identity.subject, displayName: member.identity.displayName, email: member.identity.email, role: member.role, createdAt: member.createdAt })),
        ...(administration ?? {}),
      })); return
    }
    if (url.pathname === '/organization/retention' && request.method === 'PUT' && organizationAccess && options.organizations?.updateRetentionPolicy) {
      if (!permits(organizationAccess.membership.role, 'policy:manage')) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'forbidden' })); return }
      const raw = JSON.parse((await readRequestBody(request)).toString('utf8')) as { sessionDays: number; artifactDays: number; auditDays: number; deletedResourceGraceDays: number }
      await options.organizations!.updateRetentionPolicy!(organizationAccess.organization.id, raw)
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return
    }
    if (url.pathname === '/organization/members' && ['POST', 'PATCH', 'DELETE'].includes(request.method ?? '') && organizationAccess && options.organizations) {
      if (!permits(organizationAccess.membership.role, 'organization:manage')) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'forbidden', requiredPermission: 'organization:manage' })); return }
      const raw = JSON.parse((await readRequestBody(request)).toString('utf8')) as { issuer?: string; subject?: string; displayName?: string; email?: string; role?: 'admin' | 'member' | 'viewer' }
      if (!raw.issuer || !raw.subject || (request.method !== 'DELETE' && !raw.role)) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'invalid_member' })); return }
      const target = { issuer: raw.issuer, subject: raw.subject, ...(raw.displayName ? { displayName: raw.displayName } : {}), ...(raw.email ? { email: raw.email } : {}) }
      if (request.method === 'POST') await options.organizations.addMember(organizationAccess.organization.id, target, raw.role!)
      else if (request.method === 'PATCH') await options.organizations.updateMemberRole(organizationAccess.organization.id, target, raw.role!)
      else await options.organizations.removeMember(organizationAccess.organization.id, target)
      // Authorization changes take effect immediately on every device. Existing
      // cookies cannot retain the removed or previous role until expiry.
      await options.sessions.revokeAllForIdentity(target, 'administrator', Date.now())
      response.writeHead(request.method === 'POST' ? 201 : 204, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(request.method === 'POST' ? JSON.stringify({ ok: true }) : undefined); return
    }
    if (url.pathname === '/organization/ownership' && request.method === 'POST' && organizationAccess && options.organizations) {
      if (organizationAccess.membership.role !== 'owner') { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'owner_required' })); return }
      const raw = JSON.parse((await readRequestBody(request)).toString('utf8')) as { issuer?: string; subject?: string }
      if (!raw.issuer || !raw.subject) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'invalid_member' })); return }
      const nextOwner = { issuer: raw.issuer, subject: raw.subject }
      await options.organizations.transferOwnership(organizationAccess.organization.id, identity!, nextOwner)
      await Promise.all([
        options.sessions.revokeAllForIdentity(identity!, 'administrator', Date.now()),
        options.sessions.revokeAllForIdentity(nextOwner, 'administrator', Date.now()),
      ])
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return
    }
    if ((url.pathname === '/memo' || url.pathname === '/user/session-tabs') && ['GET', 'HEAD', 'PUT'].includes(request.method ?? '') && session && organizationAccess) {
      request.headers['x-agent-runlab-principal'] = Buffer.from(`${session.identity.issuer}\0${session.identity.subject}`, 'utf8').toString('base64url')
      request.headers['x-agent-runlab-organization-id'] = organizationAccess.organization.id
      proxy.web(request, response, { target: options.hostOrigin }, () => { if (!response.headersSent) response.writeHead(502); response.end() })
      return
    }
    const assignment = organizationAccess ? { unitId: organizationAccess.organization.unitId, identity: identity! } : identity ? await options.directory.findByIdentity(identity) : undefined
    if (!identity || !assignment || identity.issuer !== assignment.identity.issuer || identity.subject !== assignment.identity.subject) {
      if (isDocumentNavigation(request)) response.writeHead(303, { location: '/auth/login', 'cache-control': 'no-store' })
      else { response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'authentication_required' })); return }
      response.end(); return
    }
    if (dashboardProxy && options.dashboardOrigin && isDashboardRequest(request, url.pathname)) {
      delete request.headers.cookie
      delete request.headers.authorization
      dashboardProxy.web(request, response, { target: options.dashboardOrigin }, () => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end('dashboard upstream unavailable')
      })
      return
    }
    const requiredRuntimePermission = request.method === 'GET' || request.method === 'HEAD' ? 'runtime:read' : 'runtime:write'
    if (organizationAccess && !permits(organizationAccess.membership.role, requiredRuntimePermission)) {
      response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'forbidden', requiredPermission: requiredRuntimePermission })); return
    }
    delete request.headers.cookie
    delete request.headers.authorization
    delete request.headers['x-agent-runlab-runtime-unit']
    delete request.headers['x-agent-runlab-ingress-secret']
    delete request.headers['x-agent-runlab-organization-id']
    delete request.headers['x-agent-runlab-organization-role']
    delete request.headers['x-agent-runlab-principal']
    request.headers['x-agent-runlab-runtime-unit'] = assignment.unitId
    request.headers['x-agent-runlab-ingress-secret'] = options.ingressSecret
    if (organizationAccess) {
      request.headers['x-agent-runlab-organization-id'] = organizationAccess.organization.id
      request.headers['x-agent-runlab-organization-role'] = organizationAccess.membership.role
      request.headers['x-agent-runlab-principal'] = Buffer.from(`${identity.issuer}\0${identity.subject}`, 'utf8').toString('base64url')
    }
    if (url.pathname.startsWith('/auth/executor-pairings')) {
      const decision = /^\/auth\/executor-pairings\/[^/]+\/(approve|reject)$/u.test(url.pathname)
      if (decision && (!organizationAccess || !permits(organizationAccess.membership.role, 'workspace:manage'))) { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'forbidden', requiredPermission: 'workspace:manage' })); return }
      const body = request.method === 'POST' ? await readRequestBody(request) : undefined
      const upstream = await fetch(`${options.hostOrigin}${url.pathname}`, { method: request.method, headers: { 'content-type': request.headers['content-type'] ?? 'application/json', ...(organizationAccess ? { 'x-agent-runlab-runtime-unit': assignment.unitId, 'x-agent-runlab-ingress-secret': options.ingressSecret } : {}) }, ...(body ? { body: new Uint8Array(body) } : {}) })
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });response.end(Buffer.from(await upstream.arrayBuffer()));return
    }
    if (url.pathname === '/auth/executor-invites' && request.method === 'POST') {
      if (organizationAccess && !permits(organizationAccess.membership.role, 'workspace:manage')) { response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'forbidden', requiredPermission: 'workspace:manage' })); return }
      const body = await readRequestBody(request)
      const upstream = await fetch(`${options.hostOrigin}${url.pathname}`, {
        method: 'POST',
        headers: {
          'content-type': request.headers['content-type'] ?? 'application/json',
          'x-agent-runlab-runtime-unit': assignment.unitId,
          'x-agent-runlab-ingress-secret': options.ingressSecret,
        },
        body: new Uint8Array(body),
      })
      const text = await upstream.text()
      if (upstream.ok) {
        const invite = JSON.parse(text) as { inviteToken?: string }
        if (invite.inviteToken) await options.directory.bindExecutorInvite(invite.inviteToken, assignment.unitId)
      }
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
      response.end(text)
      return
    }
    proxy.web(request, response, { target: options.hostOrigin }, () => { if (!response.headersSent) response.writeHead(502); response.end() })
  }
  const http = createServer((request, response) => { void handler(request, response).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${JSON.stringify({ event: 'runtime_ingress_request_failed', method: request.method, path: request.url?.split('?')[0], error: message })}\n`)
    const organizationMissing = message === 'organization_not_provisioned'
    if (!response.headersSent) response.writeHead(organizationMissing ? 403 : 500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(organizationMissing
      ? { error: 'organization_not_provisioned', message: 'Your identity is valid, but this account has not been enabled for an Agent RunLab organization.' }
      : { error: 'internal_server_error' }))
  }) })
  http.on('upgrade', (request, socket, head) => { void (async () => {
    const session = await authenticate(request)
    const identity = session?.identity
    const organizationAccess = identity && options.organizations ? await options.organizations.findAccess(identity) : undefined
    const assignment = organizationAccess ? { unitId: organizationAccess.organization.unitId, identity: identity! } : identity ? await options.directory.findByIdentity(identity) : undefined
    const executorInvite = typeof request.headers['x-agent-runlab-executor-invite'] === 'string' ? request.headers['x-agent-runlab-executor-invite'] : undefined
    const inviteUnitId = !assignment && executorInvite ? await options.directory.findUnitByExecutorInvite(executorInvite) : undefined
    const unitId = assignment?.unitId ?? inviteUnitId
    // Dashboard Socket.IO is a bidirectional command channel, not a read-only
    // stream. Viewer/read-only memberships must not reach mutating client events.
    // Executor enrollment uses a separate invite-authenticated path.
    const requiredPermission = executorInvite ? undefined : 'runtime:write'
    if (!unitId || (organizationAccess && requiredPermission && !permits(organizationAccess.membership.role, requiredPermission)) || (assignment && (!identity || identity.issuer !== assignment.identity.issuer || identity.subject !== assignment.identity.subject))) { socket.destroy(); return }
    delete request.headers.cookie
    delete request.headers.authorization
    request.headers['x-agent-runlab-runtime-unit'] = unitId
    request.headers['x-agent-runlab-ingress-secret'] = options.ingressSecret
    proxy.ws(request, socket, head, { target: options.hostOrigin }, () => socket.destroy())
  })().catch(() => socket.destroy()) })
  await new Promise<void>((resolve) => http.listen(options.port, options.listenHost ?? '127.0.0.1', resolve))
  const address = http.address(); const port = typeof address === 'object' && address ? address.port : options.port
  return { http, port, async close() { proxy.close(); dashboardProxy?.close(); await new Promise<void>((resolve) => http.close(() => resolve())) } }
}

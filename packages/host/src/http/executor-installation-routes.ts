import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'

import { schema, type DeploymentMode, type ExecutorInstallStatus } from '@agent-kernel/shared'

import { authenticateDashboardHandshake, type AuthConfig, type DashboardActor } from '../auth-control.js'
import type { AuditLogger } from '../audit-log.js'
import { ExecutorInstallationError, type ExecutorInstallationStore } from '../store/executor-installation.js'
import type { ExecutorIdentityStore } from '../store/executor-identity.js'
import { claimRoute } from './routes.js'

export function attachExecutorInstallationRoutes(server: HttpServer, options: {
  store: ExecutorInstallationStore
  identities?: ExecutorIdentityStore
  auth?: AuthConfig
  deploymentMode: DeploymentMode
  audit?: AuditLogger
}): void {
  const claimAttempts = new Map<string, { count: number; resetAt: number }>()
  server.on('request', (req, res) => {
    if (res.headersSent || res.writableEnded) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if ((path === '/install' || path === '/install.ps1') && req.method === 'GET') {
      claimRoute(req)
      const origin = requestOrigin(req)
      const shell = path === '/install'
      const body = shell ? renderShellBootstrap(origin) : renderPowerShellBootstrap(origin)
      res.writeHead(200, { 'content-type': shell ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end(body)
      return
    }

    const installSessionMatch = path.match(/^\/install\/session(?:\/([^/]+)(?:\/(events|redeem|status))?)?$/u)
    const installSession = Boolean(installSessionMatch)
    const match = path.match(/^\/api\/executor-installs(?:\/([^/]+)(?:\/(approve|reject|events|redeem|status))?)?$/u)
    if (!match && !installSession) return
    claimRoute(req)
    const idValue = match?.[1] ?? installSessionMatch?.[1]
    const id = idValue ? decodeURIComponent(idValue) : undefined
    const action = match?.[2] ?? installSessionMatch?.[2]

    if ((id === 'claim' || (installSession && !id)) && !action && req.method === 'POST') {
      const claimKey = clientAddress(req)
      if (!allowClaimAttempt(claimAttempts, claimKey)) { sendError(res, 429, 'setup_code_rate_limited'); return }
      void readJson(req).then((body) => {
        const setupCode = typeof (body as { setupCode?: unknown }).setupCode === 'string' ? (body as { setupCode: string }).setupCode : ''
        const claimed = options.store.claim(setupCode)
        if (!claimed) { sendError(res, 401, 'invalid_or_consumed_setup_code'); return }
        claimAttempts.delete(claimKey)
        const env = bootstrapEnvironment(requestOrigin(req), claimed.install, claimed.bootstrap)
        if (header(req, 'accept') === 'text/x-shellscript') {
          res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
          res.end(Object.entries(env).map(([key, value]) => `export ${key}=${quoteSh(value)}`).join('\n'))
          return
        }
        sendJson(res, 200, { env })
      }).catch((error) => handleError(res, error))
      return
    }

    if (id && action === 'events' && req.method === 'POST') {
      void handleClientEvent(req, res, options.store, id)
      return
    }
    if (id && action === 'redeem' && req.method === 'POST') {
      void handleRedeem(req, res, options.store, options.identities, id)
      return
    }
    if (id && action === 'status' && req.method === 'GET') {
      const bootstrap = bearer(req) ?? url.searchParams.get('bootstrap') ?? undefined
      if (!options.store.authenticate(id, bootstrap)) { sendError(res, 401, 'invalid_installation_credential'); return }
      const snapshot = options.store.get(id)
      if (!snapshot) { sendError(res, 404, 'installation_not_found'); return }
      sendJson(res, 200, snapshot)
      return
    }

    const authorization = authorizeManagement(req, options.deploymentMode, options.auth)
    if (!authorization.ok) { sendError(res, authorization.status, authorization.error); return }

    try {
      if (!id && req.method === 'POST') {
        void readJson(req).then((body) => {
          const input = schema.CreateExecutorInstallSchema.parse(body)
          const created = options.store.create(input, header(req, 'idempotency-key'))
          const origin = requestOrigin(req)
          const command = installCommand(origin, input.platform, input.mode, created.setupCode)
          options.audit?.log({ action: 'executor_install.create', actor: authorization.actor, outcome: 'ok', metadata: { id: created.install.id } })
          sendJson(res, 201, { ...created.install, command, setupCode: created.setupCode })
        }).catch((error) => handleError(res, error))
        return
      }
      if (!id) { sendError(res, 405, 'method_not_allowed'); return }
      if (!action && req.method === 'GET') {
        const snapshot = options.store.get(id)
        if (!snapshot) { sendError(res, 404, 'installation_not_found'); return }
        sendJson(res, 200, snapshot); return
      }
      if (!action && req.method === 'PATCH') {
        void readJson(req).then((body) => {
          const updated = options.store.update(id, schema.UpdateExecutorInstallSchema.parse(body))
          if (!updated) { sendError(res, 409, 'installation_not_editable'); return }
          sendJson(res, 200, updated)
        }).catch((error) => handleError(res, error)); return
      }
      if (!action && req.method === 'DELETE') {
        sendJson(res, 200, { ok: true, id, deleted: options.store.delete(id) }); return
      }
      if ((action === 'approve' || action === 'reject') && req.method === 'POST') {
        const updated = action === 'approve' ? options.store.approve(id) : options.store.reject(id)
        if (!updated) { sendError(res, 409, 'installation_not_pending'); return }
        options.audit?.log({ action: `executor_install.${action}`, actor: authorization.actor, outcome: 'ok', metadata: { id } })
        sendJson(res, 200, updated); return
      }
      if (action === 'events' && req.method === 'GET') {
        const after = Number(header(req, 'last-event-id') ?? url.searchParams.get('after') ?? -1)
        const events = options.store.events(id, Number.isSafeInteger(after) ? after : -1)
        if (!events) { sendError(res, 404, 'installation_not_found'); return }
        sendJson(res, 200, { events }); return
      }
      sendError(res, 405, 'method_not_allowed')
    } catch (error) { handleError(res, error) }
  })
}

async function handleClientEvent(req: IncomingMessage, res: ServerResponse, store: ExecutorInstallationStore, id: string): Promise<void> {
  try {
    const body = await readJson(req) as { bootstrap?: unknown; status?: unknown; errorCode?: unknown; metadata?: unknown }
    const bootstrap = typeof body.bootstrap === 'string' ? body.bootstrap : bearer(req)
    if (!bootstrap) { sendError(res, 401, 'installation_credential_required'); return }
    const status = schema.ExecutorInstallStatusSchema.parse(body.status) as ExecutorInstallStatus
    const event = schema.ExecutorInstallEventSchema.pick({ errorCode: true, metadata: true }).partial().parse({ errorCode: body.errorCode, metadata: body.metadata })
    sendJson(res, 200, store.reportClient(id, bootstrap, status, event.errorCode, event.metadata))
  } catch (error) { handleError(res, error) }
}

async function handleRedeem(req: IncomingMessage, res: ServerResponse, store: ExecutorInstallationStore, identities: ExecutorIdentityStore | undefined, id: string): Promise<void> {
  try {
    if (!identities) throw new ExecutorInstallationError('executor_identity_store_not_configured', 503)
    const body = await readJson(req) as { bootstrap?: unknown; workspaceId?: unknown; label?: unknown }
    const bootstrap = typeof body.bootstrap === 'string' ? body.bootstrap : bearer(req)
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
    if (!bootstrap || !workspaceId) throw new ExecutorInstallationError('invalid_redeem_request', 400)
    const snapshot = store.redeem(id, bootstrap, workspaceId)
    const token = identities.provisionWorkspace(workspaceId, typeof body.label === 'string' ? body.label.trim() : undefined)
    sendJson(res, 200, { installationId: snapshot.id, workspaceId, token })
  } catch (error) { handleError(res, error) }
}

export function authorizeSensitiveExecutorManagement(req: IncomingMessage, deploymentMode: DeploymentMode, auth: AuthConfig | undefined): { ok: true; actor: DashboardActor } | { ok: false; status: number; error: string } {
  return authorizeManagement(req, deploymentMode, auth)
}

function authorizeManagement(req: IncomingMessage, deploymentMode: DeploymentMode, auth: AuthConfig | undefined): { ok: true; actor: DashboardActor } | { ok: false; status: number; error: string } {
  const result = authenticateDashboardHandshake({ role: 'dashboard', clientVersion: 'http', ...(bearer(req) ? { token: bearer(req) } : {}) }, req, auth)
  if (!result.ok) return { ok: false, status: 401, error: result.reason }
  if (deploymentMode === 'saas' && (result.actor.kind !== 'ingress' || !['owner', 'admin'].includes(result.actor.role))) return { ok: false, status: 403, error: 'admin_required' }
  if (deploymentMode === 'standalone' && result.actor.kind === 'anonymous' && (auth?.github?.required || auth?.sharedToken)) return { ok: false, status: 401, error: 'operator_authentication_required' }
  return result
}

function bootstrapEnvironment(origin: string, snapshot: { id: string; mode: string; platform: string; workspaceRoot: string; label?: string }, bootstrap: string): Record<string, string> {
  return {
    HOST_URL: origin,
    EXECUTOR_INSTALL_ID: snapshot.id,
    EXECUTOR_INSTALL_BOOTSTRAP: bootstrap,
    EXECUTOR_INSTALL_MODE: snapshot.mode,
    EXECUTOR_INSTALL_PLATFORM: snapshot.platform,
    EXECUTOR_INSTALL_ROOT: snapshot.workspaceRoot,
    RUNLAB_RELEASE_ASSETS_URL: `${origin}/install/assets`,
    // The self-hosted release currently has checksums but no detached signing
    // infrastructure. This authorization is scoped to the one-time Host-issued
    // install session; the installer still verifies the downloaded executable.
    RUNLAB_INSTALLER_ALLOW_UNSIGNED: '1',
    ...(snapshot.label ? { EXECUTOR_INSTALL_LABEL: snapshot.label } : {}),
  }
}
function installCommand(origin: string, platform: string, mode: string, setupCode: string): string {
  return platform === 'windows'
    ? `$env:RUNLAB_SETUP_CODE=${quotePs(setupCode)}; $env:RUNLAB_INSTALL_MODE=${quotePs(mode)}; irm ${quotePs(`${origin}/install.ps1`)} | iex`
    : `curl -fsSL ${quoteSh(`${origin}/install`)} | RUNLAB_SETUP_CODE=${quoteSh(setupCode)} RUNLAB_INSTALL_MODE=${quoteSh(mode)} sh`
}
function renderShellBootstrap(origin: string): string {
  return `#!/bin/sh\nset -eu\ncode=\${RUNLAB_SETUP_CODE:-}\nif [ -z "$code" ]; then printf 'Agent RunLab setup code: ' >&2; IFS= read -r code; fi\ncase "$code" in *[!A-Fa-f0-9-]*|'') echo 'Invalid setup code' >&2; exit 1;; esac\ncommand -v bash >/dev/null 2>&1 || { echo 'Agent RunLab installer: bash is required' >&2; exit 1; }\ninstaller=\$(mktemp)\ntrap 'rm -f "$installer"' EXIT HUP INT TERM\ncurl -fSL --retry 3 --retry-connrefused -o "$installer" ${quoteSh(`${origin}/install/assets/install-executor.sh`)} || { echo 'Agent RunLab installer: failed to download installer asset' >&2; exit 1; }\nclaim=\$(curl -fSL --retry 3 --retry-connrefused -X POST -H 'content-type: application/json' -H 'accept: text/x-shellscript' --data "{\\"setupCode\\":\\"$code\\"}" ${quoteSh(`${origin}/install/session`)}) || { echo 'Agent RunLab installer: setup code is invalid, expired, or already used' >&2; exit 1; }\neval "$claim"\nbash "$installer"\n`
}
function renderPowerShellBootstrap(origin: string): string {
  return `$ErrorActionPreference='Stop'; $code=$env:RUNLAB_SETUP_CODE; if([string]::IsNullOrWhiteSpace($code)){$code=Read-Host 'Agent RunLab setup code'}; $installer=Join-Path ([IO.Path]::GetTempPath()) ('runlab-bootstrap-'+[guid]::NewGuid()+'.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri ${quotePs(`${origin}/install/assets/install-executor.ps1`)} -OutFile $installer; $claim=Invoke-RestMethod -Method Post -ContentType 'application/json' -Body (@{setupCode=$code}|ConvertTo-Json -Compress) -Uri ${quotePs(`${origin}/install/session`)}; $claim.env.psobject.Properties | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name,[string]$_.Value,'Process') }; & $installer } finally { Remove-Item $installer -Force -ErrorAction SilentlyContinue }`
}
function allowClaimAttempt(attempts: Map<string, { count: number; resetAt: number }>, key: string): boolean {
  const now = Date.now()
  const current = attempts.get(key)
  if (!current || current.resetAt <= now) { attempts.set(key, { count: 1, resetAt: now + 60_000 }); return true }
  if (current.count >= 5) return false
  current.count += 1
  return true
}
function clientAddress(req: IncomingMessage): string { return header(req, 'cf-connecting-ip') ?? header(req, 'x-real-ip') ?? req.socket.remoteAddress ?? 'unknown' }
function requestOrigin(req: IncomingMessage): string { return `${header(req, 'x-forwarded-proto') ?? 'http'}://${header(req, 'x-forwarded-host') ?? req.headers.host ?? 'localhost'}` }
function bearer(req: IncomingMessage): string | undefined { const value = header(req, 'authorization'); return value?.startsWith('Bearer ') ? value.slice(7) : undefined }
function header(req: IncomingMessage, name: string): string | undefined { const value = req.headers[name]; return Array.isArray(value) ? value[0] : value }
function quoteSh(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function quotePs(value: string): string { return `'${value.replaceAll("'", "''")}'` }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
function sendError(res: ServerResponse, status: number, error: string): void { sendJson(res, status, { error }) }
function handleError(res: ServerResponse, error: unknown): void { if (res.writableEnded) return; if (error instanceof ExecutorInstallationError) { sendError(res, error.status, error.message); return } sendError(res, 400, error instanceof Error ? error.message : String(error)) }
async function readJson(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { IdentifierSchema, ReportFormatSchema, principalHasScope, type AuthorizationScope, type Principal } from '@agent-kernel/eval-protocol'

import type { EvaluationControlPlane } from './control-plane.js'
import { AuthorizationError, bindServicePrincipal, requireAuthenticatedPrincipal, requirePrincipal, type Authenticator } from './auth.js'
import { runAsPrincipal } from './principal-context.js'
import type { SecurityRegistryMetadata } from './security-registry.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

const DENY_ALL: Authenticator = { authenticate: () => undefined }

export type AdministrationProvider = {
  securityMetadata?(): SecurityRegistryMetadata
  reloadSecurity?(actorId: string): Promise<SecurityRegistryMetadata>
  maintenanceStatus?(): Promise<unknown>
}

export function createEvaluationHttpServer(controlPlane: EvaluationControlPlane, options: { authenticator?: Authenticator; administration?: AdministrationProvider } = {}): Server {
  const authenticator = options.authenticator ?? DENY_ALL
  return createServer((request, response) => {
    const authorization = request.headers.authorization
    const principal = authenticator.authenticate(Array.isArray(authorization) ? authorization[0] : authorization)
    const operation = () => route(controlPlane, authenticator, request, response, options.administration)
    void (principal ? runAsPrincipal(principal, operation) : operation()).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof AuthorizationError ? error.status : classifyStatus(message)
      if (status === 401) response.setHeader('www-authenticate', 'Bearer realm="agent-evaluation"')
      sendJson(response, status, { code: error instanceof AuthorizationError ? error.code : status === 400 ? 'INVALID_REQUEST' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'INTERNAL_ERROR', message })
    })
  })
}

async function route(controlPlane: EvaluationControlPlane, authenticator: Authenticator, request: IncomingMessage, response: ServerResponse, administration?: AdministrationProvider): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { status: 'ok', authority: 'eval-orchestrator', journalTransactions: controlPlane.projection.transactionCount })
    return
  }
  if (url.pathname.startsWith('/api/v1/')) {
    const header = request.headers.authorization
    requireAuthenticatedPrincipal(authenticator, Array.isArray(header) ? header[0] : header)
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/capabilities') {
    authorize(authenticator, request, 'platform:read')
    sendJson(response, 200, controlPlane.capabilities())
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/administration/status') {
    authorize(authenticator, request, 'admin')
    sendJson(response, 200, { schemaVersion: 1, security: administration?.securityMetadata?.() ?? null, maintenance: await administration?.maintenanceStatus?.() ?? null })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/events') {
    authorize(authenticator, request, 'evaluation:read')
    streamDurableEvents(controlPlane, request, response, url)
    return
  }
  const archiveDocumentMatch = /^\/api\/v1\/archive-documents\/([^/]+)$/u.exec(url.pathname)
  if (request.method === 'GET' && archiveDocumentMatch) {
    authorize(authenticator, request, 'evidence:read')
    const documentId = IdentifierSchema.parse(decodeURIComponent(archiveDocumentMatch[1]!))
    const document = controlPlane.evidenceArchive.document(documentId)
    if (!document) throw new Error('unknown archive document: ' + documentId)
    response.statusCode = 200
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('content-disposition', 'inline; filename="' + document.fileName.replace(/["\r\n]/gu, '-') + '"')
    response.setHeader('cache-control', 'no-store')
    response.end(JSON.stringify(document.content, null, 2) + '\n')
    return
  }
  const artifactMatch = /^\/api\/v1\/artifacts\/([^/]+)$/u.exec(url.pathname)
  if (request.method === 'GET' && artifactMatch) {
    authorize(authenticator, request, 'evidence:read')
    const artifactId = IdentifierSchema.parse(decodeURIComponent(artifactMatch[1]!))
    const trialId = IdentifierSchema.parse(url.searchParams.get('trialId'))
    const trial = controlPlane.projection.trials.get(trialId)
    const entry = trial?.evidence?.artifactManifest.entries.find((candidate) => candidate.artifactId === artifactId)
    if (!entry) throw new Error('unknown artifact for trial')
    sendArtifact(response, await controlPlane.artifactStore.readEntry(entry), entry.classification === 'sensitive' ? 'attachment' : 'inline')
    return
  }
  const analysisArtifactMatch = /^\/api\/v1\/analysis-artifacts\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
  if (request.method === 'GET' && analysisArtifactMatch) {
    authorize(authenticator, request, 'evidence:read')
    const jobId = IdentifierSchema.parse(decodeURIComponent(analysisArtifactMatch[1]!))
    const outputId = IdentifierSchema.parse(decodeURIComponent(analysisArtifactMatch[2]!))
    const output = controlPlane.projection.analysisOutputs.get(jobId)?.outputs.find((candidate) => candidate.outputId === outputId)
    if (!output) throw new Error('unknown analysis artifact')
    sendArtifact(response, await controlPlane.artifactStore.readRegisteredFile({ path: output.artifactRef, mediaType: output.mediaType, bytes: output.bytes, sha256: output.sha256 }), 'inline')
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/v1/artifacts/stage/trial') {
    const leaseId = requiredHeader(request, 'lease-id')
    const lease = controlPlane.projection.leases.get(leaseId)?.lease
    if (!lease) throw new Error('unknown lease: ' + leaseId)
    bindServicePrincipal(authorize(authenticator, request, 'worker:execute'), 'worker', lease.workerId)
    const content = await readBytes(request, MAX_ARTIFACT_BYTES)
    await controlPlane.stageTrialArtifact({ ...artifactHeaders(request), leaseId, commitToken: requiredHeader(request, 'commit-token') }, content)
    sendJson(response, 200, { staged: true })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/v1/artifacts/stage/analysis') {
    const executorId = requiredHeader(request, 'executor-id')
    bindServicePrincipal(authorize(authenticator, request, 'analyzer:execute'), 'analyzer', executorId)
    const content = await readBytes(request, MAX_ARTIFACT_BYTES)
    await controlPlane.stageAnalysisArtifact({ ...artifactHeaders(request), jobId: requiredHeader(request, 'job-id'), executorId }, content)
    sendJson(response, 200, { staged: true })
    return
  }
  const reportMatch = /^\/api\/v1\/reports\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
  if (request.method === 'GET' && reportMatch) {
    authorize(authenticator, request, 'evidence:read')
    const reportId = IdentifierSchema.parse(decodeURIComponent(reportMatch[1]!))
    const format = ReportFormatSchema.parse(decodeURIComponent(reportMatch[2]!))
    const report = controlPlane.projection.reports.get(reportId)
    if (!report) throw new Error('unknown report: ' + reportId)
    sendArtifact(response, await controlPlane.artifactStore.readReport(report, format), format === 'html' || format === 'pdf' ? 'inline' : 'attachment')
    return
  }
  if (request.method !== 'POST') {
    sendJson(response, 404, { code: 'NOT_FOUND', message: 'route not found' })
    return
  }
  const body = await readJson(request)
  switch (url.pathname) {
    case '/api/v1/administration/security/reload': {
      const principal = authorize(authenticator, request, 'admin')
      if (object(body).confirmation !== 'reload-security-registry') throw new Error('security reload requires exact confirmation: reload-security-registry')
      if (!administration?.reloadSecurity) throw new Error('security registry reload is unavailable')
      sendJson(response, 200, await administration.reloadSecurity(principal.principalId))
      return
    }
    case '/api/v1/commands':
      authorizeCommand(authenticator, request, body)
      sendJson(response, 200, await controlPlane.executeCommand(body))
      return
    case '/api/v1/query':
      authorizeQuery(authenticator, request, controlPlane, body)
      sendJson(response, 200, await controlPlane.query(body))
      return
    case '/api/v1/workers/register':
      bindServicePrincipal(authorize(authenticator, request, 'worker:execute'), 'worker', requiredString(body, 'workerId'))
      sendJson(response, 200, await controlPlane.registerWorker(body))
      return
    case '/api/v1/workers/heartbeat': {
      const workerId = requiredString(body, 'workerId')
      bindServicePrincipal(authorize(authenticator, request, 'worker:execute'), 'worker', workerId)
      await controlPlane.heartbeatWorker(workerId)
      sendJson(response, 200, { committed: true })
      return
    }
    case '/api/v1/leases/acquire': {
      const workerId = requiredString(body, 'workerId')
      bindServicePrincipal(authorize(authenticator, request, 'worker:execute'), 'worker', workerId)
      const leaseMs = requiredPositiveInteger(body, 'leaseMs')
      sendJson(response, 200, await controlPlane.issueLease(workerId, leaseMs))
      return
    }
    case '/api/v1/leases/heartbeat': {
      const record = object(body)
      const heartbeat = object(record.heartbeat)
      bindServicePrincipal(authorize(authenticator, request, 'worker:execute'), 'worker', requiredString(heartbeat, 'workerId'))
      const executionReceipt = record.executionReceipt
      if (executionReceipt !== 'none' && executionReceipt !== 'known' && executionReceipt !== 'indeterminate') throw new Error('invalid executionReceipt')
      sendJson(response, 200, await controlPlane.heartbeatLease(heartbeat, executionReceipt))
      return
    }
    case '/api/v1/leases/progress':
      bindServicePrincipal(authorize(authenticator, request, 'worker:execute'), 'worker', requiredString(body, 'workerId'))
      sendJson(response, 200, await controlPlane.progressTrial(body))
      return
    case '/api/v1/leases/expire':
      authorize(authenticator, request, 'evaluation:write')
      sendJson(response, 200, { expired: await controlPlane.expireLeases() })
      return
    case '/api/v1/analysis/expire':
      authorizeAny(authenticator, request, ['analyzer:execute', 'evaluation:write'])
      sendJson(response, 200, { expired: await controlPlane.expireAnalysisJobs() })
      return
    case '/api/v1/results/commit': {
      const leaseId = requiredString(body, 'leaseId')
      const lease = controlPlane.projection.leases.get(leaseId)?.lease
      if (!lease) throw new Error('unknown lease: ' + leaseId)
      bindServicePrincipal(authorize(authenticator, request, 'worker:execute'), 'worker', lease.workerId)
      sendJson(response, 200, await controlPlane.commitTrialResult(body))
      return
    }
    default:
      sendJson(response, 404, { code: 'NOT_FOUND', message: 'route not found' })
  }
}

function authorize(authenticator: Authenticator, request: IncomingMessage, scope: AuthorizationScope): Principal {
  const header = request.headers.authorization
  return requirePrincipal(authenticator, Array.isArray(header) ? header[0] : header, scope)
}

function authorizeCommand(authenticator: Authenticator, request: IncomingMessage, value: unknown): void {
  const type = object(value).type
  if (typeof type !== 'string') throw new Error('command type is required')
  if (['analysis.job.start', 'analysis.job.heartbeat', 'analysis.job.complete', 'analysis.job.fail'].includes(type)) {
    const executorId = requiredString(value, 'executorId')
    bindServicePrincipal(authorize(authenticator, request, 'analyzer:execute'), 'analyzer', executorId)
    return
  }
  const governance = type.startsWith('leaderboard.') || type.startsWith('retention.') || type === 'run.delete' || type.startsWith('insight.') || type.includes('promote')
  authorize(authenticator, request, governance ? 'governance:write' : 'evaluation:write')
}

function queryScope(value: unknown): AuthorizationScope {
  const resource = object(value).resource
  if (resource === 'capabilities' || resource === 'platform-metrics') return 'platform:read'
  if (['artifacts', 'analysis-output', 'reports', 'archive-summary', 'archived-runs', 'archived-run', 'archive-documents', 'archive-document', 'audit'].includes(String(resource))) return 'evidence:read'
  return 'evaluation:read'
}

function authorizeAny(authenticator: Authenticator, request: IncomingMessage, scopes: readonly AuthorizationScope[]): Principal {
  const principal = requireAuthenticatedPrincipal(authenticator, request.headers.authorization)
  if (!scopes.some((scope) => principalHasScope(principal, scope))) throw new AuthorizationError(403, 'FORBIDDEN', 'principal lacks every accepted scope')
  return principal
}

function authorizeQuery(authenticator: Authenticator, request: IncomingMessage, controlPlane: EvaluationControlPlane, value: unknown): void {
  const principal = requireAuthenticatedPrincipal(authenticator, request.headers.authorization)
  const resource = object(value).resource
  if (principal.role !== 'worker') {
    const scope = queryScope(value)
    if (!principalHasScope(principal, scope)) throw new AuthorizationError(403, 'FORBIDDEN', 'principal lacks required scope: ' + scope)
    return
  }
  bindServicePrincipal(principal, 'worker', principal.serviceId!)
  if (!['run', 'trial', 'task'].includes(String(resource))) throw new AuthorizationError(403, 'FORBIDDEN', 'Worker query resource is forbidden')
  const active = [...controlPlane.projection.leases.values()].filter((lease) => lease.state === 'active' && lease.lease.workerId === principal.serviceId)
  const allowed = resource === 'run'
    ? active.some((lease) => lease.lease.runId === object(value).runId)
    : resource === 'trial'
      ? active.some((lease) => lease.lease.trialId === object(value).trialId)
      : active.some((lease) => controlPlane.projection.trials.get(lease.lease.trialId)?.taskId === object(value).taskId)
  if (!allowed) throw new AuthorizationError(403, 'FORBIDDEN', 'Worker query is not bound to an active lease')
}

function streamDurableEvents(controlPlane: EvaluationControlPlane, request: IncomingMessage, response: ServerResponse, url: URL): void {
  const runId = url.searchParams.get('runId')
  if (!runId) throw new Error('runId is required')
  const lastEventId = request.headers['last-event-id']
  let after = Number(url.searchParams.get('after') ?? (typeof lastEventId === 'string' ? lastEventId : '-1'))
  if (!Number.isInteger(after) || after < -1) throw new Error('after must be an integer >= -1')
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const send = () => {
    const run = controlPlane.projection.runs.get(runId)
    if (!run) {
      response.write('event: error\ndata: ' + JSON.stringify({ code: 'NOT_FOUND', message: 'unknown run' }) + '\n\n')
      response.end()
      return
    }
    for (const event of run.events) {
      if (event.sequence <= after) continue
      response.write('id: ' + String(event.sequence) + '\nevent: durable-event\ndata: ' + JSON.stringify(event) + '\n\n')
      after = event.sequence
    }
  }
  send()
  const timer = setInterval(() => {
    send()
    response.write(': keepalive\n\n')
  }, 1_000)
  timer.unref()
  request.once('close', () => clearInterval(timer))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBytes(request, MAX_BODY_BYTES)
  const chunks = body.byteLength === 0 ? [] : [body]
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('request body must be valid JSON') }
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length
    if (bytes > limit) throw new Error('request body exceeds limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function artifactHeaders(request: IncomingMessage): { path: string; mediaType: string; bytes: number; sha256: string } {
  return {
    path: requiredHeader(request, 'artifact-path'), mediaType: requiredHeader(request, 'artifact-media-type'),
    bytes: requiredHeaderInteger(request, 'artifact-bytes'), sha256: requiredHeader(request, 'artifact-sha256'),
  }
}
function requiredHeader(request: IncomingMessage, name: string): string { const value = request.headers['x-agent-eval-' + name]; if (typeof value !== 'string' || !value) throw new Error(name + ' header is required'); return value }
function requiredHeaderInteger(request: IncomingMessage, name: string): number { const value = Number(requiredHeader(request, name)); if (!Number.isSafeInteger(value) || value < 0) throw new Error(name + ' header must be a nonnegative integer'); return value }

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  response.end(body)
}

function sendArtifact(response: ServerResponse, artifact: { path: string; mediaType: string; bytes: number; sha256: string; content: Buffer }, disposition: 'inline' | 'attachment'): void {
  const name = artifact.path.split('/').at(-1)!.replace(/[^A-Za-z0-9._-]/gu, '-')
  response.writeHead(200, { 'content-type': artifact.mediaType, 'content-length': artifact.bytes, etag: '"sha256-' + artifact.sha256 + '"', 'content-disposition': disposition + '; filename="' + name + '"', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' })
  response.end(artifact.content)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, key: string): string {
  const field = object(value)[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(key + ' is required')
  return field
}

function requiredPositiveInteger(value: unknown, key: string): number {
  const field = object(value)[key]
  if (typeof field !== 'number' || !Number.isInteger(field) || field <= 0) throw new Error(key + ' must be a positive integer')
  return field
}

function classifyStatus(message: string): number {
  if (/already exists|collision|conflicting|cannot start|already terminal|not active|mismatch/iu.test(message)) return 409
  if (/unknown |ENOENT/iu.test(message)) return 404
  if (/required|requires|invalid|must |forbidden|exceeds|expected /iu.test(message)) return 400
  return 500
}

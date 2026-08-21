import { createServer, type Server as HttpServer } from 'node:http'
import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'

import { schema, validateClientMessagePayload, validateInlineMessageImages } from '@agent-kernel/shared'
import { authenticateDashboardHandshake, type AuthConfig, type DashboardActor } from '../auth-control.js'
import { createRuntimeUnitIngress } from './runtime-unit-ingress.js'
import { AdmissionBackpressureError, DedicatedAdmissionLedger, type AdmissionMessage } from './dedicated-admission-ledger.js'
import { DEDICATED_RUNTIME_UNIT_ID } from './dedicated-unit.js'
import { readDedicatedRouteState } from './dedicated-slot-state.js'
import { readJsonFile } from './atomic-json-file.js'
import { isDedicatedDashboardRequest, readDashboardRouteState, serveDedicatedDashboard } from './dedicated-dashboard.js'

export type DedicatedIngress = {
  readonly http: HttpServer
  readonly port: number
  readonly unitId: typeof DEDICATED_RUNTIME_UNIT_ID
  readonly origin: string
  close(): Promise<void>
}

/** Stable public ingress for the fixed Dedicated `local` Runtime Unit. */
export async function startDedicatedIngress(options: {
  port: number
  unitOrigin: string
  routeStatePath?: string
  listenHost?: string
  admissionLedgerPath?: string
  admissionCapacity?: number
  ingressHandoffSecret?: string
  candidateStatePath?: string
  operatorStatusPath?: string
  dashboardStatePath?: string
  dashboardReleasesRoot?: string
  auth?: AuthConfig
}): Promise<DedicatedIngress> {
  const ledger = options.admissionLedgerPath ? new DedicatedAdmissionLedger(options.admissionLedgerPath, options.admissionCapacity) : undefined
  const http = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/runtime/admission/messages' && request.method === 'POST' && ledger) {
      void acceptAdmission(request, options.auth, ledger, currentRoute).then((body) => {
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(body))
      }).catch((error) => {
        const status = error instanceof AdmissionBackpressureError ? 429 : error instanceof AdmissionHttpError ? error.status : 400
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(status === 429 ? { 'retry-after': '2' } : {}) })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
      return
    }
    if (path === '/runtime/admission/status' && request.method === 'GET' && ledger) {
      const auth = ingressActor(request, options.auth)
      if (!auth.ok) { response.writeHead(401).end(); return }
      void ledger.snapshot().then((snapshot) => { response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(snapshot)) })
      return
    }
    if (path === '/runtime/deployment/status' && request.method === 'GET' && options.operatorStatusPath) {
      const auth = ingressActor(request, options.auth)
      if (!auth.ok) { response.writeHead(401).end(); return }
      void Promise.all([readJsonFile<Record<string, unknown>>(options.operatorStatusPath), options.dashboardStatePath ? readDashboardRouteState(options.dashboardStatePath) : undefined]).then(([status, dashboard]) => {
        if (!status) { response.writeHead(404).end(); return }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ ...status, ...(dashboard ? { dashboard } : {}) }))
      }).catch(() => response.writeHead(503).end())
      return
    }
    if (path === '/runtime/dashboard/status' && request.method === 'GET' && options.dashboardStatePath) {
      void readDashboardRouteState(options.dashboardStatePath).then((status) => {
        if (!status) { response.writeHead(404).end(); return }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(status))
      }).catch(() => response.writeHead(503).end())
      return
    }
    if (options.dashboardStatePath && options.dashboardReleasesRoot && isDedicatedDashboardRequest(request)) {
      void serveDedicatedDashboard({ request, response, statePath: options.dashboardStatePath, releasesRoot: options.dashboardReleasesRoot }).then((served) => {
        if (!served && !response.writableEnded) response.writeHead(503).end('dashboard unavailable')
      }).catch(() => { if (!response.headersSent) response.writeHead(503).end('dashboard unavailable') })
      return
    }
    if ((request.url ?? '/').startsWith('/internal/')) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'NOT_FOUND' }))
    }
  })
  // Stable Ingress carries long-lived Browser and Executor sockets. Node's
  // http.close() deliberately waits for upgraded and incomplete connections,
  // so a systemd stop would otherwise reach TimeoutStopSec and SIGKILL the
  // process. Track every accepted transport and explicitly disconnect it once
  // the listener has stopped accepting new work. Clients reconnect through the
  // same stable address after the process returns.
  const transports = new Set<Socket>()
  const trackTransport = (socket: Socket): void => {
    transports.add(socket)
    socket.once('close', () => transports.delete(socket))
  }
  http.on('connection', trackTransport)
  let cachedOrigin = options.unitOrigin
  let cachedGeneration = 0
  const currentRoute = async (): Promise<{ origin: string; generation: number }> => {
    await resolveOrigin()
    return { origin: cachedOrigin, generation: cachedGeneration }
  }
  const resolveOrigin = async (): Promise<string> => {
    if (!options.routeStatePath) return options.unitOrigin
    try {
      const state = await readDedicatedRouteState(options.routeStatePath)
      if (state.generation >= cachedGeneration) {
        cachedGeneration = state.generation
        cachedOrigin = state.slots[state.activeSlot].origin
      }
    } catch {
      // Keep the last valid route. A partial or missing file must never route
      // traffic to an unverified candidate.
    }
    return cachedOrigin
  }
  const ingress = createRuntimeUnitIngress({
    isRoutableRequest: (request) => !(request.url ?? '/').startsWith('/internal/') && !(request.url ?? '/').startsWith('/runtime/admission/') && !(request.url ?? '/').startsWith('/runtime/deployment/') && !(request.url ?? '/').startsWith('/runtime/dashboard/') && !(options.dashboardStatePath && options.dashboardReleasesRoot && isDedicatedDashboardRequest(request)),
    resolve: async () => ({ unitId: DEDICATED_RUNTIME_UNIT_ID, origin: await resolveOrigin() }),
    resolveUpgrade: async () => {
      const route = await currentRoute()
      const handoff = options.candidateStatePath ? await readCandidateState(options.candidateStatePath, route.generation) : undefined
      if (handoff?.phase === 'paused') return undefined
      return { unitId: DEDICATED_RUNTIME_UNIT_ID, origin: handoff?.origin ?? route.origin }
    },
  })
  ingress.attach(http)
  let reconciling = false
  const reconcileAdmission = async (): Promise<void> => {
    if (!ledger || reconciling || !options.ingressHandoffSecret) return
    reconciling = true
    const owner = `ingress-${process.pid}`
    try {
      while (true) {
        const route = await currentRoute()
        const handoff = options.candidateStatePath ? await readCandidateState(options.candidateStatePath, route.generation) : undefined
        if (handoff?.phase === 'paused' || handoff?.phase === 'candidate') return
        const handoffOrigin = handoff?.origin ?? route.origin
        const record = await ledger.leaseNext(owner, route.generation)
        if (!record) return
        try {
          const response = await fetch(`${handoffOrigin}/internal/runtime/admission/commit`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': options.ingressHandoffSecret },
            body: JSON.stringify({ sessionId: record.sessionId, operationId: record.operationId, text: record.text, mode: record.mode, ...(record.content ? { content: record.content } : {}) }),
            signal: AbortSignal.timeout(5000),
          })
          if (!response.ok) throw new Error(`runtime admission commit returned ${response.status}`)
          const outcome = await response.json() as { committed?: boolean; cursor?: number }
          if (outcome.committed !== true || !Number.isSafeInteger(outcome.cursor) || (outcome.cursor ?? -1) < 1) {
            await ledger.release(record.operationId, owner)
            return
          }
          // Runtime has durably deduplicated operationId before responding. If
          // an earlier Ingress process died after that response but before the
          // ledger rename, the restarted process may own the reclaimed lease;
          // the Runtime acknowledgement is still authoritative.
          await ledger.committed(record.operationId, route.generation, outcome.cursor)
        } catch (error) {
          await ledger.release(record.operationId, owner, error instanceof Error ? error.message : String(error))
          return
        }
      }
    } finally { reconciling = false }
  }
  const reconciliationTimer = setInterval(() => { void reconcileAdmission() }, 250)
  reconciliationTimer.unref()
  void reconcileAdmission()
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.listenHost ?? '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  return {
    http,
    port: typeof address === 'object' && address ? address.port : options.port,
    unitId: DEDICATED_RUNTIME_UNIT_ID,
    origin: options.unitOrigin,
    async close() {
      clearInterval(reconciliationTimer)
      ingress.close()
      const closed = new Promise<void>((resolve, reject) => {
        http.close((error) => error ? reject(error) : resolve())
      })
      for (const transport of transports) transport.destroy()
      await closed
      http.off('connection', trackTransport)
    },
  }
}

class AdmissionHttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }

async function acceptAdmission(
  request: import('node:http').IncomingMessage,
  auth: AuthConfig | undefined,
  ledger: DedicatedAdmissionLedger,
  route: () => Promise<{ origin: string; generation: number }>,
): Promise<unknown> {
  const authenticated = ingressActor(request, auth)
  if (!authenticated.ok) throw new AdmissionHttpError(401, authenticated.reason)
  const body = await readRequestJson(request)
  const payloadError = validateClientMessagePayload(body)
  if (payloadError) throw new AdmissionHttpError(413, `${payloadError.code}: ${payloadError.message}`)
  const parsed = schema.ClientUserMessageSchema.safeParse(body)
  if (!parsed.success) throw new AdmissionHttpError(400, 'invalid admission message')
  const imageValidation = validateInlineMessageImages(parsed.data.content)
  if (!imageValidation.ok) throw new AdmissionHttpError(400, `${imageValidation.error.code}: ${imageValidation.error.message}`)
  const message: AdmissionMessage = {
    schemaVersion: 1, principalDigest: principalDigest(authenticated.actor), unitId: 'local',
    sessionId: parsed.data.sessionId, operationId: required(parsed.data.operationId, 'operationId'),
    mode: parsed.data.mode === 'queue' ? 'queue' : 'steer', text: parsed.data.text,
    ...(parsed.data.content ? { content: parsed.data.content } : {}),
  }
  const active = await route()
  const result = await ledger.append(message, active.generation)
  return { accepted: true, duplicate: result.duplicate, operationId: result.record.operationId, sequence: result.record.sequence, state: result.record.state, routeGeneration: result.record.routeGeneration }
}

function ingressActor(request: import('node:http').IncomingMessage, auth: AuthConfig | undefined): ReturnType<typeof authenticateDashboardHandshake> {
  const authorization = request.headers.authorization
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined
  return authenticateDashboardHandshake({ role: 'dashboard', clientVersion: 'ingress', ...(token ? { token } : {}) }, request, auth)
}
function principalDigest(actor: DashboardActor): string { return createHash('sha256').update(JSON.stringify(actor)).digest('hex') }
async function readCandidateState(path: string, expectedGeneration: number): Promise<{ phase: 'paused' } | { phase: 'candidate' | 'admission'; origin: string } | undefined> {
  const state: { schemaVersion: number; expectedRouteGeneration: number; phase: unknown; origin?: unknown } | undefined = await readJsonFile<{ schemaVersion: number; expectedRouteGeneration: number; phase: unknown; origin?: unknown }>(path)
    .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT'
      ? undefined
      : { schemaVersion: 1, expectedRouteGeneration: expectedGeneration, phase: 'paused', origin: undefined })
  if (!state || state.expectedRouteGeneration !== expectedGeneration) return undefined
  if (state.schemaVersion !== 1 || state.phase === 'paused') return { phase: 'paused' }
  if ((state.phase !== 'candidate' && state.phase !== 'admission') || typeof state.origin !== 'string' || !isLoopbackOrigin(state.origin)) return { phase: 'paused' }
  return { phase: state.phase, origin: state.origin }
}
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const port = Number(url.port)
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && Number.isSafeInteger(port)
      && port >= 1
      && port <= 65_535
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}
function required(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value.trim() }
async function readRequestJson(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 8 * 1024 * 1024) throw new AdmissionHttpError(413, 'admission payload too large'); chunks.push(bytes) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

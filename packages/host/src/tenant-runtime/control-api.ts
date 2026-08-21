import type { Server as HttpServer } from 'node:http'
import { join } from 'node:path'

import type { RuntimeCapabilities } from '@agent-kernel/shared'

import { parseTenantRuntimeUnitId } from './unit.js'
import type { RuntimeUnitMaterializationStore } from './materialization-store.js'
import type { TenantRuntimeService } from './service.js'

export function attachTenantRuntimeControlApi(options: {
  http: HttpServer
  serviceSecret: string
  service: TenantRuntimeService
  store: RuntimeUnitMaterializationStore
  dataRoot: string
  capabilities: RuntimeCapabilities
}): void {
  options.http.prependListener('request', (request, response) => {
    if (!(request.url ?? '').startsWith('/internal/')) return
    const supplied = request.headers['x-agent-runlab-ingress-secret']
    if (typeof supplied !== 'string' || supplied !== options.serviceSecret) { response.writeHead(403); response.end(); return }
    if (request.url === '/internal/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, ...options.service.status() })); return
    }
    if (request.url !== '/internal/runtime-units' || request.method !== 'POST') { response.writeHead(404); response.end(); return }
    let raw = ''; let oversized = false
    request.setTimeout(5_000, () => request.destroy())
    request.on('data', (chunk) => { raw += String(chunk); if (Buffer.byteLength(raw) > 16_384) { oversized = true; request.destroy() } })
    request.on('end', () => { void applyCommand(raw, oversized, options).then((result) => {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    }).catch((error) => { if (!response.headersSent) response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })) }) })
  })
}

async function applyCommand(raw: string, oversized: boolean, options: Parameters<typeof attachTenantRuntimeControlApi>[0]): Promise<unknown> {
  if (oversized) throw new Error('request body too large')
  const input = JSON.parse(raw) as { unitId: string; operationId: string; generation: number; action?: 'provision' | 'suspend' | 'resume' | 'delete' }
  if (!input.operationId || input.operationId.length > 200 || !Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error('invalid provisioning request')
  const unitId = parseTenantRuntimeUnitId(input.unitId); const action = input.action ?? 'provision'
  if (action === 'delete') { await options.service.suspendUnit(unitId); await options.store.remove(unitId, input.operationId, input.generation) }
  else {
    const desiredState = action === 'suspend' ? 'suspended' : 'ready'
    await options.store.apply({ schemaVersion: 1, unitId, routingKeyDigest: '', routingKeyVersion: 1, generation: input.generation, desiredState, dataRoot: join(options.dataRoot, 'tenant-runtime-units', unitId), capabilities: options.capabilities, lastOperationId: input.operationId, updatedAt: new Date().toISOString() })
    if (desiredState === 'ready') options.service.markRoutable(unitId); else await options.service.suspendUnit(unitId)
  }
  return { ok: true, unitId, action }
}

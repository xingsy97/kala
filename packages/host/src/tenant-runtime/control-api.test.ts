import { createServer, request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'
import { RuntimeUnitMaterializationStore } from './materialization-store.js'
import { attachTenantRuntimeControlApi } from './control-api.js'
import type { TenantRuntimeService } from './service.js'
const roots: string[] = []; const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'control-api-')); roots.push(root); const http = createServer(); servers.push(http)
  const service = { http, port: 0, units: {} as never, status: () => ({ state: 'ready' as const, units: [] }), drain: vi.fn(), markRoutable: vi.fn(), suspendUnit: vi.fn(), close: vi.fn() } satisfies TenantRuntimeService
  const store = new RuntimeUnitMaterializationStore(join(root, 'catalog.json')); attachTenantRuntimeControlApi({ http, serviceSecret: 'secret', service, store, dataRoot: root, capabilities: AGENT_RUNTIME_CAPABILITIES })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r)); const port = (http.address() as { port: number }).port
  return { root, port, service, store }
}
async function call(port: number, path: string, body?: unknown, authenticated = false): Promise<number> {
  return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers: { ...(authenticated ? { 'x-agent-runlab-ingress-secret': 'secret' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end() })
}
describe('tenant runtime control API', () => {
  it('fails closed without service authentication', async () => { const { port } = await setup(); expect(await call(port, '/internal/health')).toBe(403) })
  it('applies generation-checked provision and suspend commands', async () => {
    const { port, service, store } = await setup(); const command = async (body: unknown) => call(port, '/internal/runtime-units', body, true)
    expect(await command({ unitId: 'a', operationId: 'p1', generation: 1 })).toBe(200); expect(service.markRoutable).toHaveBeenCalledWith('a'); expect(store.list()).toHaveLength(1)
    expect(await command({ unitId: 'a', operationId: 's2', generation: 2, action: 'suspend' })).toBe(200); expect(service.suspendUnit).toHaveBeenCalledWith('a')
    expect(await command({ unitId: 'a', operationId: 'stale', generation: 1 })).toBe(400)
  })
})

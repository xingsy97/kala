import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'

import { createRuntimeUnitIngress, type RuntimeUnitIngress } from './runtime-unit-ingress.js'
import { TenantRuntimeUnitRegistry, parseTenantRuntimeUnitId, type TenantRuntimeUnit, type TenantRuntimeUnitFactory } from './unit.js'

export type TenantRuntimeService = {
  readonly http: HttpServer
  readonly port: number
  readonly units: TenantRuntimeUnitRegistry
  status(): { state: 'ready' | 'draining' | 'closed'; units: readonly { id: string; state: string; origin: string }[] }
  drain(): Promise<void>
  markRoutable(unitId: string): void
  suspendUnit(unitId: string): Promise<void>
  close(): Promise<void>
}

export async function startTenantRuntimeService(options: {
  port: number
  factory: TenantRuntimeUnitFactory
  resolveUnitId(request: IncomingMessage): string | undefined | Promise<string | undefined>
  /** Required in Private Cloud: service credential shared only with the trusted Gateway. */
  ingressSecret?: string
  listenHost?: string
  requireProvisioning?: boolean
  maxLoadedUnits?: number
}): Promise<TenantRuntimeService> {
  const units = new TenantRuntimeUnitRegistry(options.factory, options.maxLoadedUnits)
  const allowedUnits = new Set<string>()
  const http = createServer()
  const router: RuntimeUnitIngress = createRuntimeUnitIngress({
    isRoutableRequest: (request) => !(request.url ?? '/').startsWith('/internal/'),
    resolve: async (request) => {
      if (options.ingressSecret) {
        const supplied = request.headers['x-agent-runlab-ingress-secret']
        if (typeof supplied !== 'string' || !sameSecret(supplied, options.ingressSecret)) return undefined
      }
      const rawId = await options.resolveUnitId(request)
      if (!rawId) return undefined
      if (options.requireProvisioning && !allowedUnits.has(rawId)) return undefined
      let unit: TenantRuntimeUnit
      try {
        unit = await units.getOrLoad(parseTenantRuntimeUnitId(rawId))
      } catch {
        return undefined
      }
      if (unit.state !== 'ready') return undefined
      return { unitId: unit.id, origin: unit.origin }
    },
  })
  router.attach(http)
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.listenHost ?? '127.0.0.1', () => { http.off('error', reject); resolve() })
  })
  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  let state: 'ready' | 'draining' | 'closed' = 'ready'
  return {
    http,
    port,
    units,
    status: () => ({ state, units: units.list().map((unit) => ({ id: unit.id, state: unit.state, origin: unit.origin })) }),
    async drain() {
      if (state !== 'ready') return
      state = 'draining'
      await units.drainAll()
    },
    markRoutable(rawId) {
      allowedUnits.add(parseTenantRuntimeUnitId(rawId))
    },
    async suspendUnit(rawId) {
      allowedUnits.delete(rawId)
      await units.close(parseTenantRuntimeUnitId(rawId))
    },
    async close() {
      if (state === 'closed') return
      state = 'closed'
      router.close()
      await units.closeAll()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

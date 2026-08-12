import { createServer, type Server as HttpServer } from 'node:http'

import { createRuntimeUnitIngress } from './runtime-unit-ingress.js'
import { STANDALONE_RUNTIME_UNIT_ID } from './standalone-unit.js'

export type StandaloneIngress = {
  readonly http: HttpServer
  readonly port: number
  readonly unitId: typeof STANDALONE_RUNTIME_UNIT_ID
  readonly origin: string
  close(): Promise<void>
}

/** Stable public ingress for the fixed Standalone `local` Runtime Unit. */
export async function startStandaloneIngress(options: {
  port: number
  unitOrigin: string
  listenHost?: string
}): Promise<StandaloneIngress> {
  const http = createServer((request, response) => {
    if ((request.url ?? '/').startsWith('/internal/')) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'NOT_FOUND' }))
    }
  })
  const ingress = createRuntimeUnitIngress({
    isRoutableRequest: (request) => !(request.url ?? '/').startsWith('/internal/'),
    resolve: () => ({ unitId: STANDALONE_RUNTIME_UNIT_ID, origin: options.unitOrigin }),
  })
  ingress.attach(http)
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
    unitId: STANDALONE_RUNTIME_UNIT_ID,
    origin: options.unitOrigin,
    async close() {
      ingress.close()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

import process from 'node:process'

import { startStandaloneIngress } from '../src/tenant-runtime/standalone-ingress.js'

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid port`)
  return value
}

async function main(): Promise<void> {
  const publicPort = port('AGENT_RUNLAB_INGRESS_PORT', 13000)
  const unitPort = port('AGENT_RUNLAB_UNIT_PORT', 13001)
  const unitHost = process.env.AGENT_RUNLAB_UNIT_HOST?.trim() || '127.0.0.1'
  const ingress = await startStandaloneIngress({
    port: publicPort,
    listenHost: process.env.AGENT_RUNLAB_INGRESS_HOST?.trim() || '0.0.0.0',
    unitOrigin: `http://${unitHost}:${unitPort}`,
    ...(process.env.AGENT_RUNLAB_ROUTE_STATE?.trim() ? { routeStatePath: process.env.AGENT_RUNLAB_ROUTE_STATE.trim() } : {}),
  })
  process.stdout.write(`${JSON.stringify({ event: 'standalone_ingress_ready', port: ingress.port, unitId: ingress.unitId })}\n`)
  const close = async (): Promise<void> => { await ingress.close(); process.exit(0) }
  process.on('SIGTERM', () => { void close() })
  process.on('SIGINT', () => { void close() })
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})

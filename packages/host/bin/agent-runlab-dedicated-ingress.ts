import process from 'node:process'
import { rm } from 'node:fs/promises'

import { startDedicatedIngress } from '../src/tenant-runtime/dedicated-ingress.js'
import type { AuthConfig } from '../src/auth-control.js'
import { writeJsonFile } from '../src/tenant-runtime/atomic-json-file.js'

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid port`)
  return value
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

async function main(): Promise<void> {
  const publicPort = port('AGENT_RUNLAB_INGRESS_PORT', 13000)
  const unitPort = port('AGENT_RUNLAB_UNIT_PORT', 13001)
  const unitHost = process.env.AGENT_RUNLAB_UNIT_HOST?.trim() || '127.0.0.1'
  const ingress = await startDedicatedIngress({
    port: publicPort,
    listenHost: process.env.AGENT_RUNLAB_INGRESS_HOST?.trim() || '0.0.0.0',
    unitOrigin: `http://${unitHost}:${unitPort}`,
    ...(process.env.AGENT_RUNLAB_ROUTE_STATE?.trim() ? { routeStatePath: process.env.AGENT_RUNLAB_ROUTE_STATE.trim() } : {}),
    ...(process.env.AGENT_RUNLAB_ADMISSION_LEDGER?.trim() ? { admissionLedgerPath: process.env.AGENT_RUNLAB_ADMISSION_LEDGER.trim() } : {}),
    ...(process.env.AGENT_RUNLAB_ADMISSION_CAPACITY ? { admissionCapacity: positiveInteger('AGENT_RUNLAB_ADMISSION_CAPACITY', 1000) } : {}),
    ...(process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET?.trim() ? { ingressHandoffSecret: process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET.trim() } : {}),
    ...(process.env.AGENT_RUNLAB_CANDIDATE_STATE?.trim() ? { candidateStatePath: process.env.AGENT_RUNLAB_CANDIDATE_STATE.trim() } : {}),
    ...(process.env.AGENT_RUNLAB_OPERATOR_STATUS?.trim() ? { operatorStatusPath: process.env.AGENT_RUNLAB_OPERATOR_STATUS.trim() } : {}),
    ...(process.env.AGENT_RUNLAB_DEPLOYMENT_REQUESTS?.trim() ? { deploymentRequestsPath: process.env.AGENT_RUNLAB_DEPLOYMENT_REQUESTS.trim() } : {}),
    ...(process.env.AGENT_RUNLAB_DASHBOARD_STATE?.trim() ? { dashboardStatePath: process.env.AGENT_RUNLAB_DASHBOARD_STATE.trim() } : {}),
    ...(process.env.AGENT_RUNLAB_DASHBOARD_RELEASES?.trim() ? { dashboardReleasesRoot: process.env.AGENT_RUNLAB_DASHBOARD_RELEASES.trim() } : {}),
    auth: ingressAuth(),
  })
  const readinessPath = process.env.AGENT_RUNLAB_INGRESS_READINESS?.trim()
  if (readinessPath) await writeJsonFile(readinessPath, { schemaVersion: 1, pid: process.pid, readyAt: new Date().toISOString() }, 0o644)
  process.stdout.write(`${JSON.stringify({ event: 'dedicated_ingress_ready', port: ingress.port, unitId: ingress.unitId })}\n`)
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (readinessPath) await rm(readinessPath, { force: true }).catch(() => undefined)
      await ingress.close()
      // http-proxy can retain internal upstream handles after every public
      // listener and tracked transport has been closed. `exitCode` alone waits
      // for those implementation-detail handles and lets systemd's stop timer
      // expire. At this point admission reconciliation is stopped, the public
      // listener is closed, and all accepted transports are destroyed, so the
      // graceful boundary is complete and the process may terminate cleanly.
      process.exit(0)
    })()
    return closing
  }
  process.on('SIGTERM', () => { void close() })
  process.on('SIGINT', () => { void close() })
}

function ingressAuth(): AuthConfig | undefined {
  const sharedToken = process.env.HOST_AUTH_TOKEN?.trim()
  const githubRequired = process.env.HOST_GITHUB_OAUTH_REQUIRED === '1'
  if (!sharedToken && !githubRequired) return undefined
  return {
    ...(sharedToken ? { sharedToken } : {}),
    ...(githubRequired ? { github: { required: true, ...(process.env.HOST_AUTH_SESSION_SECRET ? { sessionSecret: process.env.HOST_AUTH_SESSION_SECRET } : {}), usernameWhitelist: (process.env.GITHUB_USERNAME_WHITELIST ?? '').split(',').map((value) => value.trim()).filter(Boolean) } } : {}),
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})

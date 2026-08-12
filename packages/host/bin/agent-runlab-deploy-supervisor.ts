import { createHash } from 'node:crypto'
import { readdir, readFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

import { StandaloneDeploySupervisor } from '../src/tenant-runtime/deploy-supervisor.js'
import type { UnitQuiescence } from '../src/tenant-runtime/quiescence.js'

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function main(): Promise<void> {
  const root = resolve(process.env.AGENT_RUNLAB_DEPLOY_ROOT ?? '/var/lib/agent-runlab/deploy')
  const unitOrigin = (process.env.AGENT_RUNLAB_UNIT_ORIGIN ?? 'http://127.0.0.1:13001').replace(/\/$/u, '')
  const unitService = process.env.AGENT_RUNLAB_UNIT_SERVICE ?? 'user4@example.com'
  const pollMs = positive(process.env.AGENT_RUNLAB_DEPLOY_POLL_MS, 1000)
  const ingressService = process.env.AGENT_RUNLAB_INGRESS_SERVICE ?? 'agent-runlab-ingress.service'
  const supervisor = new StandaloneDeploySupervisor(root, {
    inspectQuiescence: async () => await fetchJson<UnitQuiescence>(`${unitOrigin}/internal/runtime/quiescence`),
    reserveCutover: async () => await postJson<UnitQuiescence>(`${unitOrigin}/internal/runtime/cutover/reserve`),
    stopIngress: async () => await systemctl('stop', ingressService),
    startIngress: async () => await systemctl('start', ingressService),
    restartUnit: async () => await systemctl('restart', unitService),
    verifyUnit: async (expectedSha256) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        try {
          const capabilities = await fetchJson<{ mode: string; capabilities: { operations: boolean; pipeline: boolean } }>(`${unitOrigin}/runtime/capabilities`)
          if (capabilities.mode !== 'standalone' || !capabilities.capabilities.operations || !capabilities.capabilities.pipeline) throw new Error('Standalone capability profile mismatch')
          const currentBundle = join(root, 'current', 'bundle-dashboard-with-runtime.cjs')
          const actual = createHash('sha256').update(await readFile(currentBundle)).digest('hex')
          if (actual !== expectedSha256) throw new Error('active bundle digest mismatch')
          return { pid: Number((await systemctlOutput('show', '--property=MainPID', '--value', unitService)).trim()) }
        } catch {
          await sleep(250)
        }
      }
      throw new Error('Unit verification timed out')
    },
  })
  let stopping = false
  process.on('SIGTERM', () => { stopping = true })
  process.on('SIGINT', () => { stopping = true })
  process.stdout.write(`${JSON.stringify({ event: 'deploy_supervisor_ready' })}\n`)
  while (!stopping) {
    await reconcileRequests(root, supervisor).catch((error) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`))
    await sleep(pollMs)
  }
}

async function reconcileRequests(root: string, supervisor: StandaloneDeploySupervisor): Promise<void> {
  const requests = join(root, 'requests')
  const names = await readdir(requests).catch(() => [])
  for (const name of names.filter((entry) => entry.endsWith('.json') || entry.endsWith('.json.accepted')).sort()) {
    const path = join(requests, name)
    const input = JSON.parse(await readFile(path, 'utf8')) as { operationId: string; releaseDir: string; expectedSha256: string; deploymentId?: string }
    const acceptedPath = name.endsWith('.accepted') ? path : `${path}.accepted`
    const staged = input.deploymentId ? null : await supervisor.stage(input)
    if (staged) {
      await rename(path, acceptedPath)
      input.deploymentId = staged.deploymentId
      await writeRequestState(acceptedPath, input)
    }
    const receipt = await supervisor.reconcile(input.deploymentId!)
    if (receipt.phase === 'completed' || receipt.phase === 'rolled_back' || receipt.phase === 'failed') {
      await rename(acceptedPath, `${acceptedPath}.${receipt.phase}`)
    }
  }
}

async function writeRequestState(path: string, value: unknown): Promise<void> {
  await import('node:fs/promises').then((fs) => fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }))
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return await response.json() as T
}

async function postJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`)
  return await response.json() as T
}

async function systemctl(...args: string[]): Promise<void> {
  await command('/usr/bin/systemctl', args)
}

async function systemctlOutput(...args: string[]): Promise<string> {
  return await command('/usr/bin/systemctl', args, true)
}

async function command(file: string, args: string[], capture = false): Promise<string> {
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(file, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let stdout = ''; let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveCommand(stdout) : reject(new Error(`${file} exited ${String(code)}: ${stderr}`)))
  })
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error('poll interval must be positive')
  return value
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

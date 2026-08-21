import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { rollbackDedicatedData } from './dedicated-data-migration.mjs'

const dataRoot = resolve(process.env.AGENT_RUNLAB_DATA_ROOT ?? '/var/lib/agent-runlab')
const legacyService = process.env.AGENT_RUNLAB_LEGACY_SERVICE ?? 'agent-runlab-host.service'
const receiptPath = join(dataRoot, 'deploy', 'migration-receipt.json')
const services = ['agent-runlab-dedicated-control-updater.service', 'agent-runlab-dedicated-deploy-supervisor.service', 'agent-runlab-dedicated-ingress.service', 'agent-runlab-dedicated-unit@blue.service', 'agent-runlab-dedicated-unit@green.service']
const enabledServices = ['agent-runlab-dedicated-deploy-supervisor.service', 'agent-runlab-dedicated-ingress.service', 'agent-runlab-dedicated-unit@blue.service', 'agent-runlab-dedicated-unit@green.service']
const phases = ['cutover_completed', 'manual_rollback_started', 'manual_services_stopped', 'manual_data_restored', 'manually_rolled_back', 'manual_rollback_failed']
const transitions = new Map([
  ['cutover_completed', new Set(['manual_rollback_started'])],
  ['manual_rollback_started', new Set(['manual_services_stopped', 'manual_rollback_failed'])],
  ['manual_services_stopped', new Set(['manual_data_restored', 'manual_rollback_failed'])],
  ['manual_data_restored', new Set(['manually_rolled_back', 'manual_rollback_failed'])],
  ['manually_rolled_back', new Set()], ['manual_rollback_failed', new Set()],
])

async function main() {
  let receipt = await loadReceipt()
  if (!phases.includes(receipt.phase) || !receipt.migration) throw new Error('completed migration receipt with data move is required')
  if (receipt.phase === 'manually_rolled_back') return
  if (receipt.phase === 'manual_rollback_failed') throw new Error('manual rollback previously failed; fail closed until data ownership is repaired')
  try {
    if (receipt.phase === 'cutover_completed') receipt = await transition(receipt, 'manual_rollback_started', { manualRollbackStartedAt: new Date().toISOString() })
    if (receipt.phase === 'manual_rollback_started') {
      for (const service of services) await systemctl('stop', service).catch(() => undefined)
      for (const service of enabledServices) await systemctl('disable', service)
      receipt = await transition(receipt, 'manual_services_stopped', { manualServicesStoppedAt: new Date().toISOString() })
    }
    if (receipt.phase === 'manual_services_stopped') {
      await rollbackDedicatedData(receipt.migration)
      receipt = await transition(receipt, 'manual_data_restored', { manualDataRestoredAt: new Date().toISOString() })
    }
    if (receipt.phase === 'manual_data_restored') {
      await systemctl('enable', '--now', legacyService)
      await waitFor('http://127.0.0.1:13000/runtime/capabilities')
      receipt = await transition(receipt, 'manually_rolled_back', { manuallyRolledBackAt: new Date().toISOString() })
    }
  } catch (error) {
    const durable = await loadReceipt().catch(() => receipt)
    if (transitions.get(durable.phase)?.has('manual_rollback_failed')) {
      await transition(durable, 'manual_rollback_failed', { rollbackFailure: redactedError(error), manualRollbackFailedAt: new Date().toISOString() })
    }
    throw error
  }
}
async function waitFor(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) return } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error('legacy service did not recover')
}
async function loadReceipt() {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt?.schemaVersion !== 1 || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) throw new Error('invalid migration receipt')
  return receipt
}
async function transition(receipt, phase, patch = {}) {
  if (!transitions.get(receipt.phase)?.has(phase)) throw new Error(`invalid manual rollback transition: ${receipt.phase} -> ${phase}`)
  const durable = await loadReceipt()
  if (durable.revision !== receipt.revision || durable.phase !== receipt.phase || durable.releaseId !== receipt.releaseId) throw new Error('migration receipt changed before manual rollback transition')
  const next = { ...receipt, ...patch, phase, revision: receipt.revision + 1, updatedAt: new Date().toISOString() }
  await writeAtomicJson(receiptPath, next)
  return next
}
async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
    await rename(temp, path)
    const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temp, { force: true }).catch(() => undefined) }
}
async function systemctl(...args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn('systemctl', args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`systemctl exited ${String(code)}`)))
  })
}
function redactedError(error) {
  return { message: (error instanceof Error ? error.message : String(error)).replaceAll(/(?:[A-Za-z]:)?[\/][^\s;]+/gu, '<path>').slice(0, 1000), at: new Date().toISOString() }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

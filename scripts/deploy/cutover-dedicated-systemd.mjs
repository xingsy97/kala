import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { executeDedicatedDataMigration, planDedicatedDataMigration, probeDedicatedAtomicRename, rollbackDedicatedData } from './dedicated-data-migration.mjs'
import { dedicatedSettingsFingerprint } from './dedicated-settings-fingerprint.mjs'

const dataRoot = resolve(process.env.AGENT_RUNLAB_DATA_ROOT ?? '/var/lib/agent-runlab')
const legacyService = process.env.AGENT_RUNLAB_LEGACY_SERVICE ?? 'agent-runlab-host.service'
const activeUnitService = 'agent-runlab-dedicated-unit@blue.service'
const services = [activeUnitService, 'agent-runlab-dedicated-ingress.service', 'agent-runlab-dedicated-deploy-supervisor.service']
const rollbackServices = [...services, 'agent-runlab-dedicated-control-updater.service']
const receiptPath = join(dataRoot, 'deploy', 'migration-receipt.json')
const forwardPhases = [
  'installed_disabled', 'boundary_reserved', 'legacy_stopped', 'data_migration_planned', 'data_migrated',
  'unit_started', 'ingress_started', 'supervisor_started', 'services_enabled', 'legacy_disabled', 'cutover_completed',
]
const rollbackPhases = ['rollback_started', 'rollback_services_stopped', 'rollback_data_restored', 'rolled_back']
const phaseTransitions = new Map([
  ['installed_disabled', new Set(['boundary_reserved', 'rollback_started'])],
  ['boundary_reserved', new Set(['legacy_stopped', 'rollback_started'])],
  ['legacy_stopped', new Set(['data_migration_planned', 'rollback_started'])],
  ['data_migration_planned', new Set(['data_migrated', 'rollback_started'])],
  ['data_migrated', new Set(['unit_started', 'rollback_started'])],
  ['unit_started', new Set(['ingress_started', 'rollback_started'])],
  ['ingress_started', new Set(['supervisor_started', 'rollback_started'])],
  ['supervisor_started', new Set(['services_enabled', 'rollback_started'])],
  ['services_enabled', new Set(['legacy_disabled', 'rollback_started'])],
  ['legacy_disabled', new Set(['cutover_completed', 'rollback_started'])],
  ['rollback_started', new Set(['rollback_services_stopped', 'rollback_failed'])],
  ['rollback_services_stopped', new Set(['rollback_data_restored', 'rollback_failed'])],
  ['rollback_data_restored', new Set(['rolled_back', 'rollback_failed'])],
  ['cutover_completed', new Set()], ['rolled_back', new Set()], ['rollback_failed', new Set()],
])

async function main() {
  let receipt = await loadReceipt()
  if (receipt.phase === 'cutover_completed' || receipt.phase === 'rolled_back') {
    process.stdout.write(`${JSON.stringify({ ok: true, phase: receipt.phase })}\n`)
    return
  }
  if (receipt.phase === 'rollback_failed') throw new Error('migration rollback previously failed; fail closed until data ownership is repaired')
  if (rollbackPhases.includes(receipt.phase)) {
    receipt = await resumeRollback(receipt)
    process.stdout.write(`${JSON.stringify({ ok: true, phase: receipt.phase })}\n`)
    return
  }
  if (!forwardPhases.includes(receipt.phase)) throw new Error(`unsupported migration phase: ${String(receipt.phase)}`)
  try { receipt = await resumeCutover(receipt) }
  catch (error) {
    const durable = await loadReceipt().catch(() => receipt)
    const failed = await transition(durable, 'rollback_started', { failure: redactedError(error), rollbackStartedAt: new Date().toISOString() })
    const rolledBack = await resumeRollback(failed).catch(async (rollbackError) => {
      const uncertain = await transition(await loadReceipt(), 'rollback_failed', {
        rollbackFailure: redactedError(rollbackError), rollbackFailedAt: new Date().toISOString(),
      })
      throw new AggregateError([error, rollbackError], `cutover failed and rollback failed closed in phase ${uncertain.phase}`)
    })
    throw new Error(`cutover failed and predecessor was restored (${rolledBack.phase}): ${error instanceof Error ? error.message : String(error)}`)
  }
  process.stdout.write(`${JSON.stringify({ ok: true, phase: receipt.phase })}\n`)
}

async function resumeCutover(initial) {
  let receipt = initial
  if (at(receipt, 'installed_disabled')) {
    if (receipt.legacyDataRoot) await probeDedicatedAtomicRename({ sourceRoot: receipt.legacyDataRoot, dataRoot })
    if (receipt.cleanInstall) {
      if (receipt.legacyDataRoot) throw new Error('clean install cannot have a legacy data root')
      receipt = await transition(receipt, 'boundary_reserved', { cleanInstall: true, legacyWasEnabled: false, boundaryReservedAt: new Date().toISOString() })
    } else {
      const legacySettingsFingerprint = await settingsFingerprint('http://127.0.0.1:13000/settings')
      const legacyWasEnabled = await systemctlEnabled(legacyService)
      await waitForLegacyBoundary()
      receipt = await transition(receipt, 'boundary_reserved', { legacySettingsFingerprint, legacyWasEnabled, boundaryReservedAt: new Date().toISOString() })
    }
  }
  if (at(receipt, 'boundary_reserved')) {
    await run('systemctl', ['daemon-reload'])
    if (!receipt.cleanInstall) await run('systemctl', ['stop', legacyService])
    receipt = await transition(receipt, 'legacy_stopped', { legacyStoppedAt: new Date().toISOString() })
  }
  if (at(receipt, 'legacy_stopped')) {
    const migration = receipt.legacyDataRoot
      ? await planDedicatedDataMigration({ sourceRoot: receipt.legacyDataRoot, dataRoot })
      : null
    receipt = await transition(receipt, 'data_migration_planned', { migration })
  }
  if (at(receipt, 'data_migration_planned')) {
    if (receipt.migration) await executeDedicatedDataMigration(receipt.migration)
    receipt = await transition(receipt, 'data_migrated', { dataMigratedAt: new Date().toISOString() })
  }
  if (at(receipt, 'data_migrated')) {
    await run('systemctl', ['start', activeUnitService])
    await waitFor('http://127.0.0.1:13001/runtime/capabilities', isDedicatedCapabilities)
    receipt = await transition(receipt, 'unit_started', { unitStartedAt: new Date().toISOString() })
  }
  if (at(receipt, 'unit_started')) {
    await run('systemctl', ['start', 'agent-runlab-dedicated-ingress.service'])
    await waitFor('http://127.0.0.1:13000/runtime/capabilities', isDedicatedCapabilities)
    const migratedSettingsFingerprint = await settingsFingerprint('http://127.0.0.1:13000/settings')
    if (!receipt.cleanInstall && migratedSettingsFingerprint !== receipt.legacySettingsFingerprint) throw new Error('sanitised provider/model settings fingerprint changed during migration')
    receipt = await transition(receipt, 'ingress_started', { migratedSettingsFingerprint, ingressStartedAt: new Date().toISOString() })
  }
  if (at(receipt, 'ingress_started')) {
    await run('systemctl', ['start', 'agent-runlab-dedicated-deploy-supervisor.service'])
    receipt = await transition(receipt, 'supervisor_started', { supervisorStartedAt: new Date().toISOString() })
  }
  if (at(receipt, 'supervisor_started')) {
    await run('systemctl', ['enable', ...services])
    receipt = await transition(receipt, 'services_enabled', { servicesEnabledAt: new Date().toISOString() })
  }
  if (at(receipt, 'services_enabled')) {
    if (!receipt.cleanInstall) await run('systemctl', ['disable', legacyService])
    receipt = await transition(receipt, 'legacy_disabled', { legacyDisabledAt: new Date().toISOString() })
  }
  if (at(receipt, 'legacy_disabled')) {
    receipt = await transition(receipt, 'cutover_completed', { completedAt: new Date().toISOString(), previousService: legacyService })
  }
  return receipt
}

async function resumeRollback(initial) {
  let receipt = initial
  if (at(receipt, 'rollback_started')) {
    for (const service of [...rollbackServices].reverse()) await run('systemctl', ['stop', service]).catch(() => undefined)
    receipt = await transition(receipt, 'rollback_services_stopped', { rollbackServicesStoppedAt: new Date().toISOString() })
  }
  if (at(receipt, 'rollback_services_stopped')) {
    if (receipt.migration) await rollbackDedicatedData(receipt.migration)
    receipt = await transition(receipt, 'rollback_data_restored', { rollbackDataRestoredAt: new Date().toISOString() })
  }
  if (at(receipt, 'rollback_data_restored')) {
    if (receipt.cleanInstall) {
      receipt = await transition(receipt, 'rolled_back', { rolledBackAt: new Date().toISOString(), cleanInstallStopped: true })
      return receipt
    }
    if (receipt.legacyWasEnabled === true) await run('systemctl', ['enable', legacyService])
    else if (receipt.legacyWasEnabled === false) await run('systemctl', ['disable', legacyService])
    await run('systemctl', ['start', legacyService])
    await waitFor('http://127.0.0.1:13000/runtime/capabilities', (body) => body !== null && typeof body === 'object')
    receipt = await transition(receipt, 'rolled_back', { rolledBackAt: new Date().toISOString() })
  }
  return receipt
}

async function waitForLegacyBoundary() {
  const deadline = Date.now() + 60 * 60_000
  while (Date.now() < deadline) {
    const quiescence = await fetch('http://127.0.0.1:13000/internal/runtime/quiescence', { signal: AbortSignal.timeout(5000) }).then((response) => response.ok ? response.json() : Promise.reject(new Error(`quiescence returned ${response.status}`)))
    if (quiescence.safe) {
      const reserved = await fetch('http://127.0.0.1:13000/internal/runtime/cutover/reserve', { method: 'POST', signal: AbortSignal.timeout(120_000) })
      if (!reserved.ok) throw new Error(`cutover reservation returned ${reserved.status}: ${await reserved.text()}`)
      const result = await reserved.json()
      if (result.safe) return
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
  }
  throw new Error('legacy Host did not reach a safe cutover boundary within one hour')
}

async function settingsFingerprint(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`settings fingerprint request returned ${response.status}`)
  const settings = await response.json()
  const modelsUrl = new URL('/models', url)
  const modelsResponse = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) })
  if (!modelsResponse.ok) throw new Error(`model catalog fingerprint request returned ${modelsResponse.status}`)
  return dedicatedSettingsFingerprint(settings, await modelsResponse.json())
}

async function waitFor(url, accept) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok && accept(await response.json())) return } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`${url} did not become ready`)
}
function isDedicatedCapabilities(body) {
  return body?.product === 'dedicated' && body?.deployment?.architecture === 'platform'
    && body?.deployment?.tenancy === 'single-tenant' && body?.deployment?.runtimeProfile === 'full'
    && body?.capabilities?.operations === true && body?.capabilities?.pipeline === true
}
function at(receipt, phase) { return receipt.phase === phase }
async function loadReceipt() {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt?.schemaVersion !== 1 || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) throw new Error('invalid migration receipt')
  return receipt
}
async function transition(receipt, phase, patch = {}) {
  if (!phaseTransitions.get(receipt.phase)?.has(phase)) throw new Error(`invalid migration phase transition: ${receipt.phase} -> ${phase}`)
  const durable = await loadReceipt()
  if (durable.revision !== receipt.revision || durable.phase !== receipt.phase || durable.releaseId !== receipt.releaseId) throw new Error('migration receipt changed before transition')
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
async function systemctlEnabled(service) {
  const result = await runResult('systemctl', ['is-enabled', service])
  const state = result.stdout.trim()
  if (['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias'].includes(state)) return true
  if (['disabled', 'static', 'indirect', 'masked', 'not-found', 'generated', 'transient'].includes(state)) return false
  throw new Error(`cannot determine whether ${service} was enabled`)
}
async function runResult(command, args) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) }); child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject); child.once('exit', (code) => resolveRun({ code: code ?? -1, stdout, stderr }))
  })
}
async function run(command, args) {
  const result = await runResult(command, args)
  if (result.code !== 0) throw new Error(`${command} exited ${String(result.code)}: ${result.stderr.trim()}`)
}
function redactedError(error) {
  return {
    message: (error instanceof Error ? error.message : String(error)).replaceAll(/(?:[A-Za-z]:)?[\/][^\s;]+/gu, '<path>').slice(0, 1000),
    at: new Date().toISOString(),
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { moveStandaloneData, rollbackStandaloneData } from './standalone-data-migration.mjs'

const dataRoot = resolve(process.env.AGENT_RUNLAB_DATA_ROOT ?? '/var/lib/agent-runlab')
const legacyService = process.env.AGENT_RUNLAB_LEGACY_SERVICE ?? 'agent-runlab-host.service'
const services = ['user2@example.com', 'agent-runlab-ingress.service', 'agent-runlab-deploy-supervisor.service']

async function main() {
  const receiptPath = join(dataRoot, 'deploy', 'migration-receipt.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt.phase !== 'installed_disabled') throw new Error('migration is not staged or was already attempted')
  const legacySettingsFingerprint = await settingsFingerprint('http://127.0.0.1:13000/settings')
  await waitForLegacyBoundary()
  await run('systemctl', ['daemon-reload'])
  await run('systemctl', ['stop', legacyService])
  let migration
  try {
    if (receipt.legacyDataRoot) migration = await moveStandaloneData({ sourceRoot: receipt.legacyDataRoot, dataRoot })
    await run('systemctl', ['start', 'user2@example.com'])
    await waitFor('http://127.0.0.1:13001/runtime/capabilities', (body) => body.mode === 'standalone' && body.capabilities.operations === true && body.capabilities.pipeline === true)
    await run('systemctl', ['start', 'agent-runlab-ingress.service'])
    await waitFor('http://127.0.0.1:13000/runtime/capabilities', (body) => body.mode === 'standalone')
    const migratedSettingsFingerprint = await settingsFingerprint('http://127.0.0.1:13000/settings')
    if (migratedSettingsFingerprint !== legacySettingsFingerprint) throw new Error('sanitised provider/model settings fingerprint changed during migration')
    await run('systemctl', ['start', 'agent-runlab-deploy-supervisor.service'])
    await run('systemctl', ['enable', ...services])
    await run('systemctl', ['disable', legacyService])
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, phase: 'cutover_completed', completedAt: new Date().toISOString(), previousService: legacyService, settingsFingerprint: migratedSettingsFingerprint, migration }, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    await Promise.all(services.map((service) => run('systemctl', ['stop', service]).catch(() => undefined)))
    try {
      if (migration) await rollbackStandaloneData(migration)
    } catch (rollbackError) {
      const message = `${error instanceof Error ? error.message : String(error)}; data rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      await writeFile(receiptPath, `${JSON.stringify({ ...receipt, phase: 'rollback_failed', error: message, rolledBackAt: new Date().toISOString(), migration }, null, 2)}\n`, { mode: 0o600 })
      throw new AggregateError([error, rollbackError], message)
    }
    await run('systemctl', ['start', legacyService])
    await waitFor('http://127.0.0.1:13000/runtime/capabilities', (body) => body.mode === 'standalone')
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, phase: 'rolled_back', error: error instanceof Error ? error.message : String(error), rolledBackAt: new Date().toISOString(), migration }, null, 2)}\n`, { mode: 0o600 })
    throw error
  }
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
  const safe = {
    defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : null,
    providers: Array.isArray(settings.providers) ? settings.providers.map((provider) => ({ id: provider.id, models: Array.isArray(provider.models) ? provider.models.map((model) => model.ref).sort() : [] })).sort((a, b) => String(a.id).localeCompare(String(b.id))) : [],
  }
  return createHash('sha256').update(JSON.stringify(safe)).digest('hex')
}

async function waitFor(url, accept) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok && accept(await response.json())) return
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`${url} did not become ready`)
}

async function run(command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${String(code)}`)))
  })
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

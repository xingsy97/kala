import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { rollbackStandaloneData } from './standalone-data-migration.mjs'

const dataRoot = resolve(process.env.AGENT_RUNLAB_DATA_ROOT ?? '/var/lib/agent-runlab')
const legacyService = process.env.AGENT_RUNLAB_LEGACY_SERVICE ?? 'agent-runlab-host.service'
const receiptPath = join(dataRoot, 'deploy', 'migration-receipt.json')
const services = ['agent-runlab-deploy-supervisor.service', 'agent-runlab-ingress.service', 'user2@example.com', 'user3@example.com']

async function main() {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt.phase !== 'cutover_completed' || !receipt.migration) throw new Error('completed migration receipt with data move is required')
  await Promise.all(services.map((service) => systemctl('stop', service).catch(() => undefined)))
  await rollbackStandaloneData(receipt.migration)
  await systemctl('enable', '--now', legacyService)
  await waitFor('http://127.0.0.1:13000/runtime/capabilities')
  await writeFile(receiptPath, `${JSON.stringify({ ...receipt, phase: 'manually_rolled_back', manuallyRolledBackAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
}
async function waitFor(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) return } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error('legacy service did not recover')
}
async function systemctl(...args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn('systemctl', args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`systemctl exited ${String(code)}`)))
  })
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

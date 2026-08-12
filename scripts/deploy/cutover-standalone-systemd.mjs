import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'

const dataRoot = resolve(process.env.AGENT_RUNLAB_DATA_ROOT ?? '/var/lib/agent-runlab')
const legacyService = process.env.AGENT_RUNLAB_LEGACY_SERVICE ?? 'agent-runlab-host.service'
const services = ['user4@example.com', 'agent-runlab-ingress.service', 'agent-runlab-deploy-supervisor.service']

async function main() {
  const receiptPath = join(dataRoot, 'deploy', 'migration-receipt.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  if (receipt.phase !== 'installed_disabled') throw new Error('migration is not staged or was already attempted')
  await run('systemctl', ['daemon-reload'])
  await run('systemctl', ['stop', legacyService])
  try {
    if (receipt.legacyDataRoot) await migrateLegacyData(receipt.legacyDataRoot, join(dataRoot, 'units', 'local'))
    await run('systemctl', ['start', 'user4@example.com'])
    await waitFor('http://127.0.0.1:13001/runtime/capabilities', (body) => body.mode === 'standalone' && body.capabilities.operations === true && body.capabilities.pipeline === true)
    await run('systemctl', ['start', 'agent-runlab-ingress.service'])
    await waitFor('http://127.0.0.1:13000/runtime/capabilities', (body) => body.mode === 'standalone')
    await run('systemctl', ['start', 'agent-runlab-deploy-supervisor.service'])
    await run('systemctl', ['enable', ...services])
    await run('systemctl', ['disable', legacyService])
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, phase: 'cutover_completed', completedAt: new Date().toISOString(), previousService: legacyService }, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    await Promise.all(services.map((service) => run('systemctl', ['stop', service]).catch(() => undefined)))
    await run('systemctl', ['start', legacyService])
    await waitFor('http://127.0.0.1:13000/runtime/capabilities', (body) => body.mode === 'standalone')
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, phase: 'rolled_back', error: error instanceof Error ? error.message : String(error), rolledBackAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
    throw error
  }
}

async function migrateLegacyData(sourceRoot, targetRoot) {
  await mkdir(targetRoot, { recursive: true, mode: 0o700 })
  for (const name of ['sessions', 'artifacts', 'executor-identities.json', 'workspace-aliases.json']) {
    await cp(join(sourceRoot, name), join(targetRoot, name), { recursive: true, force: false, errorOnExist: true }).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
  await run('chown', ['-R', 'agent-runlab:agent-runlab', targetRoot])
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

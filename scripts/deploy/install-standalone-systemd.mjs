import { copyFile, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'

const source = resolve(process.argv[2] ?? 'release')
const root = resolve(process.env.AGENT_RUNLAB_INSTALL_ROOT ?? '/opt/agent-runlab')
const dataRoot = resolve(process.env.AGENT_RUNLAB_DATA_ROOT ?? '/var/lib/agent-runlab')
const unitDir = resolve(process.env.AGENT_RUNLAB_SYSTEMD_DIR ?? '/etc/systemd/system')
const releaseId = process.env.AGENT_RUNLAB_RELEASE_ID?.trim() || `release-${Date.now()}`
const releaseDir = join(dataRoot, 'deploy', 'releases', releaseId)

async function main() {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  if (!manifest || !Array.isArray(manifest.assets)) throw new Error('valid release manifest is required')
  await verifyChecksums()
  await assertNode22()
  await ensureServiceUser()
  await mkdir(join(dataRoot, 'deploy', 'releases'), { recursive: true, mode: 0o700 })
  await mkdir(releaseDir, { recursive: false, mode: 0o700 })
  for (const name of ['bundle-dashboard-with-runtime.cjs', 'agent-kernel-executor.cjs', 'manifest.json', 'SHA256SUMS', 'RELEASE_NOTES.md']) {
    await copyFile(join(source, name), join(releaseDir, name))
  }
  await mkdir(join(root, 'control'), { recursive: true, mode: 0o755 })
  for (const name of ['agent-runlab-standalone-ingress.cjs', 'agent-runlab-deploy-supervisor.cjs']) await copyFile(join(source, name), join(root, 'control', name))
  await mkdir(join(dataRoot, 'deploy', 'requests'), { recursive: true, mode: 0o700 })
  await mkdir(join(dataRoot, 'deploy', 'slots'), { recursive: true, mode: 0o700 })
  await mkdir(join(dataRoot, 'units', 'local'), { recursive: true, mode: 0o700 })
  await mkdir(join(dataRoot, '.cache'), { recursive: true, mode: 0o700 })
  await activate(join(dataRoot, 'deploy', 'current'), releaseDir)
  await activate(join(dataRoot, 'deploy', 'slots', 'blue'), releaseDir)
  await activate(join(dataRoot, 'deploy', 'slots', 'green'), releaseDir)
  await mkdir('/etc/agent-runlab/slots', { recursive: true, mode: 0o755 })
  await writeFile('/etc/agent-runlab/slots/blue.env', 'HOST_PORT=13001\n', { mode: 0o644 })
  await writeFile('/etc/agent-runlab/slots/green.env', 'HOST_PORT=13002\n', { mode: 0o644 })
  const route = { schemaVersion: 1, generation: 1, activeSlot: 'blue', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId }, green: { origin: 'http://127.0.0.1:13002', releaseId } }, updatedAt: new Date().toISOString() }
  await writeFile(join(dataRoot, 'deploy', 'route-state.json'), `${JSON.stringify(route, null, 2)}\n`, { mode: 0o644 })
  for (const name of ['agent-runlab-ingress.service', 'agent-runlab-unit@.service', 'agent-runlab-deploy-supervisor.service']) await copyFile(join(source, name), join(unitDir, name))
  await run('chown', ['-R', 'root:root', join(dataRoot, 'deploy')])
  await run('chmod', ['-R', 'go-w', join(dataRoot, 'deploy')])
  await run('chmod', ['711', dataRoot, join(dataRoot, 'units'), join(dataRoot, 'deploy'), join(dataRoot, 'deploy', 'releases'), join(dataRoot, 'deploy', 'slots'), releaseDir])
  await run('chown', ['-R', 'agent-runlab:agent-runlab', join(dataRoot, 'units', 'local'), join(dataRoot, '.cache')])
  const containerBackend = await configureContainerBackend()
  const legacyDataRoot = process.env.AGENT_RUNLAB_LEGACY_DATA_ROOT?.trim()
  await writeFile(join(dataRoot, 'deploy', 'migration-receipt.json'), `${JSON.stringify({ schemaVersion: 1, phase: 'installed_disabled', releaseId: basename(releaseDir), installedAt: new Date().toISOString(), containerBackend, ...(legacyDataRoot ? { legacyDataRoot: resolve(legacyDataRoot) } : {}) }, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ok: true, phase: 'installed_disabled', releaseId })}\n`)
}

async function verifyChecksums() {
  await new Promise((resolveVerify, reject) => {
    const child = spawn('sha256sum', ['-c', 'SHA256SUMS', '--ignore-missing'], { cwd: source, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveVerify() : reject(new Error('release checksum verification failed')))
  })
}

async function configureContainerBackend() {
  const requested = (process.env.AGENT_RUNLAB_CONTAINER_BACKEND ?? 'auto').trim()
  if (requested === 'none') return 'none'
  const dockerAvailable = await run('test', ['-S', '/var/run/docker.sock'], true)
  if (!dockerAvailable) {
    if (requested === 'docker') throw new Error('Docker backend requested but /var/run/docker.sock is unavailable')
    return 'none'
  }
  if (!await run('getent', ['group', 'docker'], true)) throw new Error('Docker socket exists but docker group is missing')
  // Docker-group membership is root-equivalent. Permit it only inside the
  // dedicated Standalone VM/LXD boundary and record the decision in the receipt.
  await run('usermod', ['--append', '--groups', 'docker', 'agent-runlab'])
  if (!await run('runuser', ['-u', 'agent-runlab', '--', 'docker', 'info'], true)) {
    if (requested === 'docker') throw new Error('Docker daemon is not usable by the agent-runlab service account')
    return 'none'
  }
  return 'docker'
}

async function assertNode22() {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isSafeInteger(major) || major < 22) throw new Error(`Node.js 22+ is required; found ${process.version}`)
}

async function ensureServiceUser() {
  if (!await run('id', ['-u', 'agent-runlab'], true)) await run('useradd', ['--system', '--home', '/var/lib/agent-runlab', '--shell', '/usr/sbin/nologin', 'agent-runlab'])
}

async function run(command, args, allowFailure = false) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun(true) : allowFailure ? resolveRun(false) : reject(new Error(`${command} exited ${String(code)}`)))
  })
}

async function activate(currentLink, target) {
  const temp = `${currentLink}.next-${process.pid}`
  await mkdir(dirname(currentLink), { recursive: true, mode: 0o700 })
  await unlink(temp).catch(() => undefined)
  await symlink(target, temp)
  await rename(temp, currentLink)
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

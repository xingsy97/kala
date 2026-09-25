import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'

const source = resolve(process.argv[2] ?? 'release')
const root = resolve(process.env.AGENT_RUNLAB_INSTALL_ROOT ?? '/opt/agent-runlab')
const dataRoot = resolve(process.env.AGENT_RUNLAB_DATA_ROOT ?? '/var/lib/agent-runlab')
const unitDir = resolve(process.env.AGENT_RUNLAB_SYSTEMD_DIR ?? '/etc/systemd/system')
const releaseId = process.env.AGENT_RUNLAB_RELEASE_ID?.trim() || `release-${Date.now()}`
const legacyDataRoot = process.env.AGENT_RUNLAB_LEGACY_DATA_ROOT?.trim()
const releaseDir = join(dataRoot, 'deploy', 'releases', releaseId)
const supportArchive = 'kala-dedicated-support.tar.gz'
const supportManifest = 'dedicated-support-manifest.json'
const supportAssets = ['cutover-dedicated-systemd.mjs', 'dedicated-data-migration.mjs', 'dedicated-settings-fingerprint.mjs', 'deploy-dashboard.mjs', 'deploy-dedicated.mjs', 'deployment.json', 'install-dedicated-systemd.mjs', 'kala-dedicated-control-updater.service', 'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-ingress.service', 'kala-dedicated-migration-finalizer.service', 'kala-dedicated-unit@.service', 'rollback-dedicated-systemd.mjs', 'update-dedicated-control-plane.mjs']
const dedicatedServices = [
  'agent-runlab-dedicated-ingress.service',
  'agent-runlab-dedicated-unit@blue.service',
  'agent-runlab-dedicated-unit@green.service',
  'agent-runlab-dedicated-deploy-supervisor.service',
  'agent-runlab-dedicated-control-updater.service',
  'agent-runlab-dedicated-migration-finalizer.service',
]

async function main() {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  if (!manifest || !Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error('valid release manifest is required')
  if (new Set(manifest.assets).size !== manifest.assets.length) throw new Error('release manifest contains duplicate assets')
  if (manifest.assets.some((name) => ['manifest.json', 'SHA256SUMS', 'RELEASE_NOTES.md'].includes(name))) throw new Error('release manifest assets contain a reserved metadata name')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) throw new Error('invalid release id')
  if (!manifest.assets.includes(supportArchive) || manifest.assets.some((name) => supportAssets.includes(name))) throw new Error('release does not use the Dedicated support bundle contract')
  const signature = await exists(join(source, 'SHA256SUMS.sigstore.json')) ? ['SHA256SUMS.sigstore.json'] : []
  const outerReleaseFiles = [...manifest.assets, 'manifest.json', 'SHA256SUMS', ...signature].sort()
  const releaseFiles = [...outerReleaseFiles, ...supportAssets].sort()
  for (const name of releaseFiles) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(name)) throw new Error(`invalid release asset name: ${String(name)}`)
  }
  await verifyExactRelease(outerReleaseFiles, releaseFiles)
  await assertNode22()
  await assertStagedServicesDisabled()
  await ensureServiceUser()
  await mkdir(join(dataRoot, 'deploy', 'releases'), { recursive: true, mode: 0o711 })
  await installImmutableRelease(releaseFiles)
  await mkdir(join(root, 'control'), { recursive: true, mode: 0o755 })
  for (const name of ['kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs', 'kala-dedicated.mjs', 'deploy-dedicated.mjs', 'deploy-dashboard.mjs', 'cutover-dedicated-systemd.mjs', 'dedicated-data-migration.mjs', 'dedicated-settings-fingerprint.mjs', 'rollback-dedicated-systemd.mjs']) await copyFile(join(source, name), join(root, 'control', name))
  await mkdir(join(dataRoot, 'deploy', 'requests'), { recursive: true, mode: 0o3770 })
  await mkdir(join(dataRoot, 'deploy', 'submissions'), { recursive: true, mode: 0o3770 })
  await mkdir(join(dataRoot, 'deploy', 'receipts'), { recursive: true, mode: 0o750 })
  await mkdir(join(dataRoot, 'deploy', 'control-updates', 'requests'), { recursive: true, mode: 0o750 })
  await mkdir(join(dataRoot, 'deploy', 'control-updates', 'receipts'), { recursive: true, mode: 0o750 })
  await mkdir(join(dataRoot, 'deploy', 'slots'), { recursive: true, mode: 0o700 })
  await mkdir(join(dataRoot, 'deploy', 'dashboard', 'releases'), { recursive: true, mode: 0o711 })
  await mkdir(join(dataRoot, 'deploy', 'dashboard', 'requests'), { recursive: true, mode: 0o3770 })
  await mkdir(join(dataRoot, 'deploy', 'dashboard', 'submissions'), { recursive: true, mode: 0o3770 })
  await mkdir(join(dataRoot, 'deploy', 'dashboard', 'receipts'), { recursive: true, mode: 0o750 })
  await mkdir(join(dataRoot, 'units', 'local'), { recursive: true, mode: 0o700 })
  // A clean installation needs an empty state root before its first Unit
  // start. A legacy migration must leave the destination absent so the
  // Finalizer can atomically rename the authoritative source into place.
  if (!legacyDataRoot) await mkdir(join(dataRoot, '.agent-kernel'), { recursive: true, mode: 0o700 })
  await mkdir(join(dataRoot, '.cache'), { recursive: true, mode: 0o700 })
  await mkdir(join(dataRoot, 'admission'), { recursive: true, mode: 0o700 })
  await activate(join(dataRoot, 'deploy', 'current'), releaseDir)
  await activate(join(dataRoot, 'deploy', 'control-current'), releaseDir)
  await activate(join(dataRoot, 'deploy', 'control-updater-current'), releaseDir)
  await activate(join(dataRoot, 'deploy', 'slots', 'blue'), releaseDir)
  await activate(join(dataRoot, 'deploy', 'slots', 'green'), releaseDir)
  await installInitialDashboardRelease(source, dataRoot, releaseId)
  await mkdir('/etc/agent-runlab/slots', { recursive: true, mode: 0o755 })
  await ensureHandoffSecret()
  await copyFile(join(source, 'deployment.json'), '/etc/agent-runlab/deployment.json')
  await writeFile('/etc/agent-runlab/slots/blue.env', 'HOST_PORT=13001\n', { mode: 0o644 })
  await writeFile('/etc/agent-runlab/slots/green.env', 'HOST_PORT=13002\n', { mode: 0o644 })
  const route = { schemaVersion: 1, generation: 1, activeSlot: 'blue', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId }, green: { origin: 'http://127.0.0.1:13002', releaseId } }, updatedAt: new Date().toISOString() }
  await writeAtomicJson(join(dataRoot, 'deploy', 'route-state.json'), route, 0o644)
  for (const [asset, service] of [
    ['kala-dedicated-ingress.service', 'agent-runlab-dedicated-ingress.service'],
    ['kala-dedicated-unit@.service', 'agent-runlab-dedicated-unit@.service'],
    ['kala-dedicated-deploy-supervisor.service', 'agent-runlab-dedicated-deploy-supervisor.service'],
    ['kala-dedicated-control-updater.service', 'agent-runlab-dedicated-control-updater.service'],
    ['kala-dedicated-migration-finalizer.service', 'agent-runlab-dedicated-migration-finalizer.service'],
  ]) await copyFile(join(source, asset), join(unitDir, service))
  await run('chown', ['-R', 'root:root', join(dataRoot, 'deploy')])
  await run('chmod', ['-R', 'go-w', join(dataRoot, 'deploy')])
  await run('chown', ['root:agent-runlab', join(dataRoot, 'deploy'), join(dataRoot, 'deploy', 'requests'), join(dataRoot, 'deploy', 'submissions'), join(dataRoot, 'deploy', 'receipts'), join(dataRoot, 'deploy', 'control-updates'), join(dataRoot, 'deploy', 'control-updates', 'requests'), join(dataRoot, 'deploy', 'control-updates', 'receipts')])
  await run('chown', ['root:agent-runlab', join(dataRoot, 'deploy', 'dashboard'), join(dataRoot, 'deploy', 'dashboard', 'releases'), join(dataRoot, 'deploy', 'dashboard', 'route-state.json'), join(dataRoot, 'deploy', 'dashboard', 'requests'), join(dataRoot, 'deploy', 'dashboard', 'submissions'), join(dataRoot, 'deploy', 'dashboard', 'receipts')])
  await run('chmod', ['711', dataRoot, join(dataRoot, 'units'), join(dataRoot, 'deploy', 'releases'), join(dataRoot, 'deploy', 'slots')])
  await run('chmod', ['750', join(dataRoot, 'deploy'), join(dataRoot, 'deploy', 'receipts')])
  await run('chmod', ['750', join(dataRoot, 'deploy', 'control-updates'), join(dataRoot, 'deploy', 'control-updates', 'requests'), join(dataRoot, 'deploy', 'control-updates', 'receipts')])
  await run('chmod', ['750', join(dataRoot, 'deploy', 'dashboard'), join(dataRoot, 'deploy', 'dashboard', 'releases'), join(dataRoot, 'deploy', 'dashboard', 'receipts')])
  await run('chmod', ['3770', join(dataRoot, 'deploy', 'dashboard', 'requests'), join(dataRoot, 'deploy', 'dashboard', 'submissions')])
  await run('chmod', ['3770', join(dataRoot, 'deploy', 'requests'), join(dataRoot, 'deploy', 'submissions')])
  await run('chmod', ['555', releaseDir])
  await run('chown', ['-R', 'agent-runlab:agent-runlab', join(dataRoot, 'units', 'local'), ...(legacyDataRoot ? [] : [join(dataRoot, '.agent-kernel')]), join(dataRoot, '.cache'), join(dataRoot, 'admission')])
  const containerBackend = await configureContainerBackend()
  const normalizedLegacyDataRoot = legacyDataRoot ? await configureLegacyMigrationAccess(legacyDataRoot) : undefined
  await run('systemctl', ['daemon-reload'])
  await assertStagedServicesDisabled()
  const sums = await readFile(join(source, 'SHA256SUMS'))
  const installedAt = new Date().toISOString()
  await writeAtomicJson(join(dataRoot, 'deploy', 'migration-receipt.json'), {
    schemaVersion: 1, revision: 1, phase: 'installed_disabled', releaseId: basename(releaseDir), installedAt, updatedAt: installedAt,
    releaseDigest: createHash('sha256').update(sums).digest('hex'),
    bundleSha256: createHash('sha256').update(await readFile(join(source, 'kala-runtime.cjs'))).digest('hex'),
    containerBackend, cleanInstall: !normalizedLegacyDataRoot, ...(normalizedLegacyDataRoot ? { legacyDataRoot: normalizedLegacyDataRoot } : {}),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, phase: 'installed_disabled', releaseId })}\n`)
}

async function verifyExactRelease(outerReleaseFiles, releaseFiles) {
  const entries = await readdir(source, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile()) || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(releaseFiles)) throw new Error('expanded release file set does not exactly match the bundle contract')
  const sums = parseSums(await readFile(join(source, 'SHA256SUMS'), 'utf8'))
  const expectedSums = outerReleaseFiles.filter((name) => !['SHA256SUMS', 'SHA256SUMS.sigstore.json'].includes(name))
  if (JSON.stringify([...sums].sort()) !== JSON.stringify(expectedSums)) throw new Error('release checksum file set does not exactly match manifest')
  await verifyChecksums(source)
  await verifySupport(source)
}

async function verifySupport(root) {
  const entries = readExactTarGz(await readFile(join(root, supportArchive)), 'Dedicated support')
  const expected = [...supportAssets, supportManifest].sort()
  if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(expected)) throw new Error('Dedicated support archive entries are unsafe or incomplete')
  let manifest
  try { manifest = JSON.parse(String(entries.get(supportManifest))) } catch { throw new Error('invalid Dedicated support manifest') }
  if (manifest?.schemaVersion !== 1 || manifest.product !== 'kala-dedicated-support' || JSON.stringify(manifest.assets?.map((entry) => entry.name)) !== JSON.stringify(supportAssets)) throw new Error('invalid Dedicated support manifest')
  for (const entry of manifest.assets) {
    const archived = entries.get(entry.name)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256) || archived.length !== entry.bytes || createHash('sha256').update(archived).digest('hex') !== entry.sha256) throw new Error('invalid Dedicated support manifest asset')
    const value = await lstat(join(root, entry.name)); const bytes = await readFile(join(root, entry.name))
    if (!value.isFile() || value.isSymbolicLink() || !bytes.equals(archived)) throw new Error(`Dedicated support extracted asset mismatch: ${entry.name}`)
  }
}

async function installInitialDashboardRelease(sourceRoot, targetDataRoot, targetReleaseId) {
  const dashboardRoot = join(targetDataRoot, 'deploy', 'dashboard')
  const target = join(dashboardRoot, 'releases', targetReleaseId)
  const archiveEntries = readExactTarGz(await readFile(join(sourceRoot, 'kala-dashboard.tar.gz')), 'Dashboard')
  const manifestBytes = archiveEntries.get('dashboard-release.json')
  if (!manifestBytes) throw new Error('Dashboard archive is missing dashboard-release.json')
  const manifest = JSON.parse(String(manifestBytes))
  verifyDashboardArchive(archiveEntries, manifest)
  const incoming = `${target}.incoming-${randomBytes(12).toString('hex')}`
  await mkdir(join(incoming, 'assets'), { recursive: true, mode: 0o700 })
  try {
    for (const entry of manifest.files) { const path = join(incoming, 'assets', ...entry.path.split('/')); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, archiveEntries.get(entry.path), { flag: 'wx', mode: 0o600 }) }
    await verifyDashboardFiles(join(incoming, 'assets'), manifest.files)
    await writeFile(join(incoming, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 })
    await syncDashboardTree(incoming)
    await sealDashboardTree(incoming)
    await rename(incoming, target)
    const parent = await open(dirname(target), 'r'); try { await parent.sync() } finally { await parent.close() }
  } finally { await rm(incoming, { recursive: true, force: true }) }
  await writeAtomicJson(join(dashboardRoot, 'route-state.json'), { schemaVersion: 1, generation: 1, releaseId: targetReleaseId, releaseDigest: createHash('sha256').update(manifestBytes).digest('hex'), assetDigest: manifest.assetDigest, version: manifest.version, protocol: manifest.protocol, activatedAt: new Date().toISOString() }, 0o640)
}

function verifyDashboardArchive(entries, manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.product !== 'kala-dashboard' || !Array.isArray(manifest.files) || !manifest.files.some((entry) => entry.path === 'index.html')) throw new Error('invalid Dashboard release manifest')
  const expected = [...manifest.files.map((entry) => entry.path), 'dashboard-release.json'].sort()
  if (new Set(expected).size !== expected.length || JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(expected)) throw new Error('Dashboard archive file set does not match manifest')
  const sorted = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))
  if (manifest.assetDigest !== createHash('sha256').update(Buffer.from(JSON.stringify(sorted))).digest('hex')) throw new Error('Dashboard manifest asset digest is invalid')
  for (const entry of manifest.files) { const bytes = entries.get(entry.path); if (!bytes || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256) || bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Dashboard asset mismatch: ${String(entry.path)}`) }
}

async function verifyDashboardFiles(root, expected) {
  const actual = []
  const walk = async (dir) => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isSymbolicLink()) throw new Error('Dashboard release contains a symlink'); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) actual.push(path.slice(root.length + 1).replaceAll('\\', '/')); else throw new Error('Dashboard release contains a non-file') } }
  await walk(root)
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.map((entry) => entry.path).sort())) throw new Error('Dashboard file set does not match manifest')
  for (const entry of expected) { const bytes = await readFile(join(root, entry.path)); if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Dashboard asset mismatch: ${entry.path}`) }
}

async function syncDashboardTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) await syncDashboardTree(path); else { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } } }
  const directory = await open(root, 'r'); try { await directory.sync() } finally { await directory.close() }
}

async function sealDashboardTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await sealDashboardTree(path)
    else if (entry.isFile()) await chmod(path, 0o444)
    else throw new Error('Dashboard release contains a non-file')
  }
  await chmod(root, 0o555)
}

async function installImmutableRelease(releaseFiles) {
  if (await exactReleaseExists(releaseDir, releaseFiles)) return
  try { await lstat(releaseDir); throw new Error('immutable release destination already exists with different content') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const incoming = `${releaseDir}.incoming-${randomBytes(12).toString('hex')}`
  await mkdir(incoming, { mode: 0o700 })
  try {
    for (const name of releaseFiles) await copyFile(join(source, name), join(incoming, name))
    await verifyChecksums(incoming)
    await syncTree(incoming, releaseFiles)
    await run('chmod', ['-R', 'a-w', incoming])
    await run('mv', ['-Tn', '--', incoming, releaseDir])
    try {
      await lstat(incoming)
      if (!await exactReleaseExists(releaseDir, releaseFiles)) throw new Error('immutable release destination won a race with different content')
      await rm(incoming, { recursive: true, force: true })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = await open(dirname(releaseDir), 'r'); try { await parent.sync() } finally { await parent.close() }
  } finally {
    await rm(incoming, { recursive: true, force: true })
  }
}

async function exactReleaseExists(path, releaseFiles) {
  try {
    const directory = await lstat(path)
    if (!directory.isDirectory() || (directory.mode & 0o222) !== 0) return false
    const entries = await readdir(path, { withFileTypes: true })
    if (entries.some((entry) => !entry.isFile()) || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(releaseFiles)) return false
    for (const entry of entries) if (((await lstat(join(path, entry.name))).mode & 0o222) !== 0) return false
    if (await readFile(join(path, 'SHA256SUMS'), 'utf8') !== await readFile(join(source, 'SHA256SUMS'), 'utf8')) return false
    await verifyChecksums(path)
    await verifySupport(path)
    return true
  } catch { return false }
}

async function verifyChecksums(cwd) {
  await new Promise((resolveVerify, reject) => {
    const child = spawn('sha256sum', ['-c', 'SHA256SUMS'], { cwd, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveVerify() : reject(new Error('release checksum verification failed')))
  })
}

async function syncTree(path, releaseFiles) {
  for (const name of releaseFiles) { const file = await open(join(path, name), 'r'); try { await file.sync() } finally { await file.close() } }
  const directory = await open(path, 'r'); try { await directory.sync() } finally { await directory.close() }
}

function readExactTarGz(compressed, label) {
  let tar
  try { tar = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }) } catch { throw new Error(`${label} archive is unreadable`) }
  const entries = new Map(); let offset = 0; let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512
    if (header.every((byte) => byte === 0)) { ended = true; break }
    const expectedChecksum = tarNumber(header.subarray(148, 156), label); let actualChecksum = 0
    for (let index = 0; index < 512; index += 1) actualChecksum += index >= 148 && index < 156 ? 32 : header[index]
    if (actualChecksum !== expectedChecksum) throw new Error(`${label} archive has an invalid header checksum`)
    const name = tarText(header.subarray(0, 100)), prefix = tarText(header.subarray(345, 500)); const path = prefix ? `${prefix}/${name}` : name
    if (!path || path.includes('\\') || path.startsWith('/') || path.endsWith('/') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${label} archive contains an unsafe path`)
    if (![0, 48].includes(header[156])) throw new Error(`${label} archive contains a non-regular entry`)
    const size = tarNumber(header.subarray(124, 136), label)
    if (size > 512 * 1024 * 1024 || offset + size > tar.length || entries.has(path)) throw new Error(`${label} archive contains a duplicate, truncated, or oversized entry`)
    entries.set(path, Buffer.from(tar.subarray(offset, offset + size))); offset += Math.ceil(size / 512) * 512
  }
  if (!ended || tar.subarray(offset).some((byte) => byte !== 0)) throw new Error(`${label} archive has an invalid terminator`)
  return entries
}
function tarText(bytes) { const end = bytes.indexOf(0); return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end < 0 ? bytes.length : end)) }
function tarNumber(bytes, label) { if (bytes[0] & 0x80) throw new Error(`${label} archive uses an unsupported tar number`); const value = tarText(bytes).trim(); if (!/^[0-7]*$/u.test(value)) throw new Error(`${label} archive has an invalid tar number`); const number = Number.parseInt(value || '0', 8); if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} archive has an invalid tar number`); return number }
async function exists(path) { try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
function parseSums(value) {
  const names = []
  for (const line of value.trim().split('\n')) {
    const match = line.match(/^[a-f0-9]{64}  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u)
    if (!match || names.includes(match[1])) throw new Error('invalid or duplicate SHA256SUMS entry')
    names.push(match[1])
  }
  return names
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
  // dedicated VM/LXD boundary and record the decision in the receipt.
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

async function ensureHandoffSecret() {
  const path = '/etc/agent-runlab/handoff.env'
  try {
    const existing = await readFile(path, 'utf8')
    if (!/^AGENT_RUNLAB_INGRESS_HANDOFF_SECRET=[A-Za-z0-9_-]{43}\n$/u.test(existing)) throw new Error('existing Dedicated handoff secret file is invalid')
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const secret = randomBytes(32).toString('base64url')
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(`AGENT_RUNLAB_INGRESS_HANDOFF_SECRET=${secret}\n`)
    await file.sync()
  } finally { await file.close() }
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function configureLegacyMigrationAccess(value) {
  const normalized = resolve(value)
  const sourceState = normalized.endsWith('/.agent-kernel') ? normalized : join(normalized, '.agent-kernel')
  const legacyHome = dirname(sourceState)
  if (['/', '/home', '/root', '/var', '/srv', '/opt', '/usr'].includes(legacyHome)) throw new Error('legacy data root resolves to an unsafe broad migration path')
  const sourceStat = await lstat(sourceState)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('legacy state root must be a real directory')
  try { await lstat(join(dataRoot, '.agent-kernel')); throw new Error('target state root already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (sourceStat.dev !== (await stat(dataRoot)).dev) throw new Error('legacy and target state must share a filesystem')
  return normalized
}

async function assertStagedServicesDisabled() {
  for (const service of dedicatedServices) {
    if (await run('systemctl', ['is-active', '--quiet', service], true)) throw new Error(`staged service is already active: ${service}`)
    const enablement = await systemctlEnablement(service)
    if (['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias'].includes(enablement)) {
      throw new Error(`staged service is already enabled: ${service} (${enablement})`)
    }
    if (!['disabled', 'static', 'indirect', 'masked', 'not-found', 'generated', 'transient'].includes(enablement)) {
      throw new Error(`cannot determine staged service enablement: ${service} (${enablement || 'empty'})`)
    }
  }
}

async function systemctlEnablement(service) {
  return await new Promise((resolveState, reject) => {
    const child = spawn('systemctl', ['is-enabled', service], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.once('error', reject)
    child.once('exit', () => {
      resolveState(stdout.trim())
    })
  })
}

async function writeAtomicJson(path, value, mode = 0o600) {
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const file = await open(temp, 'wx', mode)
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
    await rename(temp, path)
    const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temp, { force: true }).catch(() => undefined) }
}

async function run(command, args, allowFailure = false) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun(true) : allowFailure ? resolveRun(false) : reject(new Error(`${command} exited ${String(code)}`)))
  })
}

async function capture(command, args) {
  return await new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) }); child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolveCapture(stdout) : reject(new Error(`${command} exited ${String(code)}: ${stderr}`)))
  })
}

async function activate(currentLink, target) {
  const temp = `${currentLink}.next-${process.pid}`
  await mkdir(dirname(currentLink), { recursive: true, mode: 0o700 })
  await unlink(temp).catch(() => undefined)
  await symlink(target, temp)
  await rename(temp, currentLink)
  const directory = await open(dirname(currentLink), 'r'); try { await directory.sync() } finally { await directory.close() }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

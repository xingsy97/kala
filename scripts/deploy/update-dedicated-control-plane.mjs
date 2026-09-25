#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'

const deployRoot = resolve(process.env.AGENT_RUNLAB_DEPLOY_ROOT ?? '/var/lib/agent-runlab/deploy')
const controlLink = resolve(process.env.AGENT_RUNLAB_CONTROL_CURRENT ?? join(deployRoot, 'control-current'))
const updaterLink = resolve(process.env.AGENT_RUNLAB_CONTROL_UPDATER_CURRENT ?? join(deployRoot, 'control-updater-current'))
const controlReleasesRoot = resolve(process.env.AGENT_RUNLAB_CONTROL_RELEASES_ROOT ?? join(deployRoot, 'control-releases'))
const updateRoot = resolve(process.env.AGENT_RUNLAB_CONTROL_UPDATE_ROOT ?? join(deployRoot, 'control-updates'))
const requestsDir = join(updateRoot, 'requests')
const receiptsDir = join(updateRoot, 'receipts')
let receiptPath = ''
const unitDir = resolve(process.env.AGENT_RUNLAB_SYSTEMD_DIR ?? '/etc/systemd/system')
const deploymentConfig = resolve(process.env.AGENT_RUNLAB_DEPLOYMENT_CONFIG ?? '/etc/agent-runlab/deployment.json')
const operatorStatusPath = resolve(process.env.AGENT_RUNLAB_OPERATOR_STATUS ?? join(deployRoot, 'operator-status.json'))
const ingressReadinessPath = resolve(process.env.AGENT_RUNLAB_INGRESS_READINESS ?? '/run/agent-runlab/ingress-readiness.json')
const systemctlBinary = resolve(process.env.AGENT_RUNLAB_SYSTEMCTL ?? '/usr/bin/systemctl')
const chownBinary = resolve(process.env.AGENT_RUNLAB_CHOWN ?? '/usr/bin/chown')
const supportArchive = 'kala-dedicated-support.tar.gz'
const supportManifest = 'dedicated-support-manifest.json'
const supportAssets = ['cutover-dedicated-systemd.mjs', 'dedicated-data-migration.mjs', 'dedicated-settings-fingerprint.mjs', 'deploy-dashboard.mjs', 'deploy-dedicated.mjs', 'deployment.json', 'install-dedicated-systemd.mjs', 'kala-dedicated-control-updater.service', 'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-ingress.service', 'kala-dedicated-migration-finalizer.service', 'kala-dedicated-unit@.service', 'rollback-dedicated-systemd.mjs', 'update-dedicated-control-plane.mjs']
const units = [
  { asset: 'kala-dedicated-ingress.service', service: 'agent-runlab-dedicated-ingress.service' },
  { asset: 'kala-dedicated-unit@.service', service: 'agent-runlab-dedicated-unit@.service' },
  { asset: 'kala-dedicated-deploy-supervisor.service', service: 'agent-runlab-dedicated-deploy-supervisor.service' },
  { asset: 'kala-dedicated-control-updater.service', service: 'agent-runlab-dedicated-control-updater.service' },
  { asset: 'kala-dedicated-migration-finalizer.service', service: 'agent-runlab-dedicated-migration-finalizer.service' },
]

const transitions = {
  requested: new Set(['activating', 'rolling_back']),
  activating: new Set(['ingress_restarting', 'rolling_back']),
  ingress_restarting: new Set(['ingress_ready', 'rolling_back']),
  ingress_ready: new Set(['supervisor_restarting', 'rolling_back']),
  supervisor_restarting: new Set(['completed', 'rolling_back']),
  rolling_back: new Set(['rolled_back', 'rollback_failed']),
  completed: new Set(), rolled_back: new Set(), rollback_failed: new Set(),
}

async function main() {
  await mkdir(requestsDir, { recursive: true, mode: 0o750 })
  await mkdir(receiptsDir, { recursive: true, mode: 0o750 })
  const pending = await nextRequest()
  if (!pending) return
  const { request, receipt: persisted } = pending
  receiptPath = join(receiptsDir, `${request.updateId}.json`)
  let receipt = persisted
  if (!receipt) {
    receipt = { schemaVersion: 1, revision: 1, updateId: request.updateId, deploymentId: request.deploymentId, direction: request.direction, phase: 'requested', targetReleaseId: request.targetReleaseId, targetReleaseDigest: request.targetReleaseDigest, predecessorReleaseId: request.predecessorReleaseId, predecessorReleaseDigest: request.predecessorReleaseDigest, requestedAt: request.requestedAt, updatedAt: new Date().toISOString() }
    await persist(receipt)
  } else assertSameRequest(receipt, request)
  if (receipt.phase === 'completed') { await activate(updaterLink, await materializeControlRelease(receipt.targetReleaseId, receipt.targetReleaseDigest)); return }
  if (receipt.phase === 'rolled_back') { await activate(updaterLink, await materializeControlRelease(receipt.predecessorReleaseId, receipt.predecessorReleaseDigest)); return }
  if (receipt.phase === 'rollback_failed') { process.exitCode = 1; return }
  try {
    receipt = await reconcile(receipt)
  } catch (error) {
    receipt = await rollback(await readReceipt() ?? receipt, error)
  }
  process.stdout.write(`${JSON.stringify({ ok: receipt.phase === 'completed', phase: receipt.phase, updateId: receipt.updateId })}\n`)
  if (receipt.phase !== 'completed' && receipt.phase !== 'rolled_back') process.exitCode = 1
}

async function nextRequest() {
  for (const name of (await readdir(requestsDir)).filter((entry) => entry.endsWith('.json')).sort()) {
    const request = validateRequest(JSON.parse(await readFile(join(requestsDir, name), 'utf8')))
    if (name !== `${request.updateId}.json`) throw new Error('control update request filename does not match updateId')
    const path = join(receiptsDir, name)
    const receipt = await readReceipt(path)
    if (!receipt || !['completed', 'rolled_back', 'rollback_failed'].includes(receipt.phase)) return { request, receipt }
  }
  return undefined
}

async function reconcile(receipt) {
  const target = await materializeControlRelease(receipt.targetReleaseId, receipt.targetReleaseDigest)
  await materializeControlRelease(receipt.predecessorReleaseId, receipt.predecessorReleaseDigest)
  if (receipt.phase === 'requested') receipt = await transition(receipt, 'activating', { previousSupervisorPid: await servicePid('agent-runlab-dedicated-deploy-supervisor.service'), previousIngressPid: await servicePid('agent-runlab-dedicated-ingress.service') })
  if (receipt.phase === 'activating') {
    await installControlRelease(target)
    receipt = await transition(receipt, 'ingress_restarting', { activatedAt: new Date().toISOString() })
  }
  if (receipt.phase === 'ingress_restarting') {
    if (await servicePid('agent-runlab-dedicated-ingress.service').catch(() => 0) === receipt.previousIngressPid) await systemctl('restart', 'agent-runlab-dedicated-ingress.service')
    const ingressPid = await waitForNewPid('agent-runlab-dedicated-ingress.service', receipt.previousIngressPid)
    await waitForIngressReady(ingressPid)
    receipt = await transition(receipt, 'ingress_ready', { ingressPid })
  }
  if (receipt.phase === 'ingress_ready') receipt = await transition(receipt, 'supervisor_restarting', { supervisorRestartRequestedAt: new Date().toISOString() })
  if (receipt.phase === 'supervisor_restarting') {
    if (await servicePid('agent-runlab-dedicated-deploy-supervisor.service').catch(() => 0) === receipt.previousSupervisorPid) await systemctl('restart', 'agent-runlab-dedicated-deploy-supervisor.service')
    const supervisorPid = await waitForSupervisorReady(receipt.previousSupervisorPid, receipt.supervisorRestartRequestedAt)
    await activate(updaterLink, target)
    receipt = await transition(receipt, 'completed', { supervisorPid, readyAt: new Date().toISOString() })
  }
  return receipt
}

async function rollback(receipt, cause) {
  const message = redact(cause)
  try {
    if (receipt.phase !== 'rolling_back') receipt = await transition(receipt, 'rolling_back', { error: message })
    const predecessor = await materializeControlRelease(receipt.predecessorReleaseId, receipt.predecessorReleaseDigest)
    await installControlRelease(predecessor)
    const ingressBefore = await servicePid('agent-runlab-dedicated-ingress.service').catch(() => 0)
    await systemctl('restart', 'agent-runlab-dedicated-ingress.service')
    const ingressPid = await waitForNewPid('agent-runlab-dedicated-ingress.service', ingressBefore)
    await waitForIngressReady(ingressPid)
    const supervisorBefore = await servicePid('agent-runlab-dedicated-deploy-supervisor.service').catch(() => 0)
    const supervisorRestartRequestedAt = new Date().toISOString()
    await systemctl('restart', 'agent-runlab-dedicated-deploy-supervisor.service')
    const supervisorPid = await waitForSupervisorReady(supervisorBefore, supervisorRestartRequestedAt)
    await activate(updaterLink, predecessor)
    receipt = await transition(receipt, 'rolled_back', {
      previousIngressPid: receipt.previousIngressPid ?? ingressBefore,
      previousSupervisorPid: receipt.previousSupervisorPid ?? supervisorBefore,
      ingressPid, supervisorPid, supervisorRestartRequestedAt, readyAt: new Date().toISOString(), error: message,
    })
    return receipt
  } catch (rollbackError) {
    return await transition(receipt, 'rollback_failed', { error: redact(`${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`) })
  }
}

async function installControlRelease(release) {
  await ensureIndependentDashboard(release)
  for (const unit of units) await copyAtomic(join(release, unit.asset), join(unitDir, unit.service), 0o644)
  await copyAtomic(join(release, 'deployment.json'), deploymentConfig, 0o644)
  await activate(controlLink, release)
  await systemctl('daemon-reload')
}

async function ensureIndependentDashboard(release) {
  const dashboardRoot = join(deployRoot, 'dashboard')
  const statePath = join(dashboardRoot, 'route-state.json')
  const releasesRoot = join(dashboardRoot, 'releases')
  await mkdir(releasesRoot, { recursive: true, mode: 0o750 })
  // Stable Ingress is deliberately unprivileged. Keep operational metadata
  // private to the service group while guaranteeing that it can traverse the
  // release parents. This also repairs directories created by older updaters
  // whose root UMask produced root:root 0700 parents.
  await command(chownBinary, ['root:agent-runlab', dashboardRoot, releasesRoot])
  await chmod(dashboardRoot, 0o750)
  await chmod(releasesRoot, 0o750)
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 1 || !releaseId(state.releaseId) || !digest(state.releaseDigest)) throw new Error('existing Dashboard route state is invalid')
    await command(chownBinary, ['root:agent-runlab', statePath])
    await chmod(statePath, 0o640)
    return
  } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const modern = await pathExists(join(release, 'kala-dashboard.tar.gz'))
  const archiveEntries = readExactTarGz(await readFile(join(release, modern ? 'kala-dashboard.tar.gz' : 'kala-dashboard-dist.tar.gz')), 'Dashboard')
  const manifestBytes = modern ? archiveEntries.get('dashboard-release.json') : await readFile(join(release, 'dashboard-release.json'))
  if (!manifestBytes) throw new Error('Dashboard archive is missing dashboard-release.json')
  const manifest = JSON.parse(String(manifestBytes))
  verifyDashboardArchive(archiveEntries, manifest, modern)
  const initialReleaseId = basename(release)
  const target = join(releasesRoot, initialReleaseId)
  await mkdir(join(dashboardRoot, 'requests'), { recursive: true, mode: 0o3770 })
  await mkdir(join(dashboardRoot, 'submissions'), { recursive: true, mode: 0o3770 })
  await mkdir(join(dashboardRoot, 'receipts'), { recursive: true, mode: 0o750 })
  try { await lstat(target); throw new Error('initial Dashboard release target already exists without route state') } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const incoming = `${target}.incoming-${process.pid}`
  await mkdir(join(incoming, 'assets'), { recursive: true, mode: 0o755 })
  try {
    for (const entry of manifest.files) { const path = join(incoming, 'assets', ...entry.path.split('/')); await mkdir(dirname(path), { recursive: true, mode: 0o755 }); await writeFile(path, archiveEntries.get(entry.path), { flag: 'wx', mode: 0o644 }) }
    await verifyDashboardFiles(join(incoming, 'assets'), manifest.files)
    await writeFile(join(incoming, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 })
    await command('/usr/bin/chmod', ['-R', 'a-w', incoming])
    await rename(incoming, target); await syncDirectory(dirname(target))
  } finally { await rm(incoming, { recursive: true, force: true }) }
  await writeAtomic(statePath, `${JSON.stringify({ schemaVersion: 1, generation: 1, releaseId: initialReleaseId, releaseDigest: sha256(manifestBytes), assetDigest: manifest.assetDigest, version: manifest.version, protocol: manifest.protocol, activatedAt: new Date().toISOString() }, null, 2)}\n`, 0o640)
  await command(chownBinary, ['root:agent-runlab', statePath])
}

async function verifyDashboardFiles(root, expected) {
  const actual = []
  const walk = async (dir) => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isSymbolicLink()) throw new Error('Dashboard archive contains a symlink'); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) actual.push(path.slice(root.length + 1).replaceAll('\\', '/')); else throw new Error('Dashboard archive contains a non-file') } }
  await walk(root)
  const names = expected.map((entry) => entry.path).sort()
  if (JSON.stringify(actual.sort()) !== JSON.stringify(names)) throw new Error('Dashboard archive file set does not match manifest')
  for (const entry of expected) { const bytes = await readFile(join(root, entry.path)); if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Dashboard asset mismatch: ${entry.path}`) }
}
function verifyDashboardArchive(entries, manifest, embeddedManifest) {
  if (manifest?.schemaVersion !== 1 || manifest.product !== 'kala-dashboard' || !Array.isArray(manifest.files) || !manifest.files.some((entry) => entry.path === 'index.html') || !digest(manifest.assetDigest)) throw new Error('initial Dashboard manifest is invalid')
  const expected = [...manifest.files.map((entry) => entry.path), ...(embeddedManifest ? ['dashboard-release.json'] : [])].sort()
  if (new Set(expected).size !== expected.length || JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(expected)) throw new Error('Dashboard archive file set does not match manifest')
  const sorted = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))
  if (manifest.assetDigest !== sha256(Buffer.from(JSON.stringify(sorted)))) throw new Error('Dashboard manifest asset digest is invalid')
  for (const entry of manifest.files) { const bytes = entries.get(entry.path); if (!bytes || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !digest(entry.sha256) || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Dashboard asset mismatch: ${String(entry.path)}`) }
}

async function inspectRelease(path, releaseId, expectedDigest) {
  if (path !== releasePath(releaseId) || basename(path) !== releaseId) throw new Error('control release path escaped releases root')
  const directory = await lstat(path)
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o222) !== 0) throw new Error('control release is not immutable')
  const sumsBytes = await readFile(join(path, 'SHA256SUMS'))
  if (sha256(sumsBytes) !== expectedDigest) throw new Error('control release digest mismatch')
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
  if (!Array.isArray(manifest.assets)) throw new Error('control release assets are invalid')
  const bundled = manifest.assets.includes(supportArchive)
  const modern = bundled && manifest.assets.includes('kala-dashboard.tar.gz')
  if (bundled ? manifest.assets.some((name) => supportAssets.includes(name)) : (!units.every(({ asset }) => manifest.assets.includes(asset)) || !manifest.assets.includes('deployment.json') || !manifest.assets.includes('update-dedicated-control-plane.mjs'))) throw new Error('control release support assets are incomplete')
  if (manifest.assets.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(name) || ['manifest.json', 'SHA256SUMS', 'RELEASE_NOTES.md'].includes(name))) throw new Error('invalid control release manifest asset')
  const sumLines = String(sumsBytes).trim().split('\n')
  const sums = new Map(sumLines.map((line) => { const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u.exec(line); if (!match) throw new Error('invalid control release checksum entry'); return [match[2], match[1]] }))
  const expectedFiles = [...manifest.assets, 'manifest.json', ...(!modern ? ['RELEASE_NOTES.md'] : [])].sort()
  if (new Set(expectedFiles).size !== expectedFiles.length || sums.size !== sumLines.length || JSON.stringify([...sums.keys()].sort()) !== JSON.stringify(expectedFiles)) throw new Error('control release manifest and checksum file set differ')
  const signature = await pathExists(join(path, 'SHA256SUMS.sigstore.json')) ? ['SHA256SUMS.sigstore.json'] : []
  const outerFiles = [...expectedFiles, 'SHA256SUMS', ...signature].sort()
  const expandedFiles = [...outerFiles, ...(bundled ? supportAssets : [])].sort()
  const actual = await readdir(path, { withFileTypes: true })
  const actualNames = actual.map((entry) => entry.name).sort()
  const rawExact = JSON.stringify(actualNames) === JSON.stringify(outerFiles)
  const expandedExact = bundled && JSON.stringify(actualNames) === JSON.stringify(expandedFiles)
  if (actual.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || !rawExact && !expandedExact) throw new Error('control release file set is not exact')
  for (const name of outerFiles) {
    const file = await lstat(join(path, name))
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o222) !== 0) throw new Error(`control release asset is not immutable: ${name}`)
    if (!['SHA256SUMS', 'SHA256SUMS.sigstore.json'].includes(name) && sha256(await readFile(join(path, name))) !== sums.get(name)) throw new Error(`control asset checksum mismatch: ${name}`)
  }
  const supportEntries = bundled
    ? verifySupportArchive(await readFile(join(path, supportArchive)))
    : new Map(await Promise.all(supportAssets.map(async (name) => [name, await readFile(join(path, name))])))
  if (expandedExact) await verifyExpandedSupport(path, supportEntries)
  return { path, outerFiles, snapshotFiles: [...new Set([...outerFiles, ...supportAssets])].sort(), supportEntries, bundled }
}

function verifySupportArchive(bytes) {
  const entries = readExactTarGz(bytes, 'Dedicated support')
  const expected = [...supportAssets, supportManifest].sort()
  if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(expected)) throw new Error('Dedicated support archive entries are unsafe or incomplete')
  let manifest
  try { manifest = JSON.parse(String(entries.get(supportManifest))) } catch { throw new Error('invalid Dedicated support manifest') }
  if (manifest?.schemaVersion !== 1 || manifest.product !== 'kala-dedicated-support' || JSON.stringify(manifest.assets?.map((entry) => entry.name)) !== JSON.stringify(supportAssets)) throw new Error('invalid Dedicated support manifest')
  for (const entry of manifest.assets) {
    const archived = entries.get(entry.name)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !digest(entry.sha256) || archived.length !== entry.bytes || sha256(archived) !== entry.sha256) throw new Error('invalid Dedicated support manifest asset')
  }
  return new Map(supportAssets.map((name) => [name, entries.get(name)]))
}

async function verifyExpandedSupport(root, supportEntries) {
  for (const [name, archived] of supportEntries) {
    const file = await lstat(join(root, name)); const bytes = await readFile(join(root, name))
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o222) !== 0 || !bytes.equals(archived)) throw new Error(`Dedicated support asset is mutable or mismatched: ${name}`)
  }
}

async function materializeControlRelease(releaseId, releaseDigest) {
  const inspected = await inspectRelease(releasePath(releaseId), releaseId, releaseDigest)
  await mkdir(controlReleasesRoot, { recursive: true, mode: 0o711 })
  // The updater service uses UMask=0077, while Stable Ingress and the
  // Supervisor run unprivileged. Explicitly restore traverse-only access.
  await chmod(controlReleasesRoot, 0o711)
  const parent = join(controlReleasesRoot, `${releaseId}-${releaseDigest}`)
  const target = join(parent, releaseId)
  try {
    await verifyControlSnapshot(target, inspected)
    return target
  } catch (error) {
    try { await lstat(parent) } catch (statError) { if (statError?.code === 'ENOENT') return await publishControlSnapshot(parent, target, releaseId, inspected); throw statError }
    throw new Error(`immutable control snapshot already exists with different content: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function publishControlSnapshot(parent, target, releaseId, inspected) {
  const incoming = join(controlReleasesRoot, `.incoming-${releaseId}-${randomBytes(12).toString('hex')}`)
  const snapshot = join(incoming, releaseId)
  await mkdir(snapshot, { recursive: true, mode: 0o700 })
  try {
    for (const name of inspected.outerFiles) await copyFile(join(inspected.path, name), join(snapshot, name))
    if (inspected.bundled) for (const [name, bytes] of inspected.supportEntries) await writeFile(join(snapshot, name), bytes, { flag: 'wx', mode: 0o444 })
    await verifyControlSnapshot(snapshot, inspected, false)
    for (const name of inspected.snapshotFiles) {
      const path = join(snapshot, name); const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() }; await chmod(path, 0o444)
    }
    await chmod(snapshot, 0o555); await chmod(incoming, 0o555)
    const directory = await open(snapshot, 'r'); try { await directory.sync() } finally { await directory.close() }
    await rename(incoming, parent); await syncDirectory(controlReleasesRoot)
    await verifyControlSnapshot(target, inspected)
    return target
  } finally {
    await chmod(snapshot, 0o700).catch(() => undefined)
    await chmod(incoming, 0o700).catch(() => undefined)
    await rm(incoming, { recursive: true, force: true })
  }
}

async function verifyControlSnapshot(path, inspected, immutable = true) {
  const directory = await lstat(path)
  if (!directory.isDirectory() || directory.isSymbolicLink() || immutable && (directory.mode & 0o222) !== 0) throw new Error('control snapshot is not immutable')
  const actual = await readdir(path, { withFileTypes: true })
  if (actual.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || JSON.stringify(actual.map((entry) => entry.name).sort()) !== JSON.stringify(inspected.snapshotFiles)) throw new Error('control snapshot file set is not exact')
  for (const name of inspected.snapshotFiles) {
    const file = await lstat(join(path, name))
    if (!file.isFile() || file.isSymbolicLink() || immutable && (file.mode & 0o222) !== 0) throw new Error(`control snapshot asset is not immutable: ${name}`)
    const expected = inspected.supportEntries.get(name) ?? await readFile(join(inspected.path, name))
    if (!(await readFile(join(path, name))).equals(expected)) throw new Error(`control snapshot asset mismatch: ${name}`)
  }
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
async function pathExists(path) { try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
function validateRequest(value) {
  const allowed = new Set(['schemaVersion', 'updateId', 'deploymentId', 'direction', 'targetReleaseId', 'targetReleaseDigest', 'predecessorReleaseId', 'predecessorReleaseDigest', 'requestedAt'])
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key)) || value.schemaVersion !== 1 || !identifier(value.updateId) || !identifier(value.deploymentId) || !['forward', 'rollback'].includes(value.direction) || !releaseId(value.targetReleaseId) || !digest(value.targetReleaseDigest) || !releaseId(value.predecessorReleaseId) || !digest(value.predecessorReleaseDigest) || !timestamp(value.requestedAt)) throw new Error('invalid Dedicated control update request')
  return value
}

function validateReceipt(value) {
  const allowed = new Set([
    'schemaVersion', 'revision', 'updateId', 'deploymentId', 'direction', 'phase',
    'targetReleaseId', 'targetReleaseDigest', 'predecessorReleaseId', 'predecessorReleaseDigest',
    'requestedAt', 'updatedAt', 'previousSupervisorPid', 'previousIngressPid', 'activatedAt',
    'ingressPid', 'supervisorRestartRequestedAt', 'supervisorPid', 'readyAt', 'error',
  ])
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))
    || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !identifier(value.updateId) || !identifier(value.deploymentId) || !['forward', 'rollback'].includes(value.direction)
    || !Object.hasOwn(transitions, value.phase) || !releaseId(value.targetReleaseId) || !digest(value.targetReleaseDigest)
    || !releaseId(value.predecessorReleaseId) || !digest(value.predecessorReleaseDigest)
    || !timestamp(value.requestedAt) || !timestamp(value.updatedAt)) throw new Error('invalid Dedicated control update receipt')
  for (const key of ['previousSupervisorPid', 'previousIngressPid', 'ingressPid', 'supervisorPid']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw new Error(`invalid control update receipt ${key}`)
  }
  for (const key of ['activatedAt', 'supervisorRestartRequestedAt', 'readyAt']) if (value[key] !== undefined && !timestamp(value[key])) throw new Error(`invalid control update receipt ${key}`)
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length < 1 || value.error.length > 1000)) throw new Error('invalid control update receipt error')
  if (!['requested', 'rolling_back', 'rollback_failed'].includes(value.phase) && (!value.previousSupervisorPid || !value.previousIngressPid)) throw new Error('control update receipt lacks predecessor pids')
  if (['ingress_restarting', 'ingress_ready', 'supervisor_restarting', 'completed'].includes(value.phase) && !value.activatedAt) throw new Error('control update receipt lacks activation time')
  if (['ingress_ready', 'supervisor_restarting', 'completed'].includes(value.phase) && !value.ingressPid) throw new Error('control update receipt lacks ingress readiness')
  if (['supervisor_restarting', 'completed'].includes(value.phase) && !value.supervisorRestartRequestedAt) throw new Error('control update receipt lacks Supervisor restart fence')
  if (value.phase === 'completed' && (!value.supervisorPid || !value.readyAt)) throw new Error('completed control update receipt lacks readiness')
  if (['rolled_back', 'rollback_failed'].includes(value.phase) && !value.error) throw new Error('control rollback receipt lacks diagnostics')
  return value
}

async function readReceipt(path = receiptPath) {
  try { return validateReceipt(JSON.parse(await readFile(path, 'utf8'))) } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
}
async function persist(receipt) { validateReceipt(receipt); await writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o640) }
async function transition(receipt, phase, patch = {}) {
  if (!transitions[receipt.phase]?.has(phase)) throw new Error(`invalid control update transition: ${receipt.phase} -> ${phase}`)
  const next = { ...receipt, ...patch, phase, revision: receipt.revision + 1, updatedAt: new Date().toISOString() }
  await persist(next); return next
}
function assertSameRequest(receipt, request) { for (const key of ['updateId', 'deploymentId', 'direction', 'targetReleaseId', 'targetReleaseDigest', 'predecessorReleaseId', 'predecessorReleaseDigest', 'requestedAt']) if (receipt[key] !== request[key]) throw new Error('control update receipt conflicts with request') }
function releasePath(id) { return resolve(deployRoot, 'releases', id) }
async function activate(link, target) { const temp = `${link}.next-${process.pid}`; await rm(temp, { force: true }); await symlink(target, temp); await rename(temp, link); await syncDirectory(dirname(link)) }
async function copyAtomic(source, target, mode) { const temp = `${target}.next-${process.pid}`; await copyFile(source, temp); await chmod(temp, mode); const file = await open(temp, 'r'); try { await file.sync() } finally { await file.close() }; await rename(temp, target); await syncDirectory(dirname(target)) }
async function writeAtomic(path, value, mode) { await mkdir(dirname(path), { recursive: true, mode: 0o750 }); const temp = `${path}.next-${process.pid}`; const file = await open(temp, 'wx', mode); try { await file.writeFile(value); await file.sync() } finally { await file.close() }; await rename(temp, path); await syncDirectory(dirname(path)) }
async function syncDirectory(path) { const directory = await open(path, 'r'); try { await directory.sync() } finally { await directory.close() } }
async function systemctl(...args) { await command(systemctlBinary, args) }
async function servicePid(service) { const value = Number((await command(systemctlBinary, ['show', '--property=MainPID', '--value', service], true)).trim()); if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${service} has no live pid`); return value }
async function waitForPid(service) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { const pid = await servicePid(service); const active = (await command(systemctlBinary, ['is-active', service], true)).trim(); if (active === 'active') return pid } catch {}; await delay(100) }; throw new Error(`${service} did not become ready`) }
async function waitForNewPid(service, previous) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { const pid = await waitForPid(service); if (pid !== previous) return pid; await delay(100) }; throw new Error(`${service} pid did not change`) }
async function waitForIngressReady(expectedPid) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const readiness = JSON.parse(await readFile(ingressReadinessPath, 'utf8'))
      if (readiness?.schemaVersion === 1 && readiness.pid === expectedPid && timestamp(readiness.readyAt)) return
    } catch {}
    await delay(100)
  }
  throw new Error('Dedicated Ingress did not publish matching readiness')
}
async function waitForSupervisorReady(previousPid, restartRequestedAt) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const pid = await waitForPid('agent-runlab-dedicated-deploy-supervisor.service')
      const status = JSON.parse(await readFile(operatorStatusPath, 'utf8'))
      if (pid !== previousPid && status?.schemaVersion === 1 && status.services?.supervisor?.pid === pid
        && timestamp(status.generatedAt) && Date.parse(status.generatedAt) >= Date.parse(restartRequestedAt)) return pid
    } catch {}
    await delay(100)
  }
  throw new Error('Dedicated Supervisor did not publish matching readiness')
}
async function command(file, args, capture = false) { return await new Promise((resolveCommand, reject) => { const child = spawn(file, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'pipe'] }); let stdout = ''; let stderr = ''; child.stdout?.on('data', (chunk) => { stdout += String(chunk) }); child.stderr?.on('data', (chunk) => { stderr += String(chunk) }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolveCommand(stdout) : reject(new Error(`${basename(file)} exited ${String(code)}: ${stderr}`))) }) }
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)
const releaseId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const redact = (error) => (error instanceof Error ? error.message : String(error)).replaceAll(/(?:[A-Za-z]:)?[\/][^\s;]+/gu, '<path>').replaceAll(/(?:token|secret|password|credential|key)=[^\s;]+/giu, '$1=<redacted>').slice(0, 1000)

await main()

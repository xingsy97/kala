#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const argv = process.argv.slice(2)
if (argv[0] === '--') argv.shift()
const command = argv[0]
// Help is platform-independent; validate Linux-only installation roots only
// when executing an operator command, not while inspecting a release on Windows.
if (!command || ['-h', '--help', 'help'].includes(command)) { help(); process.exit(0) }
const scriptDir = dirname(fileURLToPath(import.meta.url))
const dataRoot = boundedRoot(process.env.AGENT_RUNLAB_DATA_ROOT ?? '/var/lib/agent-runlab', 'data root')
const installRoot = boundedRoot(process.env.AGENT_RUNLAB_INSTALL_ROOT ?? '/opt/agent-runlab', 'install root')
const configRoot = boundedRoot(process.env.AGENT_RUNLAB_CONFIG_ROOT ?? '/etc/agent-runlab', 'configuration root')
const systemdDir = boundedRoot(process.env.AGENT_RUNLAB_SYSTEMD_DIR ?? '/etc/systemd/system', 'systemd root')
const operatorRoot = boundedRoot(process.env.AGENT_RUNLAB_OPERATOR_ROOT ?? '/var/lib/agent-runlab-operator', 'operator root')
const operatorBin = resolve(process.env.AGENT_RUNLAB_OPERATOR_BIN ?? '/usr/local/bin/runlab-dedicated')
const deployRoot = join(dataRoot, 'deploy')
const services = [
  'agent-runlab-dedicated-ingress.service',
  'agent-runlab-dedicated-unit@blue.service',
  'agent-runlab-dedicated-unit@green.service',
  'agent-runlab-dedicated-deploy-supervisor.service',
  'agent-runlab-dedicated-control-updater.service',
  'agent-runlab-dedicated-migration-finalizer.service',
]
const persistentServices = services.slice(0, 4)
const unitFiles = [
  'agent-runlab-dedicated-ingress.service',
  'agent-runlab-dedicated-unit@.service',
  'agent-runlab-dedicated-deploy-supervisor.service',
  'agent-runlab-dedicated-control-updater.service',
  'agent-runlab-dedicated-migration-finalizer.service',
]
const terminalDeploymentPhases = new Set(['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed'])
const lifecycleTransitions = new Map([
  ['planned', new Set(['waiting_for_boundary', 'verified', 'failed'])],
  ['waiting_for_boundary', new Set(['reserved', 'failed'])],
  ['verified', new Set(['waiting_for_boundary', 'services_started', 'failed'])],
  ['reserved', new Set(['services_stopped', 'failed'])],
  ['services_stopped', new Set(['archived', 'extracted', 'failed'])],
  ['archived', new Set(['verified', 'failed'])],
  ['extracted', new Set(['targets_replaced', 'failed'])],
  ['targets_replaced', new Set(['units_restored', 'failed'])],
  ['units_restored', new Set(['services_started', 'failed'])],
  ['services_started', new Set(['completed', 'failed'])],
  ['completed', new Set()], ['failed', new Set()],
])

if (!['install', 'status', 'upgrade', 'rollback', 'backup', 'restore', 'uninstall'].includes(command)) fail(`unknown command ${command}`)
if (command !== 'status') requireRoot()

try {
  if (command === 'install') await install()
  else if (command === 'status') status()
  else if (command === 'upgrade') await deploy('stage')
  else if (command === 'rollback') await deploy('rollback')
  else if (command === 'backup') await backup()
  else if (command === 'restore') await restore()
  else if (command === 'uninstall') await uninstall()
} catch (error) {
  process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`)
  process.exitCode = 1
}

function help() {
  process.stdout.write(`Kala Dedicated operator

Usage:
  runlab-dedicated install --release-dir <dir> [--stage-only] [--legacy-data-root <dir>]
  runlab-dedicated status
  runlab-dedicated upgrade --release-dir <dir> [--operation-id <id>] [--no-wait]
  runlab-dedicated rollback <deployment-id> [--operation-id <id>] [--no-wait]
  runlab-dedicated backup --output <persistent-empty-dir> [--operation-id <id>]
  runlab-dedicated restore --backup <dir> --confirm RESTORE:<backup-id> [--operation-id <id>]
  runlab-dedicated uninstall --confirm UNINSTALL:<installation-id>

Install, backup, restore, and uninstall operate only on the bounded local Dedicated
installation. Upgrade and rollback use the Deploy Supervisor request/receipt protocol.
Uninstall preserves all data, private configuration, releases, receipts, and backups.
`)
}

async function install() {
  assertNoLiveLifecycle()
  const releaseDir = releaseDirectory()
  const release = inspectRelease(releaseDir)
  const releaseId = option('--release-id') ?? `release-${release.version}-${release.releaseDigest.slice(0, 12)}`
  identifier(releaseId, 'release id')
  const installer = join(releaseDir, 'install-dedicated-systemd.mjs')
  if (!existsSync(installer)) throw new Error('release does not contain the Dedicated installer')
  const legacyDataRoot = option('--legacy-data-root')
  if (legacyDataRoot) boundedRoot(legacyDataRoot, 'legacy data root')
  run(process.execPath, [installer, releaseDir], {
    env: {
      ...process.env, AGENT_RUNLAB_INSTALL_ROOT: installRoot, AGENT_RUNLAB_DATA_ROOT: dataRoot,
      AGENT_RUNLAB_SYSTEMD_DIR: systemdDir, AGENT_RUNLAB_RELEASE_ID: releaseId,
      ...(legacyDataRoot ? { AGENT_RUNLAB_LEGACY_DATA_ROOT: resolve(legacyDataRoot) } : {}),
    },
  })
  mkdirSync(operatorRoot, { recursive: true, mode: 0o700 })
  const installationPath = join(operatorRoot, 'installation.json')
  const existing = readJsonOptional(installationPath)
  const installationId = existing?.installationId ?? `installation-${randomUUID()}`
  const installedAt = existing?.installedAt ?? now()
  writeAtomicJson(installationPath, { schemaVersion: 1, installationId, installedAt, updatedAt: now(), dataRoot, installRoot, configRoot, systemdDir })
  installOperatorLink(join(deployRoot, 'control-current', 'runlab-dedicated.mjs'))
  if (has('--stage-only')) {
    output({ ok: true, phase: 'installed_disabled', installationId, releaseId, releaseDigest: release.releaseDigest })
    return
  }
  run('systemctl', ['start', '--no-block', 'agent-runlab-dedicated-migration-finalizer.service'])
  const receipt = await waitForMigration()
  if (receipt.phase !== 'cutover_completed') throw new Error(`installation ended in ${receipt.phase}`)
  output({ ok: true, phase: receipt.phase, installationId, releaseId, releaseDigest: release.releaseDigest })
}

function status() {
  const installation = readJsonOptional(join(operatorRoot, 'installation.json'))
  const migration = readJsonOptional(join(deployRoot, 'migration-receipt.json'))
  const route = readJsonOptional(join(deployRoot, 'route-state.json'))
  const receipts = existsSync(join(deployRoot, 'receipts'))
    ? readdirSync(join(deployRoot, 'receipts')).filter((name) => name.endsWith('.json')).map((name) => readJsonOptional(join(deployRoot, 'receipts', name))).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    : []
  output({
    installed: Boolean(installation || migration), installation, migration: migration ? redactObject(migration) : null,
    route, services: Object.fromEntries(services.map((service) => [service, serviceState(service)])),
    deployment: receipts[0] ? redactObject(receipts[0]) : null,
  })
}

async function deploy(action) {
  assertInstalledAndLive()
  assertNoLiveLifecycle()
  const client = join(deployRoot, 'control-current', 'deploy-dedicated.mjs')
  if (!existsSync(client)) throw new Error('installed Deploy Supervisor client is missing')
  const operationId = option('--operation-id') ?? `operation-${action}-${randomUUID()}`
  identifier(operationId, 'operation id')
  const args = action === 'stage'
    ? [client, 'stage', '--local', '--skip-build', '--release-dir', releaseDirectory(), '--deploy-root', deployRoot, '--operation-id', operationId]
    : [client, 'rollback', requiredPositional(1, 'deployment id'), '--local', '--deploy-root', deployRoot, '--operation-id', operationId]
  const accepted = runJson(process.execPath, args)
  output(accepted)
  if (has('--no-wait')) return
  run(process.execPath, [client, 'wait', accepted.deploymentId, '--local', '--deploy-root', deployRoot, '--timeout-ms', option('--timeout-ms') ?? '3720000'], { stdio: 'inherit' })
}

async function backup() {
  assertInstalledAndLive()
  assertNoDeployment()
  assertNoLiveLifecycle()
  const outputDir = boundedRoot(requiredOption('--output'), 'backup output')
  if (isInside(outputDir, dataRoot) || isInside(outputDir, installRoot) || isInside(outputDir, configRoot) || isInside(outputDir, operatorRoot)) throw new Error('backup output must be outside installation roots')
  ensureEmptyPrivateDirectory(outputDir)
  const operationId = option('--operation-id') ?? `operation-backup-${randomUUID()}`
  identifier(operationId, 'operation id')
  const backupId = `backup-${new Date().toISOString().replaceAll(/[^0-9A-Za-z]/gu, '')}-${randomBytes(5).toString('hex')}`
  let receipt = createLifecycle(operationId, 'backup', { backupId, outputDir })
  const serviceStates = Object.fromEntries(persistentServices.map((service) => [service, serviceState(service)]))
  const active = Object.entries(serviceStates).filter(([, state]) => state.activeState === 'active').map(([service]) => service)
  try {
    receipt = transition(receipt, 'waiting_for_boundary', { services: active })
    const reservation = await reserveBoundary()
    receipt = transition(receipt, 'reserved', { reservation })
    stopServices(active)
    receipt = transition(receipt, 'services_stopped')
    const archives = [
      archiveDirectory(outputDir, 'data.tar', dataRoot),
      archiveDirectory(outputDir, 'install.tar', installRoot),
      archiveDirectory(outputDir, 'config.tar', configRoot),
      archiveUnits(outputDir),
    ]
    receipt = transition(receipt, 'archived', { archives: archives.map(({ source: _source, ...entry }) => entry) })
    const manifest = {
      schemaVersion: 1, backupId, createdAt: now(), installationId: installationId(),
      targets: { dataRoot, installRoot, configRoot, systemdDir },
      archives: Object.fromEntries(archives.map(({ name, bytes, sha256 }) => [name, { bytes, sha256 }])),
      units: unitFiles, serviceStates,
    }
    writeAtomicJson(join(outputDir, 'manifest.json'), manifest)
    verifyBackup(outputDir, manifest, archives)
    receipt = transition(receipt, 'verified', { manifestSha256: sha256(readFileSync(join(outputDir, 'manifest.json'))) })
    startServices(active)
    receipt = transition(receipt, 'services_started')
    await waitForPublicReady()
    receipt = transition(receipt, 'completed', { completedAt: now() })
    output({ ok: true, backupId, confirmation: `RESTORE:${backupId}`, receipt: publicLifecycle(receipt), manifest: { archives: manifest.archives } })
  } catch (error) {
    startServices(active, true)
    await releaseBoundary().catch(() => undefined)
    failLifecycle(receipt, error)
    throw error
  }
}

async function restore() {
  assertInstalledAndLive()
  assertNoDeployment()
  assertNoLiveLifecycle()
  const backupDir = boundedRoot(requiredOption('--backup'), 'backup root')
  const manifest = loadAndVerifyManifest(backupDir)
  if (requiredOption('--confirm') !== `RESTORE:${manifest.backupId}`) throw new Error(`confirmation must equal RESTORE:${manifest.backupId}`)
  if (manifest.installationId !== installationId()) throw new Error('backup belongs to a different Dedicated installation')
  assertBackupTargets(manifest.targets)
  const operationId = option('--operation-id') ?? `operation-restore-${randomUUID()}`
  identifier(operationId, 'operation id')
  let receipt = createLifecycle(operationId, 'restore', { backupId: manifest.backupId, backupDir })
  const currentStates = Object.fromEntries(persistentServices.map((service) => [service, serviceState(service)]))
  const active = Object.entries(manifest.serviceStates).filter(([, state]) => state.activeState === 'active').map(([service]) => service)
  const staged = []
  const replaced = []
  const unitRecoveryRoot = join(operatorRoot, 'recovery', operationId)
  try {
    receipt = transition(receipt, 'verified', { manifestSha256: sha256(readFileSync(join(backupDir, 'manifest.json'))), services: active })
    receipt = transition(receipt, 'waiting_for_boundary')
    const reservation = await reserveBoundary()
    receipt = transition(receipt, 'reserved', { reservation })
    stopServices(persistentServices)
    receipt = transition(receipt, 'services_stopped')
    for (const [archive, target, kind] of [['data.tar', dataRoot, 'data'], ['install.tar', installRoot, 'install'], ['config.tar', configRoot, 'config']]) staged.push(stageArchive(join(backupDir, archive), target, operationId, kind))
    receipt = transition(receipt, 'extracted')
    for (const item of staged) {
      const recovery = `${item.target}.runlab-recovery-${operationId}`
      if (existsSync(recovery)) throw new Error(`restore recovery target already exists for ${item.kind}`)
      if (existsSync(item.target)) renameSync(item.target, recovery)
      renameSync(item.staged, item.target)
      fsyncDirectory(dirname(item.target))
      replaced.push({ ...item, recovery })
    }
    receipt = transition(receipt, 'targets_replaced', { recoveryTargets: Object.fromEntries(replaced.map((item) => [item.kind, item.recovery])) })
    restoreUnits(backupDir, unitRecoveryRoot, operationId)
    run('systemctl', ['daemon-reload'])
    applyEnablement(manifest.serviceStates)
    receipt = transition(receipt, 'units_restored')
    startServices(active)
    receipt = transition(receipt, 'services_started')
    await waitForPublicReady()
    receipt = transition(receipt, 'completed', { completedAt: now(), recoveryTargets: Object.fromEntries(replaced.map((item) => [item.kind, item.recovery])), unitRecoveryRoot })
    output({ ok: true, backupId: manifest.backupId, receipt: publicLifecycle(receipt), recoveryRetained: true })
  } catch (error) {
    stopServices(persistentServices, true)
    for (const item of [...replaced].reverse()) {
      const failed = `${item.target}.failed-${operationId}`
      if (existsSync(item.target)) renameSync(item.target, failed)
      if (existsSync(item.recovery)) renameSync(item.recovery, item.target)
    }
    restoreRecoveredUnits(unitRecoveryRoot)
    run('systemctl', ['daemon-reload'], { allowFailure: true })
    applyEnablement(currentStates, true)
    startServices(Object.entries(currentStates).filter(([, state]) => state.activeState === 'active').map(([service]) => service), true)
    failLifecycle(receipt, error)
    throw error
  } finally {
    for (const item of staged) if (existsSync(item.staged)) rmSync(item.staged, { recursive: true, force: true })
  }
}

async function uninstall() {
  assertNoDeployment()
  assertNoLiveLifecycle()
  const id = installationId()
  if (requiredOption('--confirm') !== `UNINSTALL:${id}`) throw new Error(`confirmation must equal UNINSTALL:${id}`)
  stopServices(services, true)
  for (const service of services) run('systemctl', ['disable', service], { allowFailure: true })
  for (const name of unitFiles) rmSync(join(systemdDir, name), { force: true })
  run('systemctl', ['daemon-reload'])
  if (existsSync(operatorBin)) {
    const value = lstatSync(operatorBin)
    if (!value.isSymbolicLink()) throw new Error('refusing to remove operator path because it is not the installed symlink')
    const target = resolve(dirname(operatorBin), readlinkSync(operatorBin))
    if (!isInside(target, dataRoot)) throw new Error('refusing to remove operator symlink with an unexpected target')
    unlinkSync(operatorBin)
  }
  if (installRoot === '/' || installRoot.split('/').filter(Boolean).length < 2) throw new Error('unsafe install root')
  rmSync(installRoot, { recursive: true, force: true })
  const uninstallReceipt = { schemaVersion: 1, installationId: id, uninstalledAt: now(), preserved: [dataRoot, configRoot, operatorRoot] }
  writeAtomicJson(join(operatorRoot, 'uninstall-receipt.json'), uninstallReceipt)
  output({ ok: true, ...uninstallReceipt })
}

function createLifecycle(operationId, action, patch) {
  mkdirSync(join(operatorRoot, 'receipts'), { recursive: true, mode: 0o700 })
  const path = lifecyclePath(operationId)
  if (existsSync(path)) {
    const existing = readJson(path)
    if (existing.action !== action) throw new Error('operation id conflicts with another lifecycle action')
    throw new Error(`operation ${operationId} already exists in ${existing.phase}; inspect its recovery receipt and choose a new operation id only after recovery`)
  }
  const receipt = { schemaVersion: 1, revision: 1, operationId, action, phase: 'planned', requestedAt: now(), updatedAt: now(), ...patch }
  writeAtomicJson(path, receipt)
  return receipt
}
function transition(receipt, phase, patch = {}) {
  if (!lifecycleTransitions.get(receipt.phase)?.has(phase)) throw new Error(`invalid lifecycle transition ${receipt.phase} -> ${phase}`)
  const durable = readJson(lifecyclePath(receipt.operationId))
  if (durable.revision !== receipt.revision || durable.phase !== receipt.phase) throw new Error('lifecycle receipt changed before transition')
  const next = { ...receipt, ...patch, phase, revision: receipt.revision + 1, updatedAt: now() }
  writeAtomicJson(lifecyclePath(receipt.operationId), next)
  return next
}
function failLifecycle(receipt, error) {
  try { if (lifecycleTransitions.get(receipt.phase)?.has('failed')) transition(receipt, 'failed', { error: { code: 'operation_failed', message: redact(error instanceof Error ? error.message : String(error)).slice(0, 1000), at: now() } }) } catch {}
}
function lifecyclePath(operationId) { return join(operatorRoot, 'receipts', `${operationId}.json`) }
function publicLifecycle(receipt) { const { outputDir: _output, backupDir: _backup, recoveryRoot: _recovery, recoveryTargets: _targets, unitRecoveryRoot: _units, ...safe } = receipt; return safe }

function archiveDirectory(outputDir, name, source) {
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`backup source is missing: ${source}`)
  const path = join(outputDir, name)
  run('tar', ['--numeric-owner', '--xattrs', '--acls', '-cpf', path, '-C', dirname(source), basename(source)])
  fsyncFile(path)
  return { name, path, source, bytes: statSync(path).size, sha256: fileSha256(path) }
}
function archiveUnits(outputDir) {
  for (const name of unitFiles) if (!existsSync(join(systemdDir, name))) throw new Error(`installed unit file is missing: ${name}`)
  const name = 'systemd-units.tar'
  const path = join(outputDir, name)
  run('tar', ['--numeric-owner', '--xattrs', '--acls', '-cpf', path, '-C', systemdDir, ...unitFiles])
  fsyncFile(path)
  return { name, path, source: systemdDir, bytes: statSync(path).size, sha256: fileSha256(path) }
}
function verifyBackup(outputDir, manifest, archives) {
  const verificationRoot = join(outputDir, `.restore-verification-${randomBytes(8).toString('hex')}`)
  mkdirSync(verificationRoot, { mode: 0o700 })
  try {
    for (const archive of archives) {
      const restored = join(verificationRoot, archive.name.slice(0, -4)); mkdirSync(restored, { mode: 0o700 })
      run('tar', ['--numeric-owner', '--xattrs', '--acls', '-xpf', archive.path, '-C', restored])
      run('tar', ['--compare', '--numeric-owner', '--xattrs', '--acls', '-f', archive.path, '-C', restored])
      if (archive.name !== 'systemd-units.tar') run('tar', ['--compare', '--numeric-owner', '--xattrs', '--acls', '-f', archive.path, '-C', dirname(archive.source)])
    }
  } finally {
    rmSync(verificationRoot, { recursive: true, force: true })
  }
  loadAndVerifyManifest(outputDir, manifest)
}
function loadAndVerifyManifest(root, supplied) {
  const manifest = supplied ?? readJson(join(root, 'manifest.json'))
  if (manifest?.schemaVersion !== 1 || typeof manifest.backupId !== 'string' || !manifest.backupId.startsWith('backup-') || !manifest.archives || !manifest.targets || !Array.isArray(manifest.units) || !manifest.serviceStates) throw new Error('invalid Dedicated backup manifest')
  if (JSON.stringify(manifest.units) !== JSON.stringify(unitFiles)) throw new Error('backup unit set does not match this operator version')
  if (JSON.stringify(Object.keys(manifest.serviceStates).sort()) !== JSON.stringify([...persistentServices].sort())) throw new Error('backup service-state set does not match this operator version')
  for (const state of Object.values(manifest.serviceStates)) if (!['active', 'inactive'].includes(state?.activeState) || !['enabled', 'disabled', 'static', 'indirect'].includes(state?.unitFileState)) throw new Error('invalid backup service state')
  for (const name of ['data.tar', 'install.tar', 'config.tar', 'systemd-units.tar']) {
    const expected = manifest.archives[name]
    const path = join(root, name)
    if (!expected || !Number.isSafeInteger(expected.bytes) || !/^[a-f0-9]{64}$/u.test(expected.sha256) || !existsSync(path) || statSync(path).size !== expected.bytes || fileSha256(path) !== expected.sha256) throw new Error(`backup archive verification failed: ${name}`)
    assertSafeArchive(path, name === 'systemd-units.tar' ? unitFiles : undefined)
  }
  return manifest
}
function assertSafeArchive(path, exactFiles) {
  const listing = capture('tar', ['-tf', path]).trim().split('\n').filter(Boolean)
  if (listing.some((entry) => entry.startsWith('/') || entry.split('/').some((part) => part === '..'))) throw new Error('backup archive contains an unsafe path')
  if (exactFiles && JSON.stringify(listing.sort()) !== JSON.stringify([...exactFiles].sort())) throw new Error('backup unit archive file set changed')
}
function stageArchive(archive, target, operationId, kind) {
  assertSafeArchive(archive)
  const parent = dirname(target); mkdirSync(parent, { recursive: true, mode: 0o700 })
  const stagingRoot = join(parent, `.runlab-restore-${basename(target)}-${operationId}`)
  if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true })
  mkdirSync(stagingRoot, { mode: 0o700 })
  run('tar', ['--numeric-owner', '--xattrs', '--acls', '-xpf', archive, '-C', stagingRoot])
  run('tar', ['--compare', '--numeric-owner', '--xattrs', '--acls', '-f', archive, '-C', stagingRoot])
  const entries = readdirSync(stagingRoot)
  if (entries.length !== 1 || entries[0] !== basename(target) || !statSync(join(stagingRoot, entries[0])).isDirectory()) throw new Error('restored archive root does not match target')
  const staged = join(parent, `.runlab-restored-${basename(target)}-${operationId}`)
  if (existsSync(staged)) rmSync(staged, { recursive: true, force: true })
  renameSync(join(stagingRoot, entries[0]), staged); rmSync(stagingRoot, { recursive: true, force: true })
  if (statSync(parent).dev !== statSync(staged).dev) throw new Error('restore staging is not on the target filesystem')
  return { kind, target, staged }
}
function restoreUnits(backupDir, recoveryRoot, operationId) {
  const staged = join(systemdDir, `.runlab-units-${operationId}`)
  mkdirSync(staged, { mode: 0o700 })
  try {
    run('tar', ['--numeric-owner', '--xattrs', '--acls', '-xpf', join(backupDir, 'systemd-units.tar'), '-C', staged])
    const recovery = join(recoveryRoot, 'systemd-units'); mkdirSync(recovery, { recursive: true, mode: 0o700 })
    for (const name of unitFiles) {
      if (existsSync(join(systemdDir, name))) writeAtomic(join(recovery, name), readFileSync(join(systemdDir, name)), 0o600)
      writeAtomic(join(systemdDir, name), readFileSync(join(staged, name)), 0o644)
    }
  } finally { rmSync(staged, { recursive: true, force: true }) }
}
function restoreRecoveredUnits(recoveryRoot) {
  const root = join(recoveryRoot, 'systemd-units')
  if (!existsSync(root)) return
  for (const name of unitFiles) if (existsSync(join(root, name))) writeAtomic(join(systemdDir, name), readFileSync(join(root, name)), 0o644)
}

async function reserveBoundary() {
  const route = readJson(join(deployRoot, 'route-state.json'))
  const origin = route?.slots?.[route.activeSlot]?.origin
  if (typeof origin !== 'string' || !origin.startsWith('http://127.0.0.1:')) throw new Error('active Dedicated slot route is invalid')
  const deadline = Date.now() + positive(option('--timeout-ms'), 3_600_000)
  while (Date.now() < deadline) {
    try {
      const quiescence = await fetch(`${origin}/internal/runtime/quiescence`, { signal: AbortSignal.timeout(5000) })
      if (quiescence.ok && (await quiescence.json()).safe === true) {
        const response = await fetch(`${origin}/internal/runtime/cutover/reserve`, { method: 'POST', signal: AbortSignal.timeout(120_000) })
        if (response.ok) { const value = await response.json(); if (value.safe === true) return { routeGeneration: route.generation, activeSlot: route.activeSlot, observedAt: now() } }
      }
    } catch {}
    await delay(500)
  }
  throw new Error('Runtime did not reach a safe reserved boundary before the deadline')
}
async function releaseBoundary() {
  const route = readJsonOptional(join(deployRoot, 'route-state.json'))
  const origin = route?.slots?.[route.activeSlot]?.origin
  if (typeof origin !== 'string' || !origin.startsWith('http://127.0.0.1:')) return
  await fetch(`${origin}/internal/runtime/cutover/release`, { method: 'POST', signal: AbortSignal.timeout(5000) })
}
async function waitForMigration() {
  const deadline = Date.now() + positive(option('--timeout-ms'), 3_720_000)
  while (Date.now() < deadline) {
    const receipt = readJsonOptional(join(deployRoot, 'migration-receipt.json'))
    if (receipt && ['cutover_completed', 'rolled_back', 'rollback_failed'].includes(receipt.phase)) return receipt
    const state = serviceState('agent-runlab-dedicated-migration-finalizer.service')
    if (state.activeState === 'failed') throw new Error('migration finalizer failed; inspect its durable receipt and journal')
    await delay(500)
  }
  throw new Error('installation deadline exceeded')
}
async function waitForPublicReady() {
  const publicOrigin = safeTestSandbox() && process.env.AGENT_RUNLAB_OPERATOR_TEST_ORIGIN
    ? process.env.AGENT_RUNLAB_OPERATOR_TEST_ORIGIN
    : 'http://127.0.0.1:13000'
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { const response = await fetch(`${publicOrigin}/runtime/capabilities`, { signal: AbortSignal.timeout(2000) }); if (response.ok && (await response.json()).product === 'dedicated') return } catch {}
    await delay(250)
  }
  throw new Error('restored Dedicated installation did not become ready')
}

function assertInstalledAndLive() {
  installationId()
  const migration = readJson(join(deployRoot, 'migration-receipt.json'))
  if (migration.phase !== 'cutover_completed') throw new Error(`Dedicated installation is not live (${migration.phase})`)
}
function assertNoDeployment() {
  if (!existsSync(join(deployRoot, 'receipts'))) return
  for (const name of readdirSync(join(deployRoot, 'receipts')).filter((entry) => entry.endsWith('.json'))) {
    const receipt = readJson(join(deployRoot, 'receipts', name))
    if (!terminalDeploymentPhases.has(receipt.phase)) throw new Error(`deployment ${receipt.deploymentId} is active in ${receipt.phase}`)
  }
}
function assertNoLiveLifecycle() {
  const root = join(operatorRoot, 'receipts')
  if (!existsSync(root)) return
  for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json'))) {
    const receipt = readJson(join(root, name))
    if (!['completed', 'failed'].includes(receipt.phase)) throw new Error(`operator lifecycle ${receipt.operationId} requires recovery in ${receipt.phase}`)
  }
}
function activePersistentServices() { return persistentServices.filter((service) => serviceState(service).activeState === 'active') }
function stopServices(names, allowFailure = false) { for (const service of names) run('systemctl', ['stop', service], { allowFailure }) }
function startServices(names, allowFailure = false) {
  const order = ['agent-runlab-dedicated-unit@blue.service', 'agent-runlab-dedicated-unit@green.service', 'agent-runlab-dedicated-ingress.service', 'agent-runlab-dedicated-deploy-supervisor.service', 'agent-runlab-dedicated-control-updater.service', 'agent-runlab-dedicated-migration-finalizer.service']
  for (const service of [...names].sort((left, right) => order.indexOf(left) - order.indexOf(right))) run('systemctl', ['start', service], { allowFailure })
}
function applyEnablement(states, allowFailure = false) {
  for (const [service, state] of Object.entries(states)) {
    const enabled = ['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias'].includes(state.unitFileState)
    run('systemctl', [enabled ? 'enable' : 'disable', service], { allowFailure })
  }
}
function serviceState(service) {
  const result = spawnSync('systemctl', ['show', service, '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'MainPID'], { encoding: 'utf8' })
  if (result.status !== 0) return { activeState: 'unknown', unitFileState: 'unknown', mainPid: 0 }
  const fields = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split(/=(.*)/su).slice(0, 2)))
  return { activeState: fields.ActiveState ?? 'unknown', unitFileState: fields.UnitFileState ?? 'unknown', mainPid: Number(fields.MainPID) || 0 }
}
function installationId() { const value = readJson(join(operatorRoot, 'installation.json')); identifier(value.installationId, 'installation id'); return value.installationId }
function assertBackupTargets(targets) { if (targets?.dataRoot !== dataRoot || targets.installRoot !== installRoot || targets.configRoot !== configRoot || targets.systemdDir !== systemdDir) throw new Error('backup targets do not match this installation') }
function installOperatorLink(target) {
  if (!existsSync(target)) throw new Error('installed operator target is missing')
  mkdirSync(dirname(operatorBin), { recursive: true, mode: 0o755 })
  const temp = `${operatorBin}.next-${process.pid}`; rmSync(temp, { force: true }); symlinkSync(target, temp); renameSync(temp, operatorBin); fsyncDirectory(dirname(operatorBin))
}
function inspectRelease(root) {
  const manifest = readJson(join(root, 'manifest.json')); if (!Array.isArray(manifest.assets) || !manifest.version) throw new Error('invalid release manifest')
  const expected = [...manifest.assets, 'manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS'].sort()
  const actual = readdirSync(root, { withFileTypes: true }); if (actual.some((entry) => !entry.isFile()) || JSON.stringify(actual.map((entry) => entry.name).sort()) !== JSON.stringify(expected)) throw new Error('release file set does not match manifest')
  const sums = parseSums(readFileSync(join(root, 'SHA256SUMS'), 'utf8')); if (sums.size !== expected.length - 1) throw new Error('release checksum set is incomplete')
  for (const name of expected) if (name !== 'SHA256SUMS' && sums.get(name) !== sha256(readFileSync(join(root, name)))) throw new Error(`release checksum mismatch: ${name}`)
  return { version: manifest.version, releaseDigest: sha256(readFileSync(join(root, 'SHA256SUMS'))) }
}
function parseSums(value) { const map = new Map(); for (const line of value.trim().split('\n')) { const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u); if (!match || map.has(match[2])) throw new Error('invalid release checksum index'); map.set(match[2], match[1]) } return map }
function releaseDirectory() { const value = option('--release-dir') ?? (existsSync(join(scriptDir, 'manifest.json')) ? scriptDir : undefined); if (!value) throw new Error('--release-dir is required'); return boundedRoot(value, 'release directory') }
function ensureEmptyPrivateDirectory(path) {
  if (existsSync(path)) { if (!statSync(path).isDirectory() || readdirSync(path).length) throw new Error('backup output must be an empty directory') }
  else mkdirSync(path, { recursive: true, mode: 0o700 })
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('backup output permissions must deny group and other access')
}
function writeAtomicJson(path, value) { writeAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600) }
function writeAtomic(path, bytes, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(temp, bytes, { flag: 'wx', mode }); try { fsyncFile(temp); renameSync(temp, path); fsyncDirectory(dirname(path)) } finally { rmSync(temp, { force: true }) }
}
function fsyncFile(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function fsyncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function readJsonOptional(path) { try { return readJson(path) } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error } }
function run(command, args, options = {}) { const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.stdio ?? 'pipe', env: options.env ?? process.env }); if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.status}`); return result }
function capture(command, args) { return String(run(command, args).stdout) }
function runJson(command, args) { const result = run(command, args); try { return JSON.parse(result.stdout) } catch { throw new Error(`${command} returned invalid JSON`) } }
function requireRoot() { if (typeof process.getuid === 'function' && process.getuid() !== 0 && !safeTestSandbox()) throw new Error('this command requires root') }
function safeTestSandbox() {
  if (process.env.NODE_ENV !== 'test' || process.env.AGENT_RUNLAB_OPERATOR_TEST_MODE !== '1') return false
  const temporary = resolve(tmpdir())
  return [dataRoot, installRoot, configRoot, systemdDir, operatorRoot, operatorBin].every((path) => resolve(path).startsWith(`${temporary}/`))
}
function boundedRoot(value, name) { const path = resolve(value); const broad = new Set(['/', '/etc', '/opt', '/usr', '/var', '/var/lib', '/usr/local', '/usr/local/bin']); if (!path.startsWith('/') || broad.has(path)) throw new Error(`${name} is an unsafe broad path`); return path }
function isInside(path, parent) { const normalized = resolve(path); const root = resolve(parent); return normalized === root || normalized.startsWith(`${root}/`) }
function identifier(value, name) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) throw new Error(`invalid ${name}`); return value }
function option(name) { const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`)); if (index < 0) return undefined; return argv[index] === name ? argv[index + 1] : argv[index].slice(name.length + 1) }
function requiredOption(name) { const value = option(name); if (!value) throw new Error(`${name} is required`); return value }
function requiredPositional(index, name) { const value = argv[index]; if (!value || value.startsWith('--')) throw new Error(`${name} is required`); return identifier(value, name) }
function has(name) { return argv.includes(name) }
function positive(value, fallback) { const number = Number(value ?? fallback); if (!Number.isSafeInteger(number) || number <= 0) throw new Error('expected a positive integer'); return number }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function fileSha256(path) {
  const result = run('sha256sum', ['--', path])
  const match = String(result.stdout).match(/^([a-f0-9]{64})  /u)
  if (!match) throw new Error('sha256sum returned an invalid digest')
  return match[1]
}
function now() { return new Date().toISOString() }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }
function redact(value) { return String(value).replaceAll(/(?:token|secret|password|credential|key)=[^\s;]+/giu, '$1=<redacted>').replaceAll(/(?:[A-Za-z]:)?[\/][^\s;]+/gu, '<path>') }
function redactObject(value) { return JSON.parse(JSON.stringify(value, (key, item) => /token|secret|password|credential|key/iu.test(key) ? '<redacted>' : key.endsWith('Root') || key.endsWith('Dir') || key.endsWith('Path') ? '<path>' : item)) }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1) }

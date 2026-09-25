#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2); if (argv[0] === '--') argv.shift()
const command = argv[0]
const operatorRoot = bounded(process.env.RUNLAB_PRIVATE_CLOUD_OPERATOR_ROOT ?? '/var/lib/agent-runlab-private-cloud', 'operator root')
const receiptsRoot = join(operatorRoot, 'receipts')
const releasesRoot = join(operatorRoot, 'releases')
const installationPath = join(operatorRoot, 'installation.json')
const activePath = join(operatorRoot, 'active.json')
const predecessorPath = join(operatorRoot, 'predecessor.json')
const transitions = new Map([
  ['planned', new Set(['verified', 'failed'])], ['verified', new Set(['pulled', 'backup_completed', 'stopped', 'failed'])],
  ['pulled', new Set(['backup_completed', 'services_updated', 'failed'])], ['backup_completed', new Set(['services_updated', 'failed'])],
  ['stopped', new Set(['backup_completed', 'restored', 'removed', 'failed'])], ['restored', new Set(['services_updated', 'failed'])],
  ['services_updated', new Set(['ready', 'failed'])], ['ready', new Set(['completed', 'failed'])],
  ['removed', new Set(['completed', 'failed'])], ['completed', new Set()], ['failed', new Set()],
])

main().catch((error) => { process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1 })

async function main() {
 if (!command || ['help', '-h', '--help'].includes(command)) { help(); return }
 if (!['install', 'status', 'upgrade', 'upgrade-dashboard', 'rollback', 'backup', 'restore', 'uninstall'].includes(command)) fail(`unknown command ${command}`)
 let operationLock
 try {
  if (command !== 'status') operationLock = acquireOperationLock()
  if (command === 'install') install()
  else if (command === 'status') status()
  else if (command === 'upgrade') upgrade(false)
  else if (command === 'upgrade-dashboard') upgrade(true)
  else if (command === 'rollback') rollback()
  else if (command === 'backup') await backup()
  else if (command === 'restore') await restore()
  else if (command === 'uninstall') uninstall()
 } catch (error) { process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1 }
 finally { releaseOperationLock(operationLock) }
}

function help() { process.stdout.write(`Kala Private Cloud operator

Usage:
  kala-private-cloud install --bundle DIR --config-dir DIR
  kala-private-cloud status
  kala-private-cloud upgrade --bundle DIR
  kala-private-cloud upgrade-dashboard --bundle DIR
  kala-private-cloud rollback
  kala-private-cloud backup --output EMPTY_PERSISTENT_DIR
  kala-private-cloud restore --backup DIR --confirm RESTORE:<backup-id>
  kala-private-cloud uninstall --confirm UNINSTALL:<installation-id>

The release bundle is immutable and digest pinned. Uninstall preserves Docker
volumes, configuration, secrets, copied releases, receipts, and backups.
`) }

function install() {
  if (existsSync(installationPath)) throw new Error('Private Cloud is already installed')
  ensureOperatorRoot()
  const configDir = bounded(required('--config-dir'), 'configuration directory')
  requireConfig(configDir)
  const release = stageBundle(required('--bundle'))
  let receipt = begin('install', { releaseId: release.id })
  try {
    receipt = move(receipt, 'verified')
    compose(release, configDir, ['pull'])
    receipt = move(receipt, 'pulled')
    compose(release, configDir, ['up', '-d', '--wait', '--remove-orphans'])
    receipt = move(receipt, 'services_updated')
    const services = inspectServices(release, configDir)
    receipt = move(receipt, 'ready', { services })
    const installation = { schemaVersion: 1, installationId: `installation-${randomUUID()}`, installedAt: now(), updatedAt: now(), configDir, projectName: projectName(configDir) }
    atomicJson(activePath, releaseRecord(release)); atomicJson(installationPath, installation)
    receipt = move(receipt, 'completed')
    output({ ok: true, installation, active: releaseRecord(release), services, receipt: publicReceipt(receipt) })
  } catch (error) { try { compose(release, configDir, ['down', '--remove-orphans']) } catch {}; failed(receipt, error); throw error }
}

function status() {
  const installation = optionalJson(installationPath); const active = optionalJson(activePath); const predecessor = optionalJson(predecessorPath)
  let services = null
  if (installation && active) { try { services = inspectServices(loadRelease(active), installation.configDir) } catch (error) { services = { error: redact(String(error)) } } }
  const receipts = existsSync(receiptsRoot) ? readdirSync(receiptsRoot).filter((name) => name.endsWith('.json')).map((name) => optionalJson(join(receiptsRoot, name))).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 5) : []
  output({ installed: Boolean(installation), installation, active, predecessor, services, recentOperations: receipts.map(publicReceipt) })
}

function upgrade(dashboardOnly) {
  const installation = installed(); const current = loadRelease(requiredJson(activePath)); const candidate = stageBundle(required('--bundle'))
  if (candidate.id === current.id) throw new Error('candidate release is already active')
  if (dashboardOnly && (candidate.lock.images.runtime !== current.lock.images.runtime || candidate.lock.images.ingress !== current.lock.images.ingress)) throw new Error('Dashboard-only bundle changes Runtime or Ingress digest')
  if (dashboardOnly && candidate.lock.images.dashboard === current.lock.images.dashboard) throw new Error('Dashboard-only bundle does not change the Dashboard digest')
  let receipt = begin(dashboardOnly ? 'upgrade-dashboard' : 'upgrade', { from: current.id, to: candidate.id })
  try {
    receipt = move(receipt, 'verified')
    compose(candidate, installation.configDir, ['pull', ...(dashboardOnly ? ['dashboard'] : [])])
    receipt = move(receipt, 'pulled')
    const before = inspectServices(current, installation.configDir)
    if (dashboardOnly) compose(candidate, installation.configDir, ['up', '-d', '--no-deps', '--wait', 'dashboard'])
    else compose(candidate, installation.configDir, ['up', '-d', '--wait', '--remove-orphans'])
    receipt = move(receipt, 'services_updated')
    const after = inspectServices(candidate, installation.configDir)
    if (dashboardOnly && (before['runtime-host']?.containerId !== after['runtime-host']?.containerId || before['runtime-ingress']?.containerId !== after['runtime-ingress']?.containerId)) throw new Error('Dashboard-only upgrade changed Runtime or Ingress container identity')
    if (dashboardOnly && before.dashboard?.containerId === after.dashboard?.containerId) throw new Error('Dashboard-only upgrade did not replace the Dashboard container')
    receipt = move(receipt, 'ready', { services: after })
    atomicJson(predecessorPath, releaseRecord(current)); atomicJson(activePath, releaseRecord(candidate))
    receipt = move(receipt, 'completed')
    output({ ok: true, dashboardOnly, active: releaseRecord(candidate), predecessor: releaseRecord(current), services: after, receipt: publicReceipt(receipt) })
  } catch (error) {
    try { compose(current, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']) } catch {}
    failed(receipt, error); throw error
  }
}

function rollback() {
  const installation = installed(); const current = loadRelease(requiredJson(activePath)); const predecessor = loadRelease(requiredJson(predecessorPath))
  let receipt = begin('rollback', { from: current.id, to: predecessor.id })
  try {
    receipt = move(receipt, 'verified'); compose(predecessor, installation.configDir, ['pull']); receipt = move(receipt, 'pulled')
    compose(predecessor, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']); receipt = move(receipt, 'services_updated')
    const services = inspectServices(predecessor, installation.configDir); receipt = move(receipt, 'ready', { services })
    atomicJson(activePath, releaseRecord(predecessor)); atomicJson(predecessorPath, releaseRecord(current)); receipt = move(receipt, 'completed')
    output({ ok: true, active: releaseRecord(predecessor), predecessor: releaseRecord(current), services, receipt: publicReceipt(receipt) })
  } catch (error) { try { compose(current, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']) } catch {}; failed(receipt, error); throw error }
}

async function backup() {
  const installation = installed(); const release = loadRelease(requiredJson(activePath)); const destination = bounded(required('--output'), 'backup output')
  ensureEmpty(destination); const backupId = `backup-${randomUUID()}`; let receipt = begin('backup', { backupId, destination })
  const applicationServices = ['runtime-ingress', 'runtime-host', 'dashboard']
  let stopped = false
  try {
    receipt = move(receipt, 'verified')
    compose(release, installation.configDir, ['stop', ...applicationServices]); stopped = true; receipt = move(receipt, 'stopped')
    await capture(composeInvocation(release, installation.configDir, ['exec', '-T', 'control-postgres', 'pg_dump', '-U', 'runlab', '-d', 'runlab_control', '--format=custom', '--no-owner', '--no-acl']), join(destination, 'control-plane.pgdump'))
    const volumes = resolveVolumes(release, installation.configDir)
    for (const [logical, file] of [['tenant-data', 'tenant-data.tar'], ['control-data', 'control-data.tar']]) await capture({ command: 'docker', args: ['run', '--rm', '--network', 'none', '-v', `${volumes[logical]}:/source:ro`, infrastructure(release, 'alpine'), 'tar', '-C', '/source', '-cf', '-', '.'], cwd: release.dir, env: composeEnv(release, installation.configDir) }, join(destination, file))
    const files = {}; for (const name of ['control-plane.pgdump', 'tenant-data.tar', 'control-data.tar']) files[name] = await describeFile(join(destination, name))
    const manifest = { schemaVersion: 1, product: 'kala-private-cloud-backup', backupId, createdAt: now(), installationId: installation.installationId, projectName: installation.projectName, active: releaseRecord(release), volumes, files }
    atomicJson(join(destination, 'manifest.json'), manifest); receipt = move(receipt, 'backup_completed', { files }); compose(release, installation.configDir, ['up', '-d', '--wait', ...applicationServices]); stopped = false; receipt = move(receipt, 'services_updated'); receipt = move(receipt, 'ready'); receipt = move(receipt, 'completed')
    output({ ok: true, backupId, confirmation: `RESTORE:${backupId}`, manifest: { files }, receipt: publicReceipt(receipt) })
  } catch (error) { if (stopped) { try { compose(release, installation.configDir, ['up', '-d', '--wait', ...applicationServices]) } catch {} }; failed(receipt, error); throw error }
}

async function restore() {
  const installation = installed(); const current = loadRelease(requiredJson(activePath)); const backupDir = bounded(required('--backup'), 'backup directory'); const manifest = requiredJson(join(backupDir, 'manifest.json'))
  if (manifest.product !== 'kala-private-cloud-backup' || manifest.installationId !== installation.installationId) throw new Error('backup does not belong to this installation')
  if (required('--confirm') !== `RESTORE:${manifest.backupId}`) throw new Error(`confirmation must equal RESTORE:${manifest.backupId}`)
  for (const [name, expected] of Object.entries(manifest.files ?? {})) { const actual = await describeFile(join(backupDir, name)); if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`backup integrity failed for ${name}`) }
  const release = loadRelease(manifest.active); let receipt = begin('restore', { backupId: manifest.backupId })
  try {
    receipt = move(receipt, 'verified'); compose(current, installation.configDir, ['stop']); receipt = move(receipt, 'stopped')
    for (const [logical, file] of [['tenant-data', 'tenant-data.tar'], ['control-data', 'control-data.tar']]) run('docker', ['run', '--rm', '--network', 'none', '-v', `${manifest.volumes[logical]}:/restore`, '-v', `${join(backupDir, file)}:/backup.tar:ro`, infrastructure(release, 'alpine'), 'sh', '-ceu', 'find /restore -mindepth 1 -delete; tar -xf /backup.tar -C /restore'])
    compose(release, installation.configDir, ['up', '-d', '--wait', 'control-postgres']);
    compose(release, installation.configDir, ['exec', '-T', 'control-postgres', 'sh', '-ceu', 'dropdb -U runlab --if-exists runlab_control; createdb -U runlab runlab_control; pg_restore --exit-on-error --no-owner --no-acl -U runlab -d runlab_control'], { input: readFileSync(join(backupDir, 'control-plane.pgdump')) })
    receipt = move(receipt, 'restored'); compose(release, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']); receipt = move(receipt, 'services_updated')
    const services = inspectServices(release, installation.configDir); receipt = move(receipt, 'ready', { services }); atomicJson(predecessorPath, releaseRecord(current)); atomicJson(activePath, releaseRecord(release)); receipt = move(receipt, 'completed')
    output({ ok: true, active: releaseRecord(release), services, receipt: publicReceipt(receipt) })
  } catch (error) { try { compose(current, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']) } catch {}; failed(receipt, error); throw error }
}

function uninstall() {
  const installation = installed(); if (required('--confirm') !== `UNINSTALL:${installation.installationId}`) throw new Error(`confirmation must equal UNINSTALL:${installation.installationId}`)
  const release = loadRelease(requiredJson(activePath)); let receipt = begin('uninstall', {})
  try { receipt = move(receipt, 'verified'); compose(release, installation.configDir, ['down', '--remove-orphans']); receipt = move(receipt, 'stopped'); rmSync(installationPath); rmSync(activePath); rmSync(predecessorPath, { force: true }); receipt = move(receipt, 'removed'); receipt = move(receipt, 'completed'); output({ ok: true, preserved: ['volumes', 'configuration', 'secrets', releasesRoot, receiptsRoot], receipt: publicReceipt(receipt) }) }
  catch (error) { failed(receipt, error); throw error }
}

function stageBundle(input) {
  const source = bounded(input, 'bundle'); const manifest = requiredJson(join(source, 'manifest.json')); verifyBundle(source, manifest)
  const id = `release-${manifest.version}-${manifest.revision.slice(0, 12)}-${hash(readFileSync(join(source, 'image-lock.json'))).slice(0, 12)}`
  const target = join(releasesRoot, id)
  if (!existsSync(target)) {
    const staging = join(releasesRoot, `.staging-${id}-${randomUUID()}`)
    try { mkdirSync(staging, { mode: 0o755 }); for (const name of readdirSync(source)) copyFileSync(join(source, name), join(staging, name)); verifyBundle(staging, manifest); renameSync(staging, target); fsyncDirectory(releasesRoot) }
    finally { rmSync(staging, { recursive: true, force: true }) }
  }
  verifyBundle(target, manifest); return loadRelease({ releaseId: id, releaseDir: target })
}
function verifyBundle(dir, manifest = requiredJson(join(dir, 'manifest.json'))) {
  if (manifest.schemaVersion !== 1 || manifest.product !== 'kala-private-cloud' || !/^[0-9a-f]{40}$/u.test(manifest.revision)) throw new Error('invalid Private Cloud bundle manifest')
  const expected = Object.keys(manifest.files).concat('manifest.json').sort(); if (JSON.stringify(readdirSync(dir).sort()) !== JSON.stringify(expected)) throw new Error('bundle file set does not match manifest')
  for (const [name, value] of Object.entries(manifest.files)) { if (name.includes('/')) throw new Error('invalid bundle file path'); const path = join(dir, name); if (statSync(path).size !== value.bytes || hash(readFileSync(path)) !== value.sha256) throw new Error(`bundle integrity failed for ${name}`) }
  const lock = requiredJson(join(dir, 'image-lock.json')); if (lock.version !== manifest.version || lock.revision !== manifest.revision || !['runtime', 'ingress', 'dashboard'].every((key) => immutable(lock.images?.[key]))) throw new Error('invalid image lock')
  const composeText = readFileSync(join(dir, 'compose.yaml'), 'utf8'); if (/^\s+build:/mu.test(composeText)) throw new Error('release Compose contains source build')
  for (const match of composeText.matchAll(/^\s+image:\s+([^$\s][^\s]*)/gmu)) if (!immutable(match[1])) throw new Error(`release Compose image is not digest pinned: ${match[1]}`)
  if (!['RUNLAB_RUNTIME_IMAGE', 'RUNLAB_INGRESS_IMAGE', 'RUNLAB_DASHBOARD_IMAGE'].every((name) => composeText.includes(name))) throw new Error('release Compose does not consume all component image locks')
}
function loadRelease(record) { const dir = bounded(record.releaseDir, 'release directory'); const manifest = requiredJson(join(dir, 'manifest.json')); verifyBundle(dir, manifest); return { id: record.releaseId, dir, manifest, lock: requiredJson(join(dir, 'image-lock.json')) } }
function releaseRecord(release) { return { schemaVersion: 1, releaseId: release.id, releaseDir: release.dir, version: release.manifest.version, revision: release.manifest.revision, images: release.lock.images, activatedAt: now() } }

function compose(release, configDir, args, options = {}) { const invocation = composeInvocation(release, configDir, args); return run(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, input: options.input }) }
function composeInvocation(release, configDir, args) { return { command: 'docker', args: ['compose', ...composeFiles(release, configDir), ...args], cwd: release.dir, env: composeEnv(release, configDir) } }
function composeFiles(release, configDir) {
  const profile = deploymentEnv(configDir).RUNLAB_PROFILE ?? 'cloudflare'; const storage = deploymentEnv(configDir).RUNLAB_STORAGE ?? (profile === 'local' ? 'nfs' : 'nfs')
  const files = ['compose.yaml', storage === 'external-nfs' ? 'compose.storage-external-nfs.yaml' : storage === 'local-volume' ? 'compose.storage-local.yaml' : 'compose.storage-nfs.yaml', profile === 'local' ? 'compose.local.yaml' : 'compose.cloudflare.yaml']
  return ['--project-name', projectName(configDir), '--env-file', join(configDir, 'deployment.env'), ...files.flatMap((file) => ['-f', join(release.dir, file)])]
}
function composeEnv(release, configDir) { return { ...process.env, ...deploymentEnv(configDir), RUNLAB_RUNTIME_IMAGE: release.lock.images.runtime, RUNLAB_INGRESS_IMAGE: release.lock.images.ingress, RUNLAB_DASHBOARD_IMAGE: release.lock.images.dashboard, RUNLAB_SECRETS_DIR: join(configDir, 'secrets'), RUNLAB_PROVIDER_CATALOG_FILE: join(configDir, 'runtime-provider-catalog.json'), RUNLAB_DEPLOYMENT_CONFIG_FILE: join(release.dir, 'deployment.json') } }
function inspectServices(release, configDir) { const invocation = composeInvocation(release, configDir, ['ps', '--format', 'json']); const result = captureSync(invocation.command, invocation.args, invocation.cwd, invocation.env); const rows = result.trim() ? result.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : []; return Object.fromEntries(rows.map((row) => [row.Service, { containerId: row.ID, image: row.Image, state: row.State, health: row.Health ?? '' }])) }
function resolveVolumes(release, configDir) { const text = captureSync('docker', ['compose', ...composeFiles(release, configDir), 'config', '--format', 'json'], release.dir, composeEnv(release, configDir)); const config = JSON.parse(text); return Object.fromEntries(['tenant-data', 'control-data'].map((name) => [name, config.volumes?.[name]?.name ?? `${projectName(configDir)}_${name}`])) }
function infrastructure(release, name) { const composeText = readFileSync(join(release.dir, 'compose.yaml'), 'utf8'); const match = composeText.match(new RegExp(`image: (${name}(?::[^\s@]+)?@sha256:[0-9a-f]{64})`, 'u')); if (!match) throw new Error(`missing pinned ${name} infrastructure image`); return match[1] }

function begin(type, detail) { ensureOperatorRoot(); const receipt = { schemaVersion: 1, operationId: `operation-${randomUUID()}`, type, sequence: 0, phase: 'planned', createdAt: now(), updatedAt: now(), detail }; atomicJson(join(receiptsRoot, `${receipt.operationId}.json`), receipt); return receipt }
function move(receipt, phase, detail) { if (!transitions.get(receipt.phase)?.has(phase)) throw new Error(`invalid lifecycle transition ${receipt.phase} -> ${phase}`); const next = { ...receipt, sequence: receipt.sequence + 1, phase, updatedAt: now(), ...(detail ? { detail: { ...receipt.detail, ...detail } } : {}) }; atomicJson(join(receiptsRoot, `${receipt.operationId}.json`), next); return next }
function failed(receipt, error) { if (receipt.phase === 'completed' || receipt.phase === 'failed') return receipt; const next = { ...receipt, sequence: receipt.sequence + 1, phase: 'failed', updatedAt: now(), error: redact(error instanceof Error ? error.message : String(error)) }; atomicJson(join(receiptsRoot, `${receipt.operationId}.json`), next); return next }
function publicReceipt(receipt) { return receipt && { operationId: receipt.operationId, type: receipt.type, sequence: receipt.sequence, phase: receipt.phase, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt, error: receipt.error } }

function installed() { const value = requiredJson(installationPath); if (value.schemaVersion !== 1 || !value.installationId || !value.configDir) throw new Error('invalid installation record'); requireConfig(value.configDir); return value }
function requireConfig(dir) { for (const name of ['deployment.env', 'runtime-provider-catalog.json']) if (!existsSync(join(dir, name))) throw new Error(`configuration is missing ${name}`); if (!existsSync(join(dir, 'secrets'))) throw new Error('configuration is missing secrets directory') }
function deploymentEnv(dir) { const result = {}; for (const line of readFileSync(join(dir, 'deployment.env'), 'utf8').split(/\r?\n/u)) { const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u); if (match) result[match[1]] = match[2] } return result }
function projectName(configDir) { const value = deploymentEnv(configDir).COMPOSE_PROJECT_NAME ?? 'agent-runlab-private-cloud'; if (!/^[a-z0-9][a-z0-9_-]+$/u.test(value)) throw new Error('invalid COMPOSE_PROJECT_NAME'); return value }
function ensureOperatorRoot() { mkdirSync(receiptsRoot, { recursive: true, mode: 0o700 }); mkdirSync(releasesRoot, { recursive: true, mode: 0o700 }) }
function acquireOperationLock() {
  ensureOperatorRoot(); const path = join(operatorRoot, 'operation.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`); fsyncSync(fd); return { fd, path } }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = optionalJson(path); if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('another lifecycle operation holds an invalid lock')
      try { process.kill(owner.pid, 0); throw new Error(`another lifecycle operation is active (pid ${String(owner.pid)})`) }
      catch (probe) { if (probe?.code !== 'ESRCH') throw probe; unlinkSync(path) }
    }
  }
  throw new Error('could not acquire lifecycle operation lock')
}
function releaseOperationLock(lock) { if (!lock) return; try { closeSync(lock.fd) } finally { try { unlinkSync(lock.path) } catch {} } }
function ensureEmpty(path) { if (existsSync(path) && readdirSync(path).length) throw new Error('output directory must be empty'); mkdirSync(path, { recursive: true, mode: 0o700 }) }
function bounded(value, label) { const path = resolve(value); if (path === '/' || path.split('/').filter(Boolean).length < 2) throw new Error(`unsafe ${label}`); return path }
function required(name) { const index = argv.indexOf(name); if (index < 0 || !argv[index + 1]) throw new Error(`missing ${name}`); return argv[index + 1] }
function requiredJson(path) { const value = optionalJson(path); if (!value) throw new Error(`missing ${basename(path)}`); return value }
function optionalJson(path) { if (!existsSync(path)) return null; try { return JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error(`invalid ${basename(path)}`) } }
function immutable(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u.test(value) }
function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.tmp-${process.pid}-${randomUUID()}`; const fd = openSync(temp, 'wx', 0o600); try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }; renameSync(temp, path); const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) } }
function fsyncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function hash(body) { return createHash('sha256').update(body).digest('hex') }
async function describeFile(path) { const digest = createHash('sha256'); await new Promise((ok, reject) => createReadStream(path).on('data', (chunk) => digest.update(chunk)).on('end', ok).on('error', reject)); return { bytes: statSync(path).size, sha256: digest.digest('hex') } }
function now() { return new Date().toISOString() }
function redact(value) { return String(value).replaceAll(/(token|secret|password|key)=([^\s]+)/giu, '$1=[redacted]').replaceAll(/postgresql:\/\/[^@\s]+@/giu, 'postgresql://[redacted]@') }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1) }
function run(command, args, options = {}) { const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, input: options.input, encoding: options.input ? undefined : 'utf8', stdio: options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit' }); if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`); return result.stdout }
function captureSync(command, args, cwd = process.cwd(), env = process.env) { if (typeof cwd === 'boolean') cwd = process.cwd(); const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${String(result.status)}`); return result.stdout }
async function capture(invocation, outputPath) { const fd = openSync(outputPath, 'wx', 0o600); try { await new Promise((ok, reject) => { const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: ['ignore', fd, 'inherit'] }); child.once('error', reject); child.once('exit', (code) => code === 0 ? ok() : reject(new Error(`${invocation.command} exited ${String(code)}`))) }); fsyncSync(fd) } finally { closeSync(fd) } }

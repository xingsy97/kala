#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'
import { loginWithPassword } from '../product-e2e/harness.mjs'
import { createRcEvidence } from './rc-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const candidateArchive = resolve(required('--candidate-archive'))
const predecessorArchive = resolve(required('--predecessor-archive'))
const executorAsset = resolve(required('--executor'))
const tag = required('--tag')
const revision = required('--revision')
const predecessorRevision = required('--predecessor-revision')
const output = resolve(required('--output'))
const configTemplate = resolve(requiredEnv('RUNLAB_RC_PRIVATE_CLOUD_CONFIG_TEMPLATE'))
const scratch = mkdtempSync(join(tmpdir(), 'runlab-rc-private-cloud-'))
const operatorRoot = join(scratch, 'operator')
const config = join(scratch, 'config')
const backup = join(scratch, 'backup')
const candidate = extract(candidateArchive, join(scratch, 'candidate'))
const predecessor = extract(predecessorArchive, join(scratch, 'predecessor'))
const project = 'runlab-rc-' + randomBytes(6).toString('hex')
let installed = false
let executor
let alicePassword = requiredEnv('PRIVATE_CLOUD_TEST_ALICE_PASSWORD')

try {
  cpSync(configTemplate, config, { recursive: true })
  requirePrivateConfig(config)
  rewriteDeploymentEnv(join(config, 'deployment.env'), project)
  verify(candidate)
  verify(predecessor)
  const candidateManifest = json(readFileSync(join(candidate, 'manifest.json'), 'utf8'))
  if (candidateManifest.revision !== revision) throw new Error('Private Cloud candidate revision mismatch')
  const predecessorManifest = json(readFileSync(join(predecessor, 'manifest.json'), 'utf8'))
  if (predecessorManifest.revision !== predecessorRevision) throw new Error('Private Cloud predecessor revision mismatch')
  if (candidateManifest.version !== tag.slice(1)) throw new Error('Private Cloud candidate version mismatch')
  const candidateLock = json(readFileSync(join(candidate, 'image-lock.json'), 'utf8'))
  const predecessorLock = json(readFileSync(join(predecessor, 'image-lock.json'), 'utf8'))
  const hybrid = join(scratch, 'dashboard-candidate')
  run(process.execPath, [
    'scripts/release/build-private-cloud-bundle.mjs', '--output', hybrid,
    '--runtime-image', predecessorLock.images.runtime, '--ingress-image', predecessorLock.images.ingress,
    '--dashboard-image', candidateLock.images.dashboard, '--revision', revision,
    '--operator', join(candidate, 'runlab-private-cloud'),
  ])
  verify(hybrid)

  const predecessorOperator = join(predecessor, 'runlab-private-cloud')
  const candidateOperator = join(candidate, 'runlab-private-cloud')
  const env = { ...process.env, RUNLAB_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot }
  const installedResult = operator(predecessorOperator, ['install', '--bundle', predecessor, '--config-dir', config], env)
  installed = true
  if (!installedResult.ok || installedResult.receipt?.phase !== 'completed') throw new Error('Private Cloud clean install did not complete')
  assertServicesReady(installedResult.services)
  await waitForHttp('http://localhost:13001/runtime/capabilities', 90_000)
  const capabilities = await fetch('http://localhost:13001/runtime/capabilities').then(okJson)
  if (capabilities.product !== 'private-cloud' || capabilities.deployment?.tenancy !== 'multi-tenant') throw new Error('Private Cloud capabilities are incorrect')

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    alicePassword = await loginWithPassword(page, { productOrigin: 'http://localhost:13001', loginName: requiredEnv('PRIVATE_CLOUD_TEST_ALICE_EMAIL'), password: alicePassword })
    const invite = await page.evaluate(async () => {
      const response = await fetch('/auth/executor-invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'RC clean acceptance' }) })
      if (!response.ok) throw new Error('executor invite returned ' + response.status)
      return response.json()
    })
    if (!invite.inviteToken) throw new Error('Private Cloud did not issue an Executor invite')
    if (!existsSync(executorAsset)) throw new Error('Private Cloud acceptance Executor is missing')
    chmodSync(executorAsset, 0o755)
    const executorHome = join(scratch, 'executor-home')
    const workspaceRoot = join(scratch, 'workspace')
    mkdirSync(executorHome, { recursive: true }); mkdirSync(workspaceRoot, { recursive: true })
    const logs = []
    executor = spawn(executorAsset, ['--host', 'http://localhost:13001', '--invite', invite.inviteToken, '--sandbox-root', workspaceRoot, '--name', 'rc-private-cloud-workspace'], { cwd: workspaceRoot, env: { ...process.env, HOME: executorHome }, stdio: ['ignore', 'pipe', 'pipe'] })
    executor.stdout.on('data', (chunk) => logs.push(String(chunk))); executor.stderr.on('data', (chunk) => logs.push(String(chunk)))
    await waitFor(() => logs.some((line) => line.includes('executor announced')), 30_000, 'Private Cloud Executor connection')
  } finally { await browser.close() }

  const effectiveCredentials = join(scratch, 'effective-credentials.json')
  run(process.execPath, ['scripts/private-cloud-local/acceptance/verify-tenant-isolation.mjs'], false, {
    ...env, PRIVATE_CLOUD_TEST_ALICE_PASSWORD: alicePassword, PRIVATE_CLOUD_EFFECTIVE_CREDENTIALS_FILE: effectiveCredentials,
  })
  alicePassword = json(readFileSync(effectiveCredentials, 'utf8')).alice
  if (typeof alicePassword !== 'string' || !alicePassword) throw new Error('Private Cloud tenant acceptance did not preserve the effective credential')
  const workspace = run(process.execPath, ['scripts/private-cloud-local/acceptance/verify-full-workspace.mjs'], false, {
    ...env,
    PRIVATE_CLOUD_TEST_EMAIL: requiredEnv('PRIVATE_CLOUD_TEST_ALICE_EMAIL'),
    PRIVATE_CLOUD_TEST_PASSWORD: alicePassword,
    PRIVATE_CLOUD_WORKSPACE_MARKER: 'rc-' + randomBytes(6).toString('hex'),
  })
  if (!workspace.stdout.trim()) throw new Error('Private Cloud Browser/Executor flow produced no result')

  const beforeDashboard = operator(candidateOperator, ['status'], env).services
  const dashboardUpgrade = operator(candidateOperator, ['upgrade-dashboard', '--bundle', hybrid], env)
  if (dashboardUpgrade.receipt?.phase !== 'completed') throw new Error('Private Cloud Dashboard-only upgrade did not complete')
  if (beforeDashboard['runtime-host'].containerId !== dashboardUpgrade.services['runtime-host'].containerId || beforeDashboard['runtime-ingress'].containerId !== dashboardUpgrade.services['runtime-ingress'].containerId || beforeDashboard.dashboard.containerId === dashboardUpgrade.services.dashboard.containerId) throw new Error('Dashboard-only update did not preserve Runtime and Ingress identity')
  const dashboardRollback = operator(candidateOperator, ['rollback'], env)
  if (dashboardRollback.receipt?.phase !== 'completed' || dashboardRollback.active.images.runtime !== predecessorLock.images.runtime || dashboardRollback.active.images.ingress !== predecessorLock.images.ingress || dashboardRollback.active.images.dashboard !== predecessorLock.images.dashboard) throw new Error('Private Cloud Dashboard rollback did not restore the predecessor release')
  const dashboardUpgradeAgain = operator(candidateOperator, ['upgrade-dashboard', '--bundle', hybrid], env)
  if (dashboardUpgradeAgain.receipt?.phase !== 'completed') throw new Error('Private Cloud Dashboard-only upgrade could not be repeated after rollback')

  const fullUpgrade = operator(candidateOperator, ['upgrade', '--bundle', candidate], env)
  if (fullUpgrade.receipt?.phase !== 'completed') throw new Error('Private Cloud full upgrade did not complete')
  assertServicesReady(fullUpgrade.services)
  const fullRollback = operator(candidateOperator, ['rollback'], env)
  if (fullRollback.receipt?.phase !== 'completed' || fullRollback.active.images.runtime !== predecessorLock.images.runtime || fullRollback.active.images.ingress !== predecessorLock.images.ingress || fullRollback.active.images.dashboard !== candidateLock.images.dashboard) throw new Error('Private Cloud full rollback did not restore the persisted mixed predecessor')

  mkdirSync(backup, { mode: 0o700 })
  const backedUp = operator(candidateOperator, ['backup', '--output', backup], env)
  if (backedUp.receipt?.phase !== 'completed') throw new Error('Private Cloud backup did not complete')
  const tenantVolume = inspectVolume(predecessor, config, 'tenant-data')
  run('docker', ['run', '--rm', '--network', 'none', '-v', tenantVolume + ':/data', infrastructureImage(predecessor, 'alpine'), 'sh', '-ceu', "printf 'mutated' > /data/rc-restore-marker"])
  const restored = operator(candidateOperator, ['restore', '--backup', backup, '--confirm', 'RESTORE:' + backedUp.backupId], env)
  if (restored.receipt?.phase !== 'completed') throw new Error('Private Cloud restore did not complete')
  const marker = run('docker', ['run', '--rm', '--network', 'none', '-v', tenantVolume + ':/data:ro', infrastructureImage(predecessor, 'alpine'), 'sh', '-ceu', 'test ! -e /data/rc-restore-marker']).status
  if (marker !== 0) throw new Error('Private Cloud restore did not replace mutated tenant data')
  await waitForHttp('http://localhost:13001/runtime/capabilities', 90_000)

  const evidence = createRcEvidence({
    category: 'private-cloud', target: 'linux-x64-compose', tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: basename(candidateArchive), sha256: digest(readFileSync(candidateArchive)) },
    checks: { assetIntegrity: true, cleanInstall: true, tenantIsolation: true, browser: true, executor: true, fullUpgrade: true, dashboardUpgradeIsolation: true, rollback: true, backupRestore: true },
  })
  mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, category: 'private-cloud', target: 'linux-x64-compose', evidence: basename(output) }) + '\n')
} finally {
  if (executor) { executor.kill('SIGTERM'); await new Promise((resolveExit) => { const timer = setTimeout(() => { executor.kill('SIGKILL'); resolveExit() }, 5_000); executor.once('exit', () => { clearTimeout(timer); resolveExit() }) }) }
  if (installed) {
    try {
      const active = json(readFileSync(join(operatorRoot, 'installation.json'), 'utf8'))
      operator(join(candidate, 'runlab-private-cloud'), ['uninstall', '--confirm', 'UNINSTALL:' + active.installationId], { ...process.env, RUNLAB_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot })
    } catch {}
  }
  cleanupProject(project)
  rmSync(scratch, { recursive: true, force: true })
}

function extract(archive, destination) { mkdirSync(destination, { recursive: true }); run('tar', ['-xzf', archive, '-C', destination]); const entries = readdirFlat(destination); const rootEntry = entries.length === 1 && entries[0].directory ? join(destination, entries[0].name) : destination; const manifest = find(rootEntry, 'manifest.json'); return resolve(manifest, '..') }
function readdirFlat(path) { return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })) }
function find(rootDir, name) { const queue = [rootDir]; while (queue.length) { const current = queue.shift(); for (const entry of readdirSync(current, { withFileTypes: true })) { const path = join(current, entry.name); if (entry.isFile() && entry.name === name) return path; if (entry.isDirectory()) queue.push(path) } }; throw new Error('archive is missing ' + name) }
function verify(path) { const result = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', path]); if (!json(result.stdout).ok) throw new Error('Private Cloud bundle verification failed') }
function requirePrivateConfig(path) { for (const name of ['deployment.env', 'runtime-provider-catalog.json']) if (!existsSync(join(path, name))) throw new Error('Private Cloud config template is missing ' + name); if (!existsSync(join(path, 'secrets'))) throw new Error('Private Cloud config template is missing secrets') }
function rewriteDeploymentEnv(path, project) { const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line && !line.startsWith('COMPOSE_PROJECT_NAME=')); lines.push('COMPOSE_PROJECT_NAME=' + project); writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 }) }
function operator(binary, args, env) { const result = run(binary, args, false, env); return json(result.stdout) }
function assertServicesReady(services) { for (const name of ['runtime-host', 'runtime-ingress', 'dashboard']) if (services?.[name]?.state !== 'running' || !['', 'healthy'].includes(services[name].health)) throw new Error('Private Cloud service is not ready: ' + name) }
function inspectVolume(release, config, name) { const invocation = composeInvocation(release, config, ['config', '--format', 'json']); const value = json(run(invocation.command, invocation.args, false, invocation.env, invocation.cwd).stdout); return value.volumes?.[name]?.name ?? envFile(join(config, 'deployment.env')).COMPOSE_PROJECT_NAME + '_' + name }
function composeInvocation(release, config, args) { const deployment = envFile(join(config, 'deployment.env')); const storage = deployment.RUNLAB_STORAGE === 'local-volume' ? 'compose.storage-local.yaml' : deployment.RUNLAB_STORAGE === 'external-nfs' ? 'compose.storage-external-nfs.yaml' : 'compose.storage-nfs.yaml'; const profile = deployment.RUNLAB_PROFILE === 'local' ? 'compose.local.yaml' : 'compose.cloudflare.yaml'; const lock = json(readFileSync(join(release, 'image-lock.json'), 'utf8')); return { command: 'docker', cwd: release, env: { ...process.env, ...deployment, RUNLAB_RUNTIME_IMAGE: lock.images.runtime, RUNLAB_INGRESS_IMAGE: lock.images.ingress, RUNLAB_DASHBOARD_IMAGE: lock.images.dashboard, RUNLAB_SECRETS_DIR: join(config, 'secrets'), RUNLAB_PROVIDER_CATALOG_FILE: join(config, 'runtime-provider-catalog.json'), RUNLAB_DEPLOYMENT_CONFIG_FILE: join(release, 'deployment.json') }, args: ['compose', '--project-name', deployment.COMPOSE_PROJECT_NAME, '--env-file', join(config, 'deployment.env'), '-f', join(release, 'compose.yaml'), '-f', join(release, storage), '-f', join(release, profile), ...args] } }
function envFile(path) { return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/u).map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u)).filter(Boolean).map((match) => [match[1], match[2]])) }
function infrastructureImage(release, name) { const match = readFileSync(join(release, 'compose.yaml'), 'utf8').match(new RegExp('image: (' + name + '(?::[^\\s@]+)?@sha256:[0-9a-f]{64})', 'u')); if (!match) throw new Error('missing immutable ' + name + ' image'); return match[1] }
function cleanupProject(name) {
  const containers = run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + name], true).stdout.trim().split(/\s+/u).filter(Boolean)
  if (containers.length) run('docker', ['rm', '-f', ...containers], true)
  const volumes = run('docker', ['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + name], true).stdout.trim().split(/\s+/u).filter(Boolean)
  if (volumes.length) run('docker', ['volume', 'rm', ...volumes], true)
  const networks = run('docker', ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + name], true).stdout.trim().split(/\s+/u).filter(Boolean)
  if (networks.length) run('docker', ['network', 'rm', ...networks], true)
}
async function waitForHttp(url, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return } catch {}; await new Promise((resolveWait) => setTimeout(resolveWait, 500)) }; throw new Error('timed out waiting for ' + url) }
async function waitFor(check, timeout, label) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { try { const value = await check(); if (value) return value } catch (error) { last = error }; await new Promise((resolveWait) => setTimeout(resolveWait, 250)) }; throw new Error('timed out waiting for ' + label + (last ? ': ' + String(last) : '')) }
async function okJson(response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json() }
function run(command, args, allowFailure = false, env = process.env, cwd = root) { const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (result.status !== 0 && !allowFailure) throw new Error(command + ' failed: ' + (result.stderr || result.stdout)); return result }
function json(value) { return JSON.parse(String(value)) }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error('missing ' + name); return process.argv[index + 1] }
function requiredEnv(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(name + ' is required'); return value }

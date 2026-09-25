#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'
import { io } from 'socket.io-client'
import { createRcEvidence } from './rc-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const candidateInput = resolve(required('--candidate'))
const predecessorInput = resolve(required('--predecessor'))
const tag = required('--tag')
const revision = required('--revision')
const predecessorRevision = required('--predecessor-revision')
const output = resolve(required('--output'))
const runId = randomBytes(8).toString('hex')
const container = 'runlab-rc-dedicated-' + runId
const scratch = mkdtempSync(join(tmpdir(), 'runlab-rc-dedicated-'))
const candidate = materializeRelease(candidateInput, join(scratch, 'candidate'))
const predecessor = materializeRelease(predecessorInput, join(scratch, 'predecessor'))
const token = randomBytes(24).toString('base64url')
const sessionId = 'session-self-deploy-' + runId
const operationId = 'operation-self-deploy-acceptance'
let created = false
let socket
let browser

try {
  assertRelease(candidate, revision)
  assertRelease(predecessor, predecessorRevision)
  if (!existsSync(join(predecessorInput, 'kala-executor-linux-x64'))) throw new Error('Dedicated predecessor release requires the Linux x64 native Executor asset')
  run('lxc', ['init', process.env.PRODUCT_E2E_LXD_IMAGE ?? 'ubuntu:24.04', container])
  created = true
  run('lxc', ['start', container])
  await waitFor(async () => /running|degraded/u.test(exec(['systemctl', 'is-system-running'], true).stdout), 90_000, 'clean systemd')
  run('lxc', ['file', 'push', process.execPath, container + '/usr/bin/node'])
  run('lxc', ['file', 'push', '--recursive', candidate + '/', container + '/tmp/candidate'])
  run('lxc', ['file', 'push', '--recursive', predecessor + '/', container + '/tmp/predecessor'])
  run('lxc', ['file', 'push', join(predecessorInput, 'kala-executor-linux-x64'), container + '/tmp/kala-executor-linux-x64'])
  run('lxc', ['file', 'push', join(root, 'scripts/release/fixtures/dedicated-acceptance-provider.mjs'), container + '/tmp/dedicated-acceptance-provider.mjs'])
  exec(['chmod', '+x', '/usr/bin/node', '/tmp/kala-executor-linux-x64'])
  if (!exec(['node', '--version']).stdout.startsWith('v22.')) throw new Error('clean Dedicated environment did not receive Node.js 22')
  exec(['mkdir', '-p', '/etc/agent-runlab', '/tmp/workspace'])
  const deployCommand = "runlab-dedicated upgrade --release-dir /tmp/candidate --no-wait --operation-id " + operationId
  pushText('/etc/agent-runlab/dedicated.env', [
    'AGENT_KERNEL_PROVIDER=anthropic',
    'ANTHROPIC_API_KEY=acceptance-not-secret',
    'ANTHROPIC_BASE_URL=http://127.0.0.1:18080/v1',
    'HOST_MODEL=acceptance-model',
    'AK_ALLOW_ALL_OK=1',
    'EXECUTOR_TOKENS=' + JSON.stringify([{ token }]),
  ].join('\n') + '\n')
  pushText('/etc/systemd/system/runlab-acceptance-provider.service', service('Acceptance provider', '/usr/bin/node /tmp/dedicated-acceptance-provider.mjs', 'Environment=' + quoteSystemd('RUNLAB_ACCEPTANCE_DEPLOY_COMMAND=' + deployCommand)))
  pushText('/etc/systemd/system/runlab-acceptance-executor.service', service('Acceptance Executor', '/tmp/kala-executor-linux-x64 --host http://127.0.0.1:13000 --sandbox-root /tmp/workspace', 'Environment=EXECUTOR_TOKEN=' + token + '\nEnvironment=WORKSPACE_NAME=acceptance-workspace'))
  exec(['systemctl', 'daemon-reload'])
  exec(['systemctl', 'enable', '--now', 'runlab-acceptance-provider.service'])

  const staged = execNode('/tmp/predecessor/kala-dedicated.mjs', ['install', '--release-dir', '/tmp/predecessor', '--stage-only'])
  if (staged.phase !== 'installed_disabled') throw new Error('Dedicated staged install did not produce installed_disabled')
  exec(['chown', '-R', 'agent-runlab:agent-runlab', '/tmp/workspace'])
  for (const unit of ['agent-runlab-dedicated-ingress.service', 'agent-runlab-dedicated-unit@blue.service', 'agent-runlab-dedicated-unit@green.service', 'agent-runlab-dedicated-deploy-supervisor.service']) {
    if (exec(['systemctl', 'is-active', unit], true).stdout.trim() === 'active') throw new Error('staged Dedicated service became active: ' + unit)
    if (exec(['systemctl', 'is-enabled', unit], true).stdout.trim() === 'enabled') throw new Error('staged Dedicated service became enabled: ' + unit)
  }
  exec(['systemd-analyze', 'verify', '/etc/systemd/system/agent-runlab-dedicated-ingress.service', '/etc/systemd/system/agent-runlab-dedicated-unit@.service', '/etc/systemd/system/agent-runlab-dedicated-deploy-supervisor.service'])
  exec(['systemctl', 'start', '--no-block', 'agent-runlab-dedicated-migration-finalizer.service'])
  await waitFor(() => migrationPhase() === 'cutover_completed', 90_000, 'Dedicated clean cutover')
  exec(['systemctl', 'enable', '--now', 'runlab-acceptance-executor.service'])
  await waitFor(() => serviceActive('runlab-acceptance-executor.service'), 30_000, 'Executor service')

  let origin = 'http://' + containerAddress() + ':13000'
  await waitForHttp(origin + '/runtime/capabilities', 30_000)
  const capabilities = await fetch(origin + '/runtime/capabilities').then(okJson)
  if (capabilities.product !== 'dedicated' || capabilities.deployment?.tenancy !== 'single-tenant') throw new Error('Dedicated capabilities are incorrect')
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await assertBrowserReady(page, origin)

  socket = io(origin + '/dashboard', { transports: ['websocket'], auth: { role: 'dashboard', sessionId, clientVersion: '1' }, reconnection: true, reconnectionAttempts: 100 })
  await once(socket, 'session:ready', 15_000)
  const executors = await responseEvent(socket, 'client:list_executors', 'server:executors', {})
  const executor = executors.executors.find((entry) => entry.workspaceName === 'acceptance-workspace')
  if (!executor?.workspaceId) throw new Error('Dedicated Executor did not connect through Stable Ingress')
  assertAck(await ack(socket, 'client:create_session', { operationId: 'operation-create-' + runId, sessionId, workspaceId: executor.workspaceId, workspaceName: executor.workspaceName, cwd: '/tmp/workspace' }))
  assertAck(await ack(socket, 'client:set_approval_mode', { sessionId, mode: 'allow_all' }))
  assertAck(await ack(socket, 'client:user_message', { operationId: 'operation-message-' + runId, sessionId, text: 'SELF_DEPLOY_ACCEPTANCE' }))

  await waitFor(() => { const value = latestDeployment(); return value?.operationId === operationId && value.phase === 'completed' }, 180_000, 'self-deployment completion')
  const deployment = latestDeployment()
  if (!deployment.originResultPersistedAt || deployment.continuation?.failed !== 0 || deployment.health?.publicRoute !== true) throw new Error('self-deployment receipt lacks continuation proof')
  await waitFor(async () => (await history()).some((entry) => JSON.stringify(entry).includes('SELF_DEPLOY_CONTINUED')), 90_000, 'automatic continuation')
  const after = await history()
  if (after.some((entry) => JSON.stringify(entry).includes('[interrupted]'))) throw new Error('planned cutover created [interrupted]')
  if (after.filter((entry) => JSON.stringify(entry).includes('acceptance-deploy-call')).length !== 2) throw new Error('self-deployment Tool call/result were lost or duplicated')
  const continuationCursor = after.at(-1)?.seq
  if (!Number.isSafeInteger(continuationCursor)) throw new Error('Dedicated continuation did not expose a monotonic Session cursor')
  const routeAfterUpgrade = json(exec(['cat', '/var/lib/agent-runlab/deploy/route-state.json']).stdout)
  if (routeAfterUpgrade.generation < 2 || routeAfterUpgrade.slots[routeAfterUpgrade.activeSlot].releaseId === staged.releaseId) throw new Error('Dedicated route did not move to the candidate release')
  await assertBrowserReady(page, origin)

  exec(['systemctl', 'reboot'], true)
  await waitFor(() => { const status = exec(['systemctl', 'is-system-running'], true); return status.status !== 0 || !/running|degraded/u.test(status.stdout) }, 30_000, 'Dedicated reboot start')
  await waitFor(() => {
    const status = run('lxc', ['info', container], true).stdout
    if (status.includes('Status: STOPPED')) { run('lxc', ['start', container]); return true }
    return status.includes('Status: RUNNING')
  }, 30_000, 'Dedicated container restart')
  await waitFor(async () => /running|degraded/u.test(exec(['systemctl', 'is-system-running'], true).stdout), 120_000, 'Dedicated reboot')
  await waitFor(() => serviceActive('agent-runlab-dedicated-ingress.service') && serviceActive('agent-runlab-dedicated-deploy-supervisor.service'), 60_000, 'Dedicated services after reboot')
  origin = 'http://' + containerAddress() + ':13000'
  await waitForHttp(origin + '/runtime/capabilities', 60_000)
  await waitFor(async () => {
    const listed = execNode('/usr/local/bin/runlab-dedicated', ['status'])
    return listed.services?.['agent-runlab-dedicated-ingress.service']?.activeState === 'active'
  }, 30_000, 'operator status after reboot')
  await assertBrowserReady(page, origin)
  socket.close()
  socket = await connectDashboard(origin)
  await waitFor(async () => (await responseEvent(socket, 'client:list_executors', 'server:executors', {})).executors.some((entry) => entry.workspaceName === 'acceptance-workspace'), 60_000, 'Executor reconnect after reboot')
  const afterReboot = await history()
  if (afterReboot.at(-1)?.seq !== continuationCursor || afterReboot.some((entry) => JSON.stringify(entry).includes('[interrupted]'))) throw new Error('Dedicated reboot changed the settled Session cursor')

  exec(['mkdir', '-m', '0700', '/var/backups/runlab-acceptance'])
  exec(['sh', '-c', "printf 'before\\n' > /var/lib/agent-runlab/.agent-kernel/acceptance-marker"])
  const backup = execNode('/usr/local/bin/runlab-dedicated', ['backup', '--output', '/var/backups/runlab-acceptance', '--operation-id', 'operation-backup-' + runId])
  exec(['sh', '-c', "printf 'after\\n' > /var/lib/agent-runlab/.agent-kernel/acceptance-marker"])
  const restored = execNode('/usr/local/bin/runlab-dedicated', ['restore', '--backup', '/var/backups/runlab-acceptance', '--confirm', 'RESTORE:' + backup.backupId, '--operation-id', 'operation-restore-' + runId])
  if (!restored.ok || exec(['cat', '/var/lib/agent-runlab/.agent-kernel/acceptance-marker']).stdout !== 'before\n') throw new Error('Dedicated backup restore did not restore exact state')

  const rollbackRequest = execNode('/usr/local/bin/runlab-dedicated', ['rollback', deployment.deploymentId, '--operation-id', 'operation-rollback-' + runId, '--no-wait'])
  await waitFor(() => { const value = deploymentReceipt(rollbackRequest.deploymentId); return value?.action === 'rollback' && value.phase === 'completed' }, 180_000, 'Supervisor rollback')
  await waitForHttp(origin + '/runtime/capabilities', 60_000)
  await assertBrowserReady(page, origin)
  socket.close()
  socket = await connectDashboard(origin)
  await waitFor(async () => (await responseEvent(socket, 'client:list_executors', 'server:executors', {})).executors.some((entry) => entry.workspaceName === 'acceptance-workspace'), 60_000, 'Executor reconnect after rollback')
  const afterRollback = await history()
  if (afterRollback.at(-1)?.seq !== continuationCursor || afterRollback.filter((entry) => JSON.stringify(entry).includes('acceptance-deploy-call')).length !== 2 || afterRollback.some((entry) => JSON.stringify(entry).includes('[interrupted]'))) throw new Error('Dedicated rollback changed or duplicated the settled Session history')

  const evidence = createRcEvidence({
    category: 'dedicated', target: 'linux-x64-systemd', tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: 'SHA256SUMS', sha256: digest(readFileSync(join(candidate, 'SHA256SUMS'))) },
    checks: { assetIntegrity: true, stagedDisabled: true, cleanInstall: true, browser: true, executor: true, gracefulCutover: true, selfDeployment: true, reboot: true, backupRestore: true, rollback: true },
  })
  mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, category: 'dedicated', target: 'linux-x64-systemd', evidence: basename(output) }) + '\n')
} finally {
  socket?.close()
  await browser?.close().catch(() => undefined)
  if (created) run('lxc', ['delete', '--force', container], true)
  rmSync(scratch, { recursive: true, force: true })
}

function materializeRelease(input, outputDir) {
  const manifest = json(readFileSync(join(input, 'manifest.json'), 'utf8'))
  mkdirSync(outputDir, { recursive: true })
  for (const name of [...manifest.assets, 'manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS']) cpSync(join(input, name), join(outputDir, name))
  return outputDir
}
function assertRelease(path, expectedRevision) { const manifest = json(readFileSync(join(path, 'manifest.json'), 'utf8')); if (expectedRevision && manifest.source?.revision !== expectedRevision) throw new Error('candidate release revision mismatch'); run('sha256sum', ['-c', 'SHA256SUMS'], false, path) }
function service(description, start, extra) { return '[Unit]\nDescription=' + description + '\nAfter=network-online.target\n\n[Service]\nType=simple\n' + extra + '\nExecStart=' + start + '\nRestart=always\nRestartSec=1s\n\n[Install]\nWantedBy=multi-user.target\n' }
function quoteSystemd(value) { return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"' }
function pushText(path, value) { const local = join(scratch, 'push-' + randomUUID()); writeFileSync(local, value); run('lxc', ['file', 'push', local, container + path]); rmSync(local) }
function exec(args, allowFailure = false) { return run('lxc', ['exec', container, '--', ...args], allowFailure) }
function execNode(path, args) { return json(exec(['node', path, ...args]).stdout) }
function serviceActive(name) { return exec(['systemctl', 'is-active', name], true).stdout.trim() === 'active' }
function migrationPhase() { try { return json(exec(['cat', '/var/lib/agent-runlab/deploy/migration-receipt.json']).stdout).phase } catch { return '' } }
function latestDeployment() {
  try {
    const names = exec(['find', '/var/lib/agent-runlab/deploy/receipts', '-maxdepth', '1', '-type', 'f', '-name', '*.json', '-printf', '%f\n'], true).stdout.trim().split(/\r?\n/u).filter(Boolean)
    const values = names.map((name) => json(exec(['cat', '/var/lib/agent-runlab/deploy/receipts/' + name]).stdout))
    return values.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null
  } catch { return null }
}
function deploymentReceipt(deploymentId) {
  try { return json(exec(['cat', '/var/lib/agent-runlab/deploy/receipts/' + deploymentId + '.json']).stdout) } catch { return null }
}
function containerAddress() { const value = run('lxc', ['list', container, '--format', 'json']).stdout; const item = json(value)[0]; const addresses = Object.values(item.state?.network ?? {}).flatMap((entry) => entry.addresses ?? []); const address = addresses.find((entry) => entry.family === 'inet' && entry.scope === 'global')?.address; if (!address) throw new Error('clean LXD environment has no reachable address'); return address }
async function history() { const value = await responseEvent(socket, 'client:load_history', 'server:history', { sessionId }); return value.entries ?? [] }
async function connectDashboard(origin) { const client = io(origin + '/dashboard', { transports: ['websocket'], auth: { role: 'dashboard', sessionId, clientVersion: '1' }, reconnection: true, reconnectionAttempts: 100 }); await once(client, 'session:ready', 30_000); return client }
async function assertBrowserReady(page, origin) { await page.goto(origin, { waitUntil: 'networkidle2' }); await page.waitForFunction(() => document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-status') === 'ready', { timeout: 30_000 }) }
function responseEvent(client, request, response, payload) { return new Promise((resolveValue, reject) => { const timer = setTimeout(() => reject(new Error(response + ' timed out')), 10_000); client.once(response, (value) => { clearTimeout(timer); resolveValue(value) }); client.emit(request, payload) }) }
function ack(client, event, payload) { return client.timeout(10_000).emitWithAck(event, payload) }
function assertAck(value) { if (!value?.ok) throw new Error('Socket operation failed: ' + String(value?.error)) }
function once(client, event, timeout) { return new Promise((resolveValue, reject) => { const timer = setTimeout(() => reject(new Error(event + ' timed out')), timeout); client.once(event, (value) => { clearTimeout(timer); resolveValue(value) }); client.once('connect_error', reject) }) }
async function waitForHttp(url, timeout) { await waitFor(async () => { try { return (await fetch(url)).ok } catch { return false } }, timeout, url) }
async function okJson(response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json() }
async function waitFor(check, timeout, label) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { try { const value = await check(); if (value) return value } catch (error) { last = error }; await new Promise((resolveWait) => setTimeout(resolveWait, 500)) }; throw new Error('timed out waiting for ' + label + (last ? ': ' + String(last) : '')) }
function run(command, args, allowFailure = false, cwd = root) { const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (result.status !== 0 && !allowFailure) throw new Error(command + ' failed: ' + (result.stderr || result.stdout)); return result }
function json(value) { return JSON.parse(String(value)) }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error('missing ' + name); return process.argv[index + 1] }

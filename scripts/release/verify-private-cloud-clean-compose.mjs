#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'
import { io } from 'socket.io-client'
import { loginWithPassword } from '../product-e2e/harness.mjs'
import { createRcEvidence } from './rc-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
if (process.argv.includes('--internal-assert-runtime-gates')) {
  assertRuntimeGateReport(json(readFileSync(0, 'utf8')))
  process.stdout.write(JSON.stringify({ ok: true }) + '\n')
  process.exit(0)
}
if (process.argv.includes('--internal-inspect-organization-provisioning')) {
  process.stdout.write(JSON.stringify(inspectOrganizationProvisioning(acceptanceOrganizationRequests('runlab-rc-test'))) + '\n')
  process.exit(0)
}
const candidateArchive = resolve(required('--candidate-archive'))
const predecessorArchive = resolve(required('--predecessor-archive'))
const executorAsset = resolve(required('--executor'))
const tag = required('--tag')
const revision = required('--revision')
const predecessorRevision = required('--predecessor-revision')
const output = resolve(required('--output'))
const configTemplate = resolve(requiredEnv('KALA_RC_PRIVATE_CLOUD_CONFIG_TEMPLATE'))
const scratch = mkdtempSync(join(tmpdir(), 'runlab-rc-private-cloud-'))
const operatorRoot = join(scratch, 'operator')
const config = join(scratch, 'config')
const backup = join(scratch, 'backup')
const candidate = extract(candidateArchive, join(scratch, 'candidate'))
const predecessor = extract(predecessorArchive, join(scratch, 'predecessor'))
const project = 'runlab-rc-' + randomBytes(6).toString('hex')
const organizationRequests = acceptanceOrganizationRequests(project)
const worktreeOperator = join(root, 'scripts/deploy/kala-private-cloud.mjs')
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
    '--operator', join(candidate, 'kala-private-cloud'),
  ])
  verify(hybrid)

  const predecessorOperator = join(predecessor, 'kala-private-cloud')
  const candidateOperator = join(candidate, 'kala-private-cloud')
  const env = { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot }
  const installedResult = operator(predecessorOperator, ['install', '--bundle', predecessor, '--config-dir', config], env)
  installed = true
  if (!installedResult.ok || installedResult.receipt?.phase !== 'completed') throw new Error('Private Cloud clean install did not complete')
  assertServicesReady(installedResult.services)
  await waitForHttp('http://localhost:13001/healthz', 90_000)
  if ((await fetch('http://localhost:13001/runtime/capabilities')).status !== 401) throw new Error('Private Cloud exposed tenant capabilities without authentication')
  provisionAcceptanceOrganizations(worktreeOperator, env, organizationRequests)

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    alicePassword = await loginWithPassword(page, { productOrigin: 'http://localhost:13001', loginName: requiredEnv('PRIVATE_CLOUD_TEST_ALICE_EMAIL'), password: alicePassword })
    const capabilities = await page.evaluate(async () => {
      const response = await fetch('/runtime/capabilities')
      if (!response.ok) throw new Error('authenticated tenant capabilities returned ' + response.status)
      return response.json()
    })
    if (capabilities.product !== 'private-cloud' || capabilities.deployment?.tenancy !== 'multi-tenant') throw new Error('Private Cloud authenticated tenant capabilities are incorrect')
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
  const credentials = json(readFileSync(effectiveCredentials, 'utf8'))
  alicePassword = credentials.alice
  if (typeof alicePassword !== 'string' || !alicePassword || typeof credentials.bob !== 'string' || !credentials.bob) throw new Error('Private Cloud tenant acceptance did not preserve the effective credentials')
  const workspace = run(process.execPath, ['scripts/private-cloud-local/acceptance/verify-full-workspace.mjs'], false, {
    ...env,
    PRIVATE_CLOUD_TEST_EMAIL: requiredEnv('PRIVATE_CLOUD_TEST_ALICE_EMAIL'),
    PRIVATE_CLOUD_TEST_PASSWORD: alicePassword,
    PRIVATE_CLOUD_TEST_WORKSPACE_ROOT: workspaceRoot,
    PRIVATE_CLOUD_TEST_WORKSPACE_NAME: 'rc-private-cloud-workspace',
    PRIVATE_CLOUD_WORKSPACE_MARKER: 'RC-' + randomBytes(6).toString('hex').toUpperCase(),
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

  configureRuntimeGateLimits(join(config, 'deployment.env'))
  const fullUpgrade = operator(candidateOperator, ['upgrade', '--bundle', candidate], env)
  if (fullUpgrade.receipt?.phase !== 'completed') throw new Error('Private Cloud full upgrade did not complete')
  assertServicesReady(fullUpgrade.services)
  await waitForHttp('http://localhost:13001/healthz', 90_000)
  verifyMtlsClientRejection(candidate, config)
  const runtimeGates = await verifyCandidateRuntimeGates({ candidate, config, alicePassword, bobPassword: credentials.bob })
  assertRuntimeGateReport(runtimeGates)
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
  await waitForHttp('http://localhost:13001/healthz', 90_000)

  const evidence = createRcEvidence({
    category: 'private-cloud', target: 'linux-x64-compose', tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: basename(candidateArchive), sha256: digest(readFileSync(candidateArchive)) },
    checks: { assetIntegrity: true, cleanInstall: true, organizationProvisioning: true, tenantIsolation: true, browser: true, executor: true, fullUpgrade: true, mtlsClientRejection: true, unitResourceIsolation: true, runtimeRestartRecovery: true, dashboardUpgradeIsolation: true, rollback: true, backupRestore: true },
  })
  mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, category: 'private-cloud', target: 'linux-x64-compose', evidence: basename(output) }) + '\n')
} finally {
  if (executor) { executor.kill('SIGTERM'); await new Promise((resolveExit) => { const timer = setTimeout(() => { executor.kill('SIGKILL'); resolveExit() }, 5_000); executor.once('exit', () => { clearTimeout(timer); resolveExit() }) }) }
  if (installed) {
    try {
      const active = json(readFileSync(join(operatorRoot, 'installation.json'), 'utf8'))
      operator(join(candidate, 'kala-private-cloud'), ['uninstall', '--confirm', 'UNINSTALL:' + active.installationId], { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot })
    } catch {}
  }
  cleanupProject(project)
  rmSync(scratch, { recursive: true, force: true })
}

function acceptanceOrganizationRequests(project) {
  const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const requests = ['alice', 'bob'].map((name) => ({
    name,
    issuer: requiredEnv(`PRIVATE_CLOUD_TEST_${name.toUpperCase()}_OIDC_ISSUER`),
    subject: requiredEnv(`PRIVATE_CLOUD_TEST_${name.toUpperCase()}_OIDC_SUBJECT`),
    email: requiredEnv(`PRIVATE_CLOUD_TEST_${name.toUpperCase()}_EMAIL`),
    organizationName: `RC clean acceptance ${name} ${project}`,
    contractReference: `${project}-${name}`,
    endsAt,
    operationId: `${project}-provision-${name}`,
  }))
  if (requests[0].issuer === requests[1].issuer && requests[0].subject === requests[1].subject) throw new Error('Private Cloud acceptance owners must use distinct exact OIDC issuer/sub identities')
  return requests
}

function provisionAcceptanceOrganizations(binary, env, requests) {
  const organizationIds = requests.map((request) => {
    const result = operator(binary, [
      'provision-organization', '--owner-issuer', request.issuer, '--owner-subject', request.subject,
      '--owner-email', request.email, '--organization-name', request.organizationName,
      '--contract-reference', request.contractReference, '--ends-at', request.endsAt,
      '--operation-id', request.operationId,
    ], env)
    if (typeof result.organizationId !== 'string' || !result.organizationId) throw new Error(`Private Cloud ${request.name} organization provisioning returned no organization ID`)
    return result.organizationId
  })
  if (new Set(organizationIds).size !== requests.length) throw new Error('Private Cloud acceptance owners were provisioned into the same Organization')
}

function inspectOrganizationProvisioning(requests) {
  return { requests: requests.map((request) => ({ ...request, subject: undefined, subjectSha256: digest(request.subject) })) }
}

function configureRuntimeGateLimits(path) {
  const names = new Set(['KALA_RUNTIME_UNIT_MAX_QUEUED_MESSAGES', 'KALA_RUNTIME_UNIT_MAX_ARTIFACT_BYTES'])
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line && !names.has(line.split('=', 1)[0]))
  lines.push('KALA_RUNTIME_UNIT_MAX_QUEUED_MESSAGES=1', 'KALA_RUNTIME_UNIT_MAX_ARTIFACT_BYTES=1048576')
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 })
}

function verifyMtlsClientRejection(release, config) {
  const invocation = composeInvocation(release, config, ['exec', '-T', 'runtime-host', '/nodejs/bin/node', '-e', `
const https = require('node:https'); const fs = require('node:fs');
const request = https.get({ host: '127.0.0.1', port: 13002, path: '/internal/health', servername: 'runtime-host', ca: fs.readFileSync('/run/kala-secrets/internal_ca.pem'), minVersion: 'TLSv1.3' }, (response) => {
  response.resume(); console.log(JSON.stringify({ rejected: false, status: response.statusCode })); process.exitCode = 2;
});
request.setTimeout(5000, () => request.destroy(new Error('probe timeout')));
request.on('error', (error) => console.log(JSON.stringify({ rejected: true, code: error.code || '', message: error.message })));
`])
  const result = run(invocation.command, invocation.args, false, invocation.env, invocation.cwd)
  const report = json(result.stdout.trim().split(/\r?\n/u).at(-1))
  if (report.rejected !== true || typeof report.message !== 'string' || !/certificate|alert|socket|tls/iu.test(report.message + ' ' + report.code)) throw new Error('Private Cloud Runtime accepted a client without an internal-CA certificate')
}

async function verifyCandidateRuntimeGates({ candidate, config, alicePassword, bobPassword }) {
  const origin = 'http://localhost:13001'
  const marker = 'rc-recovered-' + randomBytes(6).toString('hex')
  const chatSession = 'rc-recovery-chat-' + randomBytes(6).toString('hex')
  const dagSession = 'rc-recovery-dag-' + randomBytes(6).toString('hex')
  const aliceArtifactSession = 'rc-quota-alice-' + randomBytes(6).toString('hex')
  const bobArtifactSession = 'rc-quota-bob-' + randomBytes(6).toString('hex')
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const actors = []
  let chatSocket
  let dagSocket
  try {
    for (const [name, email, password, sessionId] of [
      ['alice', requiredEnv('PRIVATE_CLOUD_TEST_ALICE_EMAIL'), alicePassword, chatSession],
      ['bob', requiredEnv('PRIVATE_CLOUD_TEST_BOB_EMAIL'), bobPassword, bobArtifactSession],
    ]) {
      const context = await browser.createBrowserContext()
      const page = await context.newPage()
      await loginWithPassword(page, { productOrigin: origin, loginName: email, password })
      const cookie = (await page.cookies()).map((entry) => entry.name + '=' + entry.value).join('; ')
      const socket = connectDashboard(origin, cookie, sessionId)
      await once(socket, 'session:ready', 20_000)
      actors.push({ name, context, page, cookie, socket })
    }
    const alice = actors[0]
    const bob = actors[1]
    assertSocketAck(await socketAck(alice.socket, 'client:create_session', { operationId: operationId(), sessionId: aliceArtifactSession }))
    assertSocketAck(await socketAck(bob.socket, 'client:create_session', { operationId: operationId(), sessionId: bobArtifactSession }))
    const aliceArtifactStatuses = await uploadFixtureBytes(alice.page, aliceArtifactSession, [1048577])
    const bobArtifactStatuses = await uploadFixtureBytes(bob.page, bobArtifactSession, [1])

    const executors = await socketEventAfterEmit(alice.socket, 'server:executors', 'client:list_executors', {}, 15_000)
    const workspace = executors.executors?.find((entry) => entry.workspaceId)
    if (!workspace) throw new Error('Private Cloud recovery acceptance found no tenant Executor')
    assertSocketAck(await socketAck(alice.socket, 'client:create_session', {
      operationId: operationId(), sessionId: chatSession, workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName,
    }))
    const firstAck = await socketAck(alice.socket, 'client:user_message', {
      intent: 'shell', sessionId: chatSession, text: '!sleep 90', mode: 'steer', operationId: operationId(),
    })
    assertSocketAck(firstAck)
    const queueObserved = socketEventMatching(alice.socket, 'server:message_queue', (event) => event.sessionId === chatSession && event.items?.some((item) => item.text === '!printf ' + marker && item.mode === 'queue'), 20_000)
    assertSocketAck(await socketAck(alice.socket, 'client:user_message', {
      intent: 'shell', sessionId: chatSession, text: '!printf ' + marker, mode: 'queue', operationId: operationId(),
    }))
    await queueObserved
    const beforeHistory = await loadHistory(alice.socket, chatSession)
    const cursorBefore = maxHistoryCursor(beforeHistory)
    if (cursorBefore < 1) throw new Error('Private Cloud recovery Session had no durable cursor before restart')

    dagSocket = connectDashboard(origin, alice.cookie, dagSession)
    await once(dagSocket, 'session:ready', 20_000)
    assertSocketAck(await socketAck(dagSocket, 'client:create_session', {
      operationId: operationId(), sessionId: dagSession, executionMode: 'dag', workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName,
    }))
    const initialized = await socketAck(dagSocket, 'client:initialize_dag', {
      operationId: operationId(), sessionId: dagSession, objective: 'Prove a candidate Runtime DAG survives a planned container restart.',
      graph: { expectedGraphVersion: 0, resultNodeId: 'recovery-node', nodes: [{ id: 'recovery-node', title: 'Recovery node', instructions: 'Analyze the phrase runtime restart recovery and reply with one concise sentence.' }], edges: [] },
    }, 20_000)
    assertSocketAck(initialized)
    const dagBefore = await waitFor(async () => {
      const result = await socketAck(dagSocket, 'client:get_dag_run', { sessionId: dagSession }, 10_000)
      return result?.ok && result.value?.events?.some((event) => event.type === 'lease') ? result.value : undefined
    }, 30_000, 'candidate DAG lease')

    const preRestartHistory = await loadHistory(alice.socket, chatSession)
    if (preRestartHistory.entries?.some((entry) => entry.event?.kind === 'user_message' && String(entry.event.text).includes('Shell command result') && String(entry.event.text).includes(marker))) throw new Error('Queued command ran before the Runtime restart; recovery was not tested')
    alice.socket.close(); bob.socket.close(); dagSocket.close(); dagSocket = undefined
    const invocation = composeInvocation(candidate, config, ['stop', 'runtime-host'])
    run(invocation.command, invocation.args, false, invocation.env, invocation.cwd)
    const start = composeInvocation(candidate, config, ['start', 'runtime-host'])
    run(start.command, start.args, false, start.env, start.cwd)
    await waitForHttp(origin + '/healthz', 90_000)

    chatSocket = connectDashboard(origin, alice.cookie, chatSession)
    await once(chatSocket, 'session:ready', 30_000)
    const recoveredHistory = await waitFor(async () => {
      const history = await loadHistory(chatSocket, chatSession)
      return history.entries?.some((entry) => entry.event?.kind === 'user_message' && String(entry.event.text).includes('Shell command result') && String(entry.event.text).includes(marker)) ? history : undefined
    }, 120_000, 'durable queued shell after Runtime restart')
    const cursorAfter = maxHistoryCursor(recoveredHistory)

    dagSocket = connectDashboard(origin, alice.cookie, dagSession)
    await once(dagSocket, 'session:ready', 30_000)
    const dagAfterResult = await socketAck(dagSocket, 'client:get_dag_run', { sessionId: dagSession }, 20_000)
    assertSocketAck(dagAfterResult)
    const dagAfter = dagAfterResult.value
    return {
      unitResourceIsolation: { aliceArtifactStatuses, bobArtifactStatuses },
      restartRecovery: {
        queuedMarkerRecovered: true,
        cursorBefore,
        cursorAfter,
        dagRunIdBefore: dagBefore.id,
        dagRunIdAfter: dagAfter?.id,
        dagLeaseEventsBefore: dagBefore.events.filter((event) => event.type === 'lease').length,
        dagLeaseEventsAfter: dagAfter?.events?.filter((event) => event.type === 'lease').length ?? 0,
      },
    }
  } finally {
    chatSocket?.close(); dagSocket?.close()
    for (const actor of actors) { actor.socket.close(); await actor.context.close().catch(() => undefined) }
    await browser.close()
  }
}

function assertRuntimeGateReport(report) {
  const quota = report?.unitResourceIsolation
  if (JSON.stringify(quota?.aliceArtifactStatuses) !== JSON.stringify([400]) || JSON.stringify(quota?.bobArtifactStatuses) !== JSON.stringify([200])) throw new Error('Private Cloud per-Unit artifact quota did not fail closed without affecting a second Unit')
  const recovery = report?.restartRecovery
  if (recovery?.queuedMarkerRecovered !== true || !Number.isSafeInteger(recovery.cursorBefore) || recovery.cursorBefore < 1 || !Number.isSafeInteger(recovery.cursorAfter) || recovery.cursorAfter < recovery.cursorBefore) throw new Error('Private Cloud queue or Session cursor did not survive Runtime restart')
  if (!recovery.dagRunIdBefore || recovery.dagRunIdAfter !== recovery.dagRunIdBefore || !Number.isSafeInteger(recovery.dagLeaseEventsBefore) || recovery.dagLeaseEventsBefore < 1 || !Number.isSafeInteger(recovery.dagLeaseEventsAfter) || recovery.dagLeaseEventsAfter < recovery.dagLeaseEventsBefore) throw new Error('Private Cloud DAG lease history did not survive Runtime restart')
}

function connectDashboard(origin, cookie, sessionId) { return io(origin + '/dashboard', { transports: ['websocket'], extraHeaders: { cookie }, auth: { role: 'dashboard', sessionId, clientVersion: '1' }, reconnection: false }) }
function operationId() { return 'rc-operation-' + randomBytes(12).toString('hex') }
function socketAck(socket, event, payload, timeout = 15_000) { return socket.timeout(timeout).emitWithAck(event, payload) }
function assertSocketAck(value) { if (!value?.ok) throw new Error('Private Cloud Runtime operation failed: ' + String(value?.error)) }
function socketEventAfterEmit(socket, responseEvent, requestEvent, payload, timeout) { const pending = once(socket, responseEvent, timeout); socket.emit(requestEvent, payload); return pending }
function socketEventMatching(socket, event, predicate, timeout) { return new Promise((resolveEvent, reject) => { const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(event + ' timed out')) }, timeout); const listener = (value) => { if (!predicate(value)) return; clearTimeout(timer); socket.off(event, listener); resolveEvent(value) }; socket.on(event, listener) }) }
function loadHistory(socket, sessionId) { return socketEventAfterEmit(socket, 'server:history', 'client:load_history', { sessionId }, 15_000) }
function maxHistoryCursor(history) { return Math.max(0, ...(history.entries ?? []).map((entry) => Number(entry.seq) || 0)) }
async function uploadFixtureBytes(page, sessionId, sizes) { return await page.evaluate(async ({ sessionId, sizes }) => { const statuses = []; for (const size of sizes) { const response = await fetch('/runtime/attachments?sessionId=' + encodeURIComponent(sessionId), { method: 'POST', headers: { 'content-type': 'text/plain', 'x-agent-runlab-attachment-name': encodeURIComponent('quota-' + size + '-' + statuses.length + '.txt') }, body: 'x'.repeat(size) }); statuses.push(response.status) }; return statuses }, { sessionId, sizes }) }

function extract(archive, destination) { mkdirSync(destination, { recursive: true }); run('tar', ['-xzf', archive, '-C', destination]); const entries = readdirFlat(destination); const rootEntry = entries.length === 1 && entries[0].directory ? join(destination, entries[0].name) : destination; const manifest = find(rootEntry, 'manifest.json'); return resolve(manifest, '..') }
function readdirFlat(path) { return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })) }
function find(rootDir, name) { const queue = [rootDir]; while (queue.length) { const current = queue.shift(); for (const entry of readdirSync(current, { withFileTypes: true })) { const path = join(current, entry.name); if (entry.isFile() && entry.name === name) return path; if (entry.isDirectory()) queue.push(path) } }; throw new Error('archive is missing ' + name) }
function verify(path) { const result = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', path]); if (!json(result.stdout).ok) throw new Error('Private Cloud bundle verification failed') }
function requirePrivateConfig(path) { for (const name of ['deployment.env', 'runtime-provider-catalog.json']) if (!existsSync(join(path, name))) throw new Error('Private Cloud config template is missing ' + name); if (!existsSync(join(path, 'secrets'))) throw new Error('Private Cloud config template is missing secrets') }
function rewriteDeploymentEnv(path, project) { const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line && !line.startsWith('COMPOSE_PROJECT_NAME=')); lines.push('COMPOSE_PROJECT_NAME=' + project); writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 }) }
function operator(binary, args, env) { const result = run(binary, args, false, env); return json(result.stdout) }
function assertServicesReady(services) { for (const name of ['runtime-host', 'runtime-ingress', 'dashboard']) if (services?.[name]?.state !== 'running' || !['', 'healthy'].includes(services[name].health)) throw new Error('Private Cloud service is not ready: ' + name) }
function inspectVolume(release, config, name) { const invocation = composeInvocation(release, config, ['config', '--format', 'json']); const value = json(run(invocation.command, invocation.args, false, invocation.env, invocation.cwd).stdout); return value.volumes?.[name]?.name ?? envFile(join(config, 'deployment.env')).COMPOSE_PROJECT_NAME + '_' + name }
function composeInvocation(release, config, args) { const deployment = envFile(join(config, 'deployment.env')); const storage = deployment.KALA_STORAGE === 'local-volume' ? 'compose.storage-local.yaml' : deployment.KALA_STORAGE === 'external-nfs' ? 'compose.storage-external-nfs.yaml' : 'compose.storage-nfs.yaml'; const profile = deployment.KALA_PROFILE === 'local' ? 'compose.local.yaml' : 'compose.cloudflare.yaml'; const lock = json(readFileSync(join(release, 'image-lock.json'), 'utf8')); return { command: 'docker', cwd: release, env: { ...process.env, ...deployment, KALA_RUNTIME_IMAGE: lock.images.runtime, KALA_INGRESS_IMAGE: lock.images.ingress, KALA_DASHBOARD_IMAGE: lock.images.dashboard, KALA_SECRETS_DIR: join(config, 'secrets'), KALA_PROVIDER_CATALOG_FILE: join(config, 'runtime-provider-catalog.json'), KALA_DEPLOYMENT_CONFIG_FILE: join(release, 'deployment.json') }, args: ['compose', '--project-name', deployment.COMPOSE_PROJECT_NAME, '--env-file', join(config, 'deployment.env'), '-f', join(release, 'compose.yaml'), '-f', join(release, storage), '-f', join(release, profile), ...args] } }
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
function run(command, args, allowFailure = false, env = process.env, cwd = root) { const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (result.status !== 0 && !allowFailure) throw new Error(command + ' failed: ' + (result.stderr || result.stdout)); return result }
function json(value) { return JSON.parse(String(value)) }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error('missing ' + name); return process.argv[index + 1] }
function requiredEnv(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(name + ' is required'); return value }

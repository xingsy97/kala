import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

import { DedicatedDeploySupervisor, activateRelease } from '../src/tenant-runtime/dedicated-deploy-supervisor.js'
import { writeAtomicFile } from '../src/tenant-runtime/atomic-json-file.js'
import { readDedicatedRouteState, writeDedicatedRouteState, type DedicatedSlot } from '../src/tenant-runtime/dedicated-slot-state.js'
import type { HostRestartAttempt, HostRestartStatus, RuntimeCapabilitiesPayload } from '@agent-kernel/shared'
import type { DedicatedDeployRequest } from '../src/tenant-runtime/dedicated-deploy-protocol.js'
import { parseDeploymentReceipt, redactedDeploymentError } from '../src/tenant-runtime/dedicated-deploy-protocol.js'
import type { UnitQuiescence } from '../src/tenant-runtime/quiescence.js'
import { DedicatedAdmissionLedger } from '../src/tenant-runtime/dedicated-admission-ledger.js'
import { createIncomingDirectory, dashboardReleaseDigest, discardIncoming, parseDashboardManifest, parseDashboardRequest, publishIncoming, readDashboardRouteState, resolveRelease, verifyDashboardPublicRoute, writeDashboardRouteState, type DashboardDeploymentReceipt } from '../src/tenant-runtime/dedicated-dashboard.js'
import { readDedicatedProcessReadiness, readDedicatedRuntimeReadiness, dedicatedRuntimeStateIdentity } from '../src/tenant-runtime/dedicated-runtime-readiness.js'

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function main(): Promise<void> {
  const root = resolve(process.env.AGENT_RUNLAB_DEPLOY_ROOT ?? '/var/lib/agent-runlab/deploy')
  const routeStatePath = resolve(process.env.AGENT_RUNLAB_ROUTE_STATE_PERSISTENT ?? join(root, 'route-state.json'))
  const unitService = (slot: DedicatedSlot): string => `agent-runlab-dedicated-unit@${slot}.service`
  const slotOrigin = async (slot: DedicatedSlot): Promise<string> => (await readDedicatedRouteState(routeStatePath)).slots[slot].origin
  const pollMs = positive(process.env.AGENT_RUNLAB_DEPLOY_POLL_MS, 1000)
  const admission = new DedicatedAdmissionLedger(resolve(process.env.AGENT_RUNLAB_ADMISSION_LEDGER ?? '/var/lib/agent-runlab/admission/ledger.json'))
  const handoffHeaders = (): Record<string, string> => {
    const secret = process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET?.trim()
    if (!secret) throw new Error('Supervisor runtime control requires AGENT_RUNLAB_INGRESS_HANDOFF_SECRET')
    return { 'x-agent-runlab-ingress-handoff': secret }
  }
  const supervisor = new DedicatedDeploySupervisor(root, {
    routeState: async () => await readDedicatedRouteState(routeStatePath),
    inspectQuiescence: async (slot) => await fetchJson<UnitQuiescence>(`${await slotOrigin(slot)}/internal/runtime/quiescence`),
    originToolResultPersisted: async (slot, origin) => {
      const secret = process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET?.trim()
      if (!secret) throw new Error('origin result barrier requires AGENT_RUNLAB_INGRESS_HANDOFF_SECRET')
      const result = await fetchJson<{ persisted: boolean }>(
        `${await slotOrigin(slot)}/internal/runtime/tool-result/${encodeURIComponent(origin.sessionId)}/${encodeURIComponent(origin.callId)}`,
        { 'x-agent-runlab-ingress-handoff': secret },
      )
      return result.persisted
    },
    requestPlannedRestart: async (slot, ownership) => await postJson<HostRestartAttempt>(`${await slotOrigin(slot)}/internal/runtime/restart`, {
      mode: 'checkpoint', reason: 'deploy', deployment: ownership,
      // A provider connection may fail to settle forever. The Runtime owns
      // the checkpoint deadline and aborts its drain before the Supervisor
      // performs a safe pre-handoff rollback, so no deployment can leave
      // message queues globally paused without a terminal receipt.
      timeoutMs: positive(process.env.AGENT_RUNLAB_RESTART_CHECKPOINT_TIMEOUT_MS, 10 * 60_000),
    }, handoffHeaders()),
    restartStatus: async (slot) => await fetchJson<HostRestartStatus>(`${await slotOrigin(slot)}/internal/runtime/restart/status`, handoffHeaders()),
    commitPlannedRestart: async (slot, attemptId) => await postJson<HostRestartAttempt>(`${await slotOrigin(slot)}/internal/runtime/restart/commit`, { attemptId }, handoffHeaders()),
    abortPlannedRestart: async (slot, attemptId) => { await postJson(`${await slotOrigin(slot)}/internal/runtime/restart/abort`, attemptId ? { attemptId } : {}, handoffHeaders()) },
    selfTestRelease: async (releaseDir) => {
      const result = await command('/usr/bin/node', ['--check', join(releaseDir, 'agent-runlab-runtime.cjs')], true)
      if (result.trim()) process.stdout.write(result)
    },
    startControlPlaneUpdate: async (receipt) => {
      const predecessorSums = await readFile(join(root, 'releases', receipt.predecessorReleaseId, 'SHA256SUMS'))
      const request: ControlUpdateRequest = {
        schemaVersion: 1, updateId: `control-${receipt.deploymentId}`, deploymentId: receipt.deploymentId,
        direction: receipt.action === 'rollback' ? 'rollback' : 'forward',
        targetReleaseId: receipt.releaseId, targetReleaseDigest: receipt.releaseDigest,
        predecessorReleaseId: receipt.predecessorReleaseId, predecessorReleaseDigest: createHash('sha256').update(predecessorSums).digest('hex'),
        requestedAt: new Date().toISOString(),
      }
      await submitControlUpdateRequest(root, request)
      await systemctl('start', '--no-block', 'agent-runlab-dedicated-control-updater.service')
    },
    controlPlaneUpdateStatus: async (receipt) => {
      const value = await readControlUpdateReceipt(root, `control-${receipt.deploymentId}`)
      if (!value || value.deploymentId !== receipt.deploymentId) return { phase: 'pending' as const }
      const phase = value.phase === 'completed' ? 'completed' : value.phase === 'rolled_back' ? 'rolled_back' : value.phase === 'rollback_failed' ? 'rollback_failed' : 'pending'
      return {
        phase,
        ...(Number.isSafeInteger(value.previousSupervisorPid) ? { previousSupervisorPid: Number(value.previousSupervisorPid) } : {}),
        ...(Number.isSafeInteger(value.previousIngressPid) ? { previousIngressPid: Number(value.previousIngressPid) } : {}),
        ...(Number.isSafeInteger(value.ingressPid) ? { ingressPid: Number(value.ingressPid) } : {}),
        ...(Number.isSafeInteger(value.supervisorPid) ? { supervisorPid: Number(value.supervisorPid) } : {}),
        ...(typeof value.activatedAt === 'string' ? { activatedAt: value.activatedAt } : {}),
        ...(typeof value.readyAt === 'string' ? { readyAt: value.readyAt } : {}),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
      }
    },
    recoverControlPlane: async (receipt) => {
      const forwardUpdateId = `control-${receipt.deploymentId}`
      const forward = await readControlUpdateReceipt(root, forwardUpdateId)
      if (forward && !['completed', 'rolled_back', 'rollback_failed'].includes(String(forward.phase))) return { phase: 'pending' as const }
      if (forward?.phase === 'rolled_back') return { phase: 'recovered' as const }
      if (forward?.phase === 'rollback_failed') return { phase: 'failed' as const, error: typeof forward.error === 'string' ? forward.error : 'control-plane rollback failed' }
      // A completed control update may already have durably advanced Ingress
      // protocol state before the Runtime candidate is verified. Keep that
      // backward-compatible control plane while replacing the Runtime slot;
      // downgrading it first can leave the predecessor Supervisor unable to
      // parse the newly written ledger and deadlock rollback readiness.
      if (forward?.phase === 'completed') return { phase: 'recovered' as const }
      if (!forward) {
        const activeControlReleaseId = await readlink(join(root, 'control-current')).then((path) => basename(path)).catch(() => undefined)
        if (activeControlReleaseId === receipt.predecessorReleaseId) return { phase: 'recovered' as const }
        if (activeControlReleaseId !== receipt.releaseId) return { phase: 'failed' as const, error: 'control release ownership is uncertain' }
      }
      const recoveryUpdateId = `control-recovery-${receipt.deploymentId}`
      const predecessorSums = await readFile(join(root, 'releases', receipt.predecessorReleaseId, 'SHA256SUMS'))
      const request: ControlUpdateRequest = {
        schemaVersion: 1, updateId: recoveryUpdateId, deploymentId: receipt.deploymentId, direction: 'rollback',
        targetReleaseId: receipt.predecessorReleaseId, targetReleaseDigest: createHash('sha256').update(predecessorSums).digest('hex'),
        predecessorReleaseId: receipt.releaseId, predecessorReleaseDigest: receipt.releaseDigest,
        requestedAt: new Date().toISOString(),
      }
      await submitControlUpdateRequest(root, request)
      await systemctl('start', '--no-block', 'agent-runlab-dedicated-control-updater.service')
      const recovery = await readControlUpdateReceipt(root, recoveryUpdateId)
      if (!recovery) return { phase: 'pending' as const }
      if (recovery.phase === 'completed') return { phase: 'recovered' as const }
      if (recovery.phase === 'rolled_back' || recovery.phase === 'rollback_failed') return { phase: 'failed' as const, error: typeof recovery.error === 'string' ? recovery.error : `control recovery ${String(recovery.phase)}` }
      return { phase: 'pending' as const }
    },
    writeRuntimeFence: async (ownership) => {
      const path = join(root, 'runtime.env')
      if (!ownership) { await rm(path, { force: true }); return }
      await writeTextFile(path, `AGENT_RUNLAB_EXPECTED_DEPLOYMENT=${JSON.stringify(JSON.stringify(ownership))}\n`)
    },
    writeCandidateState: async (state) => {
      const path = join(root, 'candidate-state.json')
      if (!state) { await rm(path, { force: true }); return }
      // Stable Ingress runs as agent-runlab while Supervisor is privileged;
      // publish the handoff fence group-readable in the atomically renamed file.
      await writeAtomicFile(path, `${JSON.stringify({ schemaVersion: 1, ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, 0o640)
    },
    admissionSnapshot: async () => await admission.snapshot(),
    persistRuntimeReady: async (receipt, evidence) => {
      await writeAtomicFile(join(root, 'runtime-ready.json'), JSON.stringify({
        schemaVersion: 1,
        deploymentId: receipt.deploymentId,
        operationId: receipt.operationId,
        releaseDigest: receipt.releaseDigest,
        bundleSha256: receipt.bundleSha256,
        candidateSlot: receipt.candidateSlot,
        pid: evidence.pid,
        processReadyAt: evidence.processReadyAt,
        runtimeReadyAt: evidence.runtimeReadyAt,
        expectedRouteGeneration: receipt.expectedRouteGeneration,
        admissionReconciled: true,
        publicRoute: evidence.publicRoute,
        ...(evidence.routeGeneration === undefined ? {} : { routeGeneration: evidence.routeGeneration }),
      }, null, 2) + '\n')
    },
    clearRuntimeReady: async () => { await rm(join(root, 'runtime-ready.json'), { force: true }) },
    activateSlot: async (slot, releaseDir) => await activateRelease(join(root, 'slots', slot), releaseDir),
    startSlot: async (slot) => await systemctl('enable', '--now', unitService(slot)),
    stopSlot: async (slot) => await systemctl('disable', '--now', unitService(slot)),
    verifySlot: async (slot, expected) => {
      const origin = await slotOrigin(slot)
      const deadline = Date.now() + positive(process.env.AGENT_RUNLAB_SLOT_VERIFY_TIMEOUT_MS, 5 * 60_000)
      let lastError: unknown
      while (Date.now() < deadline) {
        try {
          const capabilities = await fetchJson<RuntimeCapabilitiesPayload>(`${origin}/runtime/capabilities`)
          if (capabilities.product !== 'dedicated'
            || capabilities.deployment.architecture !== 'platform'
            || capabilities.deployment.tenancy !== 'single-tenant'
            || capabilities.deployment.runtimeProfile !== 'full'
            || !capabilities.capabilities.operations
            || !capabilities.capabilities.pipeline) throw new Error('Dedicated capability profile mismatch')
          const activeBundle = join(root, 'slots', slot, 'agent-runlab-runtime.cjs')
          const actual = createHash('sha256').update(await readFile(activeBundle)).digest('hex')
          if (actual !== expected.bundleSha256) throw new Error('active bundle digest mismatch')
          const restart = await fetchJson<HostRestartStatus>(`${origin}/internal/runtime/restart/status`, handoffHeaders())
          if (expected.deployment && expected.requireContinuation !== false) {
            const marker = restart.current?.deployment?.deploymentId === expected.deployment.deploymentId ? restart.current : restart.last?.deployment?.deploymentId === expected.deployment.deploymentId ? restart.last : undefined
            if (!marker || marker.phase !== 'completed') throw new Error('candidate runtime continuation is not ready')
            if (!sameDeploymentFence(marker.deployment, expected.deployment)) throw new Error('candidate restart deployment fence mismatch')
          }
          const pid = Number((await systemctlOutput('show', '--property=MainPID', '--value', unitService(slot))).trim())
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('slot has no live pid')
          const processReadiness = await readDedicatedProcessReadiness(`/run/agent-runlab/unit-${slot}-process-ready.json`)
          const readiness = await readDedicatedRuntimeReadiness(`/run/agent-runlab/unit-${slot}-readiness.json`)
          const stateRoot = await dedicatedRuntimeStateIdentity('/var/lib/agent-runlab/.agent-kernel/sessions')
          if (processReadiness.pid !== pid || readiness.pid !== pid) throw new Error('process or runtime readiness pid mismatch')
          if (expected.deployment && !sameDeploymentFence(processReadiness.deployment, expected.deployment)) throw new Error('process readiness deployment fence mismatch')
          if (JSON.stringify(readiness.stateRoot) !== JSON.stringify(stateRoot)) throw new Error('runtime state root mismatch')
          const ownedLease = await processOwnsPath(pid, '/var/lib/agent-runlab/units/local/write.lock')
          if (!ownedLease || readiness.writeLease.pathDigest !== createHash('sha256').update(ownedLease).digest('hex')) throw new Error('runtime write lease mismatch')
          if (!Object.values(readiness.capabilities).every(Boolean)) throw new Error('runtime readiness capability mismatch')
          if (readiness.continuation.failed > 0 || readiness.continuation.completed !== readiness.continuation.participants) throw new Error('planned continuation is incomplete')
          if (expected.deployment && !sameDeploymentFence(readiness.deployment, expected.deployment)) throw new Error('runtime readiness deployment fence mismatch')
          return { pid, processReadyAt: processReadiness.readyAt, runtimeReadyAt: readiness.readyAt, continuation: readiness.continuation }
        } catch (error) { lastError = error; await sleep(250) }
      }
      throw new Error(`Unit slot ${slot} verification timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
    },
    switchRoute: async (state) => { await writeDedicatedRouteState(routeStatePath, state) },
  })
  let stopping = false
  process.on('SIGTERM', () => { stopping = true })
  process.on('SIGINT', () => { stopping = true })
  process.stdout.write(`${JSON.stringify({ event: 'deploy_supervisor_ready' })}\n`)
  while (!stopping) {
    await reconcileRequests(root, supervisor).catch((error) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`))
    await reconcileDashboardRequests(root).catch((error) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`))
    await writeOperatorStatus(root, routeStatePath, admission, unitService).catch((error) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`))
    await sleep(pollMs)
  }
}

async function reconcileDashboardRequests(root: string): Promise<void> {
  const dashboardRoot = join(root, 'dashboard')
  const requestsRoot = join(dashboardRoot, 'requests')
  const names = await readdir(requestsRoot).catch(() => [])
  for (const name of names.filter((entry) => entry.endsWith('.json') || entry.endsWith('.json.accepted')).sort()) {
    const requestPath = join(requestsRoot, name)
    const acceptedPath = name.endsWith('.accepted') ? requestPath : `${requestPath}.accepted`
    let receipt: DashboardDeploymentReceipt | undefined
    try {
      if (!name.endsWith('.accepted')) await rename(requestPath, acceptedPath)
      const bytes = await readFile(acceptedPath)
      await writeAtomicFile(acceptedPath, bytes, 0o440)
      const request = parseDashboardRequest(JSON.parse(String(bytes)))
      if (name.replace(/\.accepted$/u, '') !== `${request.operationId}.json`) throw new Error('dashboard request filename does not match operationId')
      const receiptPath = join(dashboardRoot, 'receipts', `${request.deploymentId}.json`)
      const existing = await readFile(receiptPath).then((value) => JSON.parse(String(value)) as DashboardDeploymentReceipt).catch(() => undefined)
      if (existing) {
        if (existing.operationId !== request.operationId || existing.releaseId !== request.releaseId || existing.action !== request.action) throw new Error('dashboard deploymentId conflicts with an existing receipt')
        receipt = existing
      } else {
        const now = new Date().toISOString()
        receipt = { schemaVersion: 1, receiptRevision: 1, action: request.action, operationId: request.operationId, deploymentId: request.deploymentId, phase: 'accepted', requestedAt: request.requestedAt, updatedAt: now, expectedGeneration: request.expectedGeneration, releaseId: request.releaseId, releaseDigest: request.releaseDigest }
        await writeDashboardReceipt(receiptPath, receipt)
      }
      if (receipt.phase !== 'completed') receipt = await activateDashboardRequest(dashboardRoot, request, receipt)
      await rename(acceptedPath, `${acceptedPath}.${receipt.phase}`)
      if (request.stagedReleaseDir) await rm(request.stagedReleaseDir, { recursive: true, force: true })
    } catch (error) {
      if (receipt) {
        receipt = { ...receipt, receiptRevision: receipt.receiptRevision + 1, phase: 'failed', updatedAt: new Date().toISOString(), error: { code: 'dashboard_deploy_failed', message: boundedError(error) } }
        await writeDashboardReceipt(join(dashboardRoot, 'receipts', `${receipt.deploymentId}.json`), receipt)
      }
      await rename(acceptedPath, `${acceptedPath}.failed`).catch(() => undefined)
    }
  }
}

async function activateDashboardRequest(root: string, request: ReturnType<typeof parseDashboardRequest>, receipt: DashboardDeploymentReceipt): Promise<DashboardDeploymentReceipt> {
  const statePath = join(root, 'route-state.json')
  const current = await readDashboardRouteState(statePath)
  if (!current || current.generation !== request.expectedGeneration) throw new Error('stale dashboard generation')
  let manifest: ReturnType<typeof parseDashboardManifest>
  if (request.action === 'deploy') {
    const submissions = resolve(root, 'submissions')
    const staged = resolve(request.stagedReleaseDir!)
    if (staged !== resolve(submissions, request.operationId)) throw new Error('dashboard staged release does not match operationId')
    const entries = await readdir(staged, { withFileTypes: true })
    if (entries.some((entry) => !entry.isFile()) || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(['dashboard.tar.gz', 'manifest.json'])) throw new Error('dashboard staged release has unexpected files')
    const manifestBytes = await readFile(join(staged, 'manifest.json'))
    const archiveBytes = await readFile(join(staged, 'dashboard.tar.gz'))
    if (dashboardReleaseDigest(manifestBytes) !== request.manifestSha256 || request.releaseDigest !== request.manifestSha256) throw new Error('dashboard manifest digest mismatch')
    if (createHash('sha256').update(archiveBytes).digest('hex') !== request.archiveSha256) throw new Error('dashboard archive digest mismatch')
    manifest = parseDashboardManifest(JSON.parse(String(manifestBytes)))
    const target = resolveRelease(join(root, 'releases'), request.releaseId)
    try {
      const existing = parseDashboardManifest(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')))
      if (dashboardReleaseDigest(await readFile(join(target, 'manifest.json'))) !== request.releaseDigest || existing.assetDigest !== manifest.assetDigest) throw new Error('immutable dashboard release conflicts with existing content')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const incoming = await createIncomingDirectory(target)
      try {
        await mkdir(join(incoming, 'assets'), { mode: 0o755 })
        await verifyDashboardArchive(join(staged, 'dashboard.tar.gz'), manifest)
        await command('/usr/bin/tar', ['-xzf', join(staged, 'dashboard.tar.gz'), '-C', join(incoming, 'assets'), '--no-same-owner', '--no-same-permissions', '--keep-directory-symlink'], true)
        await verifyDashboardFiles(join(incoming, 'assets'), manifest)
        await copyFile(join(staged, 'manifest.json'), join(incoming, 'manifest.json'))
        await sealDashboardTree(join(incoming, 'assets')); await chmod(join(incoming, 'manifest.json'), 0o444); await chmod(incoming, 0o555)
        await publishIncoming(incoming, target)
      } finally { await discardIncoming(incoming) }
    }
  } else {
    const target = resolveRelease(join(root, 'releases'), request.releaseId)
    const manifestBytes = await readFile(join(target, 'manifest.json'))
    if (dashboardReleaseDigest(manifestBytes) !== request.releaseDigest || request.manifestSha256 !== request.releaseDigest) throw new Error('rollback dashboard release digest mismatch')
    manifest = parseDashboardManifest(JSON.parse(String(manifestBytes)))
    await verifyDashboardFiles(join(target, 'assets'), manifest)
  }
  const now = new Date().toISOString()
  const generation = current.generation + 1
  await writeDashboardRouteState(statePath, { schemaVersion: 1, generation, releaseId: request.releaseId, releaseDigest: request.releaseDigest, assetDigest: manifest.assetDigest, version: manifest.version, protocol: manifest.protocol, activatedAt: now })
  try {
    await verifyDashboardPublicRoute(process.env.AGENT_RUNLAB_PUBLIC_ORIGIN ?? 'http://127.0.0.1:13000', { releaseId: request.releaseId, generation })
  } catch (error) {
    // Route state is monotonic even when activation fails. Restore the known
    // predecessor at a newer generation so Ingress never remains pinned to a
    // release it could not actually serve.
    await writeDashboardRouteState(statePath, { ...current, generation: generation + 1, activatedAt: new Date().toISOString() })
    await verifyDashboardPublicRoute(process.env.AGENT_RUNLAB_PUBLIC_ORIGIN ?? 'http://127.0.0.1:13000', { releaseId: current.releaseId, generation: generation + 1 })
    throw error
  }
  const completed: DashboardDeploymentReceipt = { ...receipt, receiptRevision: receipt.receiptRevision + 1, phase: 'completed', updatedAt: now, observedGeneration: generation, previousReleaseId: current.releaseId }
  await writeDashboardReceipt(join(root, 'receipts', `${request.deploymentId}.json`), completed)
  return completed
}

async function verifyDashboardFiles(root: string, manifest: ReturnType<typeof parseDashboardManifest>): Promise<void> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('dashboard release contains a symlink')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path.slice(root.length + 1).replaceAll('\\', '/'))
      else throw new Error('dashboard release contains a non-file entry')
    }
  }
  await walk(root)
  if (JSON.stringify(files.sort()) !== JSON.stringify(manifest.files.map((file) => file.path).sort())) throw new Error('dashboard archive file set does not match manifest')
  for (const file of manifest.files) {
    const value = await readFile(join(root, file.path)); if (value.length !== file.bytes || createHash('sha256').update(value).digest('hex') !== file.sha256) throw new Error(`dashboard asset mismatch: ${file.path}`)
  }
}

async function verifyDashboardArchive(archive: string, manifest: ReturnType<typeof parseDashboardManifest>): Promise<void> {
  const listing = (await command('/usr/bin/tar', ['-tzf', archive], true)).split('\n').filter(Boolean)
  const verbose = (await command('/usr/bin/tar', ['-tvzf', archive], true)).split('\n').filter(Boolean)
  if (listing.length !== verbose.length || verbose.some((line) => !['-', 'd'].includes(line[0] ?? ''))) throw new Error('dashboard archive contains links or special entries')
  const files: string[] = []
  for (let index = 0; index < listing.length; index += 1) {
    const listed = listing[index]!
    const type = verbose[index]![0]
    if (type === 'd' && (listed === '.' || listed === './')) continue
    const raw = listed.replace(/^\.\//u, '').replace(/\/$/u, '')
    if (!raw || raw.startsWith('/') || raw.split('/').some((part) => !part || part === '.' || part === '..') || raw.includes('\0')) throw new Error('dashboard archive contains an unsafe path')
    if (type === '-') files.push(raw)
  }
  if (JSON.stringify(files.sort()) !== JSON.stringify(manifest.files.map((file) => file.path).sort())) throw new Error('dashboard archive file set does not match manifest')
}

async function sealDashboardTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) { await sealDashboardTree(path); await chmod(path, 0o555) }
    else if (entry.isFile()) await chmod(path, 0o444)
    else throw new Error('dashboard release contains a non-file entry')
  }
  await chmod(root, 0o555)
}

async function writeDashboardReceipt(path: string, receipt: DashboardDeploymentReceipt): Promise<void> { await writeAtomicFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 0o640) }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, ' ').slice(0, 512) }

async function writeOperatorStatus(
  root: string,
  routeStatePath: string,
  admission: DedicatedAdmissionLedger,
  unitService: (slot: DedicatedSlot) => string,
): Promise<void> {
  const route = await readDedicatedRouteState(routeStatePath)
  const receipts = await readdir(join(root, 'receipts')).catch(() => [])
  const deployments = await Promise.all(receipts.filter((name) => name.endsWith('.json')).map(async (name) => parseDeploymentReceipt(JSON.parse(await readFile(join(root, 'receipts', name), 'utf8')))))
  const deployment = deployments.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
  const status = async (slot: DedicatedSlot) => {
    const pid = Number((await systemctlOutput('show', '--property=MainPID', '--value', unitService(slot))).trim())
    const releaseId = route.slots[slot].releaseId
    const sums = await readFile(join(root, 'releases', releaseId, 'SHA256SUMS')).catch(() => undefined)
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0, active: route.activeSlot === slot, releaseId,
      ...(sums ? { releaseDigest: createHash('sha256').update(sums).digest('hex') } : {}),
    }
  }
  const slots = { blue: await status('blue'), green: await status('green') }
  let writeLeaseOwnerPid = 0
  for (const slot of ['blue', 'green'] as const) {
    const pid = slots[slot].pid
    if (pid > 0 && await processOwnsPath(pid, '/var/lib/agent-runlab/units/local/write.lock')) { writeLeaseOwnerPid = pid; break }
  }
  const safeDeployment = deployment ? {
    deploymentId: deployment.deploymentId, operationId: deployment.operationId, phase: deployment.phase,
    requestedAt: deployment.requestedAt, updatedAt: deployment.updatedAt, releaseDigest: deployment.releaseDigest,
    sourceReleaseDigest: deployment.sourceReleaseDigest, previousSlot: deployment.previousSlot, candidateSlot: deployment.candidateSlot,
    processReadyAt: deployment.processReadyAt, runtimeReadyAt: deployment.runtimeReadyAt, routeGeneration: deployment.routeGeneration,
    blockers: deployment.blockers, plannedRestart: deployment.plannedRestart, continuation: deployment.continuation,
    controlPlane: deployment.controlPlane, rollback: deployment.rollback, error: deployment.error,
  } : null
  await writeAtomicFile(join(root, 'operator-status.json'), JSON.stringify({
    schemaVersion: 1, generatedAt: new Date().toISOString(), topology: 'dedicated-slots',
    services: { supervisor: { pid: process.pid } },
    route: { generation: route.generation, activeSlot: route.activeSlot, activeReleaseId: route.slots[route.activeSlot].releaseId },
    slots, writeLeaseOwnerPid,
    admission: await admission.snapshot(),
    deployment: safeDeployment,
  }, null, 2) + '\n', 0o640)
}

async function reconcileRequests(root: string, supervisor: DedicatedDeploySupervisor): Promise<void> {
  const requests = join(root, 'requests')
  const names = await readdir(requests).catch(() => [])
  for (const name of names.filter((entry) => entry.endsWith('.json') || entry.endsWith('.json.accepted')).sort()) {
    const path = join(requests, name)
    const acceptedPath = name.endsWith('.accepted') ? path : `${path}.accepted`
    let claimedPath = path
    let staged: Awaited<ReturnType<DedicatedDeploySupervisor['accept']>>
    try {
      if (!name.endsWith('.accepted')) {
        await rename(path, acceptedPath)
        claimedPath = acceptedPath
      }
      const bytes = await readFile(claimedPath)
      await sealRequest(claimedPath, bytes)
      const input = JSON.parse(String(bytes)) as DedicatedDeployRequest
      const expectedPath = join(requests, `${input.operationId}.json.accepted`)
      if (acceptedPath !== expectedPath) throw new Error('deployment request filename does not match operationId')
      staged = await supervisor.accept(input)
    } catch (error) {
      const rejected = join(requests, name.replace(/\.accepted$/u, '') + '.rejected')
      await rename(claimedPath, rejected).catch(() => undefined)
      await writeAtomicFile(`${rejected}.error`, `${JSON.stringify(redactedDeploymentError(error, 'request_rejected'), null, 2)}\n`, 0o640)
      continue
    }
    const receipt = await supervisor.reconcile(staged.deploymentId)
    if (['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed'].includes(receipt.phase)) {
      await rename(acceptedPath, `${acceptedPath}.${receipt.phase}`)
      await rm(join(root, 'submissions', receipt.operationIds[0]!), { recursive: true, force: true })
    }
  }
}

async function sealRequest(path: string, bytes: Uint8Array): Promise<void> {
  // Replace the submitted inode before parsing it. A writer that retained the
  // original fd can then mutate only the unlinked inode, never the claim.
  await writeAtomicFile(path, bytes, 0o440)
}

async function writeTextFile(path: string, value: string): Promise<void> {
  await writeAtomicFile(path, value)
}

type ControlUpdateRequest = {
  schemaVersion: 1
  updateId: string
  deploymentId: string
  direction: 'forward' | 'rollback'
  targetReleaseId: string
  targetReleaseDigest: string
  predecessorReleaseId: string
  predecessorReleaseDigest: string
  requestedAt: string
}

async function submitControlUpdateRequest(root: string, request: ControlUpdateRequest): Promise<void> {
  const path = join(root, 'control-updates', 'requests', `${request.updateId}.json`)
  const existing = await readFile(path, 'utf8').then((value) => JSON.parse(value) as ControlUpdateRequest).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing && JSON.stringify({ ...existing, requestedAt: request.requestedAt }) !== JSON.stringify(request)) throw new Error('control update request conflicts with deployment')
  if (!existing) await writeAtomicFile(path, `${JSON.stringify(request, null, 2)}\n`, 0o640)
}

async function readControlUpdateReceipt(root: string, updateId: string): Promise<Record<string, unknown> | undefined> {
  return await readFile(join(root, 'control-updates', 'receipts', `${updateId}.json`), 'utf8')
    .then((bytes) => JSON.parse(bytes) as Record<string, unknown>)
    .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error))
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return await response.json() as T
}

async function postJson<T>(url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`)
  return await response.json() as T
}

async function systemctl(...args: string[]): Promise<void> {
  await command('/usr/bin/systemctl', args)
}

async function processOwnsPath(pid: number, expected: string): Promise<string | undefined> {
  const target = await stat(expected, { bigint: true }).catch(() => undefined)
  if (!target?.isFile()) return undefined
  const locks = await readFile('/proc/locks', 'utf8').catch(() => '')
  const expectedDevice = linuxDeviceNumbers(target.dev)
  for (const line of locks.split('\n')) {
    const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(-?\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+/iu.exec(line)
    if (!match || Number(match[1]) !== pid || BigInt(match[4]!) !== target.ino) continue
    if (BigInt(`0x${match[2]!}`) === expectedDevice.major && BigInt(`0x${match[3]!}`) === expectedDevice.minor) return expected
  }
  return undefined
}

function linuxDeviceNumbers(device: bigint): { major: bigint; minor: bigint } {
  return {
    major: ((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn),
    minor: (device & 0xffn) | ((device >> 12n) & ~0xffn),
  }
}

function sameDeploymentFence(
  actual: HostRestartAttempt['deployment'] | undefined,
  expected: NonNullable<HostRestartAttempt['deployment']>,
): boolean {
  return actual?.deploymentId === expected.deploymentId
    && actual.targetReleaseDigest === expected.targetReleaseDigest
    && actual.expectedRouteGeneration === expected.expectedRouteGeneration
    && actual.fencingToken === expected.fencingToken
}

async function systemctlOutput(...args: string[]): Promise<string> {
  return await command('/usr/bin/systemctl', args, true)
}

async function command(file: string, args: string[], capture = false): Promise<string> {
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(file, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let stdout = ''; let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveCommand(stdout) : reject(new Error(`${file} exited ${String(code)}: ${stderr}`)))
  })
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error('poll interval must be positive')
  return value
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

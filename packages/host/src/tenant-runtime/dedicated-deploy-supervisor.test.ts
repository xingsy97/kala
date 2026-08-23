import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostRestartAttempt, HostRestartStatus } from '@agent-kernel/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DedicatedDeploySupervisor } from './dedicated-deploy-supervisor.js'
import type { DedicatedDeployRequest } from './dedicated-deploy-protocol.js'
import type { DedicatedRouteState, DedicatedSlot } from './dedicated-slot-state.js'

const roots: string[] = []
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const safe = { safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }

async function makeTreeRemovable(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    await makeTreeRemovable(join(dir, entry.name))
  }))
}

async function release(root: string, name: string, content: string): Promise<{ dir: string; bundle: string; release: string }> {
  const dir = join(root, 'releases', name)
  const result = await writeRelease(dir, content)
  await chmod(dir, 0o500)
  await Promise.all(result.files.map(async (file) => await chmod(join(dir, file), 0o400)))
  return result
}

async function submission(root: string, operationId: string, content: string): Promise<{ dir: string; bundle: string; release: string }> {
  return await writeRelease(join(root, 'submissions', operationId), content)
}

async function writeRelease(dir: string, content: string): Promise<{ dir: string; bundle: string; release: string; files: string[] }> {
  await mkdir(dir, { recursive: true })
  const files = new Map([
    ['agent-runlab-runtime.cjs', content],
    ['manifest.json', JSON.stringify({ assets: ['agent-runlab-runtime.cjs'] })],
    ['RELEASE_NOTES.md', '# test'],
  ])
  for (const [file, value] of files) await writeFile(join(dir, file), value)
  const sums = [...files].map(([file, value]) => digest(value) + '  ' + file).join('\n') + '\n'
  await writeFile(join(dir, 'SHA256SUMS'), sums)
  return { dir, bundle: digest(content), release: digest(sums), files: [...files.keys(), 'SHA256SUMS'] }
}

function initialRoute(): DedicatedRouteState {
  return { schemaVersion: 1, generation: 1, activeSlot: 'blue', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'old' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'old' } }, updatedAt: new Date().toISOString() }
}

function restart(phase: HostRestartAttempt['phase'], ownership?: HostRestartAttempt['deployment']): HostRestartAttempt {
  return { attemptId: 'restart-attempt-0001', phase, mode: 'checkpoint', reason: 'deploy', requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10, sessions: [], ...(ownership ? { deployment: ownership } : {}) }
}

function harness(route = initialRoute()) {
  let current = route
  let originPersisted = false
  let restartState: HostRestartStatus = { pid: 10, startedAt: new Date().toISOString(), current: null, last: null }
  let requestedRestartPhase: HostRestartAttempt['phase'] = 'checkpoint_reached'
  let includeContinuation = false
  let controlStatus: {
    phase: 'pending' | 'completed' | 'rolled_back' | 'rollback_failed'
    previousSupervisorPid?: number; previousIngressPid?: number; ingressPid?: number; supervisorPid?: number
    activatedAt?: string; readyAt?: string; error?: string
  } | undefined
  const calls: string[] = []
  const adapter = {
    routeState: async () => current,
    inspectQuiescence: vi.fn(async (_slot: DedicatedSlot) => safe),
    originToolResultPersisted: vi.fn(async () => originPersisted),
    requestPlannedRestart: vi.fn(async (_slot: DedicatedSlot, ownership: NonNullable<HostRestartAttempt['deployment']>) => {
      const attempt = restart(requestedRestartPhase, ownership)
      restartState = { ...restartState, current: attempt }
      calls.push('restart:request')
      return attempt
    }),
    restartStatus: vi.fn(async (_slot: DedicatedSlot) => restartState),
    commitPlannedRestart: vi.fn(async (_slot: DedicatedSlot, attemptId: string) => {
      const attempt = { ...restartState.current!, attemptId, phase: 'restarting' as const }
      restartState = { ...restartState, current: attempt }
      calls.push('restart:commit')
      return attempt
    }),
    abortPlannedRestart: vi.fn(async (_slot: DedicatedSlot, _attemptId?: string) => {
      if (restartState.current) restartState = { ...restartState, current: null, last: { ...restartState.current, phase: 'aborted' } }
      calls.push('restart:abort')
    }),
    selfTestRelease: vi.fn(async (_dir: string) => {}),
    startControlPlaneUpdate: vi.fn(async () => { calls.push('control:start') }),
    controlPlaneUpdateStatus: vi.fn(async () => controlStatus ?? ({
      phase: 'completed' as const, previousSupervisorPid: 8, previousIngressPid: 9, ingressPid: 19, supervisorPid: 18,
      activatedAt: new Date().toISOString(), readyAt: new Date().toISOString(),
    })),
    recoverControlPlane: vi.fn(async () => ({ phase: 'recovered' as const })),
    writeRuntimeFence: vi.fn(async (ownership?: NonNullable<HostRestartAttempt['deployment']>) => { calls.push(ownership ? 'fence:set' : 'fence:clear') }),
    writeCandidateState: vi.fn(async (state?: { deploymentId: string; phase: 'paused' | 'candidate' | 'admission' }) => { calls.push(state ? `candidate:${state.phase}` : 'candidate:clear') }),
    admissionSnapshot: vi.fn(async () => ({ pending: 0, leased: 0, oldestAgeMs: 0 })),
    persistRuntimeReady: vi.fn(async (_receipt, evidence) => { calls.push(evidence.publicRoute ? 'runtime:public' : 'runtime:private') }),
    clearRuntimeReady: vi.fn(async () => { calls.push('runtime:clear') }),
    activateSlot: vi.fn(async (slot: DedicatedSlot, dir: string) => { calls.push('activate:' + slot + ':' + dir.split('/').at(-1)) }),
    startSlot: vi.fn(async (slot: DedicatedSlot) => { calls.push('start:' + slot) }),
    stopSlot: vi.fn(async (slot: DedicatedSlot) => { calls.push('stop:' + slot) }),
    verifySlot: vi.fn(async (slot: DedicatedSlot, _expected: { bundleSha256: string; deployment?: NonNullable<HostRestartAttempt['deployment']>; requireContinuation?: boolean }) => { calls.push('verify:' + slot); return { pid: slot === 'green' ? 42 : 7, processReadyAt: new Date().toISOString(), runtimeReadyAt: new Date().toISOString(), ...(includeContinuation ? { continuation: { attemptId: 'restart-attempt-0001', participants: 0, completed: 0, failed: 0 } } : {}) } }),
    switchRoute: vi.fn(async (next: DedicatedRouteState) => { calls.push('route:' + next.activeSlot); current = next }),
  }
  return {
    adapter, calls, route: () => current,
    setRestart: (attempt: HostRestartAttempt) => { restartState = { ...restartState, current: attempt } },
    setRequestedRestartPhase: (phase: HostRestartAttempt['phase']) => { requestedRestartPhase = phase },
    persistOriginResult: () => { originPersisted = true },
    includeContinuation: () => { includeContinuation = true },
    setControlStatus: (status: NonNullable<typeof controlStatus>) => { controlStatus = status },
    failNextVerification: () => adapter.verifySlot.mockImplementationOnce(async () => { throw new Error('unhealthy') }),
  }
}

function request(next: Awaited<ReturnType<typeof release>>, patch: Partial<DedicatedDeployRequest> = {}): DedicatedDeployRequest {
  return {
    schemaVersion: 1, action: 'deploy', operationId: 'operation-deploy-0001', deploymentId: 'deployment-0001',
    topology: 'dedicated-slots', unitId: 'local', requestedAt: new Date().toISOString(), expectedRouteGeneration: 1,
    fencingToken: 'fencing-token-0001', sourceReleaseDigest: patch.sourceReleaseDigest ?? '', targetReleaseDigest: next.release,
    predecessorReleaseId: 'old', candidateSlot: 'green', releaseId: 'next', stagedReleaseDir: next.dir, bundleSha256: next.bundle,
    ...patch,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTreeRemovable(root)
    await rm(root, { recursive: true, force: true })
  }))
})

describe('Dedicated Deploy Supervisor protocol', () => {
  it('rejects stale generation before persisting or stopping a slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-stale-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    await expect(supervisor.accept(request(next, { sourceReleaseDigest: old.release, expectedRouteGeneration: 2 }))).rejects.toThrow('stale route')
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()
  })

  it('returns the same receipt for an idempotent operation and rejects a conflicting duplicate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-idempotent-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter); const input = request(next, { sourceReleaseDigest: old.release })
    const first = await supervisor.accept(input); const second = await supervisor.accept(input)
    expect(second.deploymentId).toBe(first.deploymentId)
    await expect(supervisor.accept({ ...input, bundleSha256: digest('different') })).rejects.toThrow('conflicts')
  })

  it('publishes only an exact verified submission and accepts systemd asset names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-publish-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const next = await submission(root, 'operation-deploy-0001', 'next')
    const manifestPath = join(next.dir, 'manifest.json')
    const bundle = await readFile(join(next.dir, 'agent-runlab-runtime.cjs'))
    const unitName = 'agent-runlab-dedicated-unit@.service'
    const unit = '[Service]\nType=exec\n'
    const manifest = JSON.stringify({ assets: ['agent-runlab-runtime.cjs', unitName] })
    await writeFile(manifestPath, manifest)
    await writeFile(join(next.dir, unitName), unit)
    const notes = await readFile(join(next.dir, 'RELEASE_NOTES.md'))
    const sums = `${digest(bundle)}  agent-runlab-runtime.cjs\n${digest(unit)}  ${unitName}\n${digest(manifest)}  manifest.json\n${digest(notes)}  RELEASE_NOTES.md\n`
    await writeFile(join(next.dir, 'SHA256SUMS'), sums)
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request({ ...next, release: digest(sums) }, { sourceReleaseDigest: old.release }))
    expect(staged.releaseDir).toBe(join(root, 'releases', 'next'))
    expect(await readFile(join(staged.releaseDir, unitName), 'utf8')).toBe(unit)
  })

  it('rejects extra submission files before immutable publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-extra-file-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    await writeFile(join(next.dir, 'unexpected'), 'not in manifest')
    const supervisor = new DedicatedDeploySupervisor(root, harness().adapter)
    await expect(supervisor.accept(request(next, { sourceReleaseDigest: old.release }))).rejects.toThrow('file set')
  })

  it('rebuilds a missing operation index from the authoritative receipt after a crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-index-recovery-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const input = request(next, { sourceReleaseDigest: old.release })
    const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const first = await supervisor.accept(input)
    await rm(join(root, 'operation-index.json'))
    const recovered = await new DedicatedDeploySupervisor(root, h.adapter).accept(input)
    expect(recovered).toMatchObject({ deploymentId: first.deploymentId, receiptRevision: first.receiptRevision })
    expect(JSON.parse(await readFile(join(root, 'operation-index.json'), 'utf8'))).toMatchObject({ [input.operationId]: input.deploymentId })
  })

  it('recovers schema-v1 receipts containing the original completed continuation outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-completed-recovery-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const input = request(next, { sourceReleaseDigest: old.release })
    const first = await new DedicatedDeploySupervisor(root, h.adapter).accept(input)
    const receiptPath = join(root, 'receipts', `${first.deploymentId}.json`)
    const durable = JSON.parse(await readFile(receiptPath, 'utf8'))
    durable.continuation = {
      attemptId: 'restart-attempt-0001',
      participants: 1,
      completed: 1,
      failed: 0,
      sessions: [{ sessionId: 'session-0001', cursor: 7, checkpointKind: 'before_llm', resumeAction: 'continue_turn', outcome: 'completed' }],
    }
    await writeFile(receiptPath, JSON.stringify(durable))

    await expect(new DedicatedDeploySupervisor(root, h.adapter).accept(input)).resolves.toMatchObject({
      deploymentId: first.deploymentId,
      continuation: { participants: 1, completed: 1, failed: 0 },
    })
  })

  it('aborts safely before reservation and persists a monotonic terminal receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-abort-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const abort: DedicatedDeployRequest = { ...request(next, { sourceReleaseDigest: old.release }), action: 'abort', operationId: 'operation-abort-0001', deploymentId: staged.deploymentId, targetDeploymentId: staged.deploymentId, releaseId: undefined, stagedReleaseDir: undefined, bundleSha256: undefined }
    const receipt = await supervisor.accept(abort)
    expect(receipt).toMatchObject({ phase: 'aborted', action: 'abort' })
    expect(receipt.receiptRevision).toBeGreaterThan(staged.receiptRevision)
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()
  })

  it('safely aborts a waiting boundary by cancelling its planned restart and restoring control', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-boundary-abort-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    h.setRequestedRestartPhase('draining')
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting.phase).toBe('waiting_for_boundary')

    const abort: DedicatedDeployRequest = {
      ...request(next, { sourceReleaseDigest: old.release }), action: 'abort', operationId: 'operation-abort-boundary-0001',
      deploymentId: staged.deploymentId, targetDeploymentId: staged.deploymentId, releaseId: undefined, stagedReleaseDir: undefined, bundleSha256: undefined,
    }
    const receipt = await supervisor.accept(abort)
    expect(receipt).toMatchObject({ phase: 'rolled_back', action: 'abort', rollback: { mode: 'cancel', outcome: 'completed' } })
    expect(h.calls).toContain('restart:abort')
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()
    expect(h.route()).toMatchObject({ generation: 1, activeSlot: 'blue' })
  })

  it('hands planned continuation ownership to the candidate before route commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-ok-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed).toMatchObject({ phase: 'completed', previousSlot: 'blue', candidateSlot: 'green', activatedPid: 42, routeGeneration: 2 })
    expect(h.calls).toEqual(['control:start', 'restart:request', 'candidate:paused', 'runtime:clear', 'fence:set', 'restart:commit', 'stop:blue', 'activate:green:next', 'start:green', 'candidate:candidate', 'verify:green', 'candidate:admission', 'runtime:private', 'route:green', 'runtime:public', 'candidate:clear'])
    expect(h.adapter.persistRuntimeReady).toHaveBeenLastCalledWith(expect.objectContaining({ deploymentId: staged.deploymentId }), expect.objectContaining({ publicRoute: true, routeGeneration: 2 }))
    expect(h.adapter.verifySlot).toHaveBeenCalledWith('green', {
      bundleSha256: next.bundle,
      deployment: expect.objectContaining({
        deploymentId: staged.deploymentId,
        targetReleaseDigest: next.release,
        expectedRouteGeneration: 1,
        fencingToken: 'fencing-token-0001',
      }),
    })
    expect(h.route()).toMatchObject({ generation: 2, activeSlot: 'green' })
  })

  it('gracefully restarts onto the other slot without staging or updating the control plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-restart-')); roots.push(root)
    const old = await release(root, 'old', 'old')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const input: DedicatedDeployRequest = {
      schemaVersion: 1, action: 'restart', operationId: 'operation-restart-0001', deploymentId: 'deployment-restart-0001',
      topology: 'dedicated-slots', unitId: 'local', requestedAt: new Date().toISOString(), expectedRouteGeneration: 1,
      fencingToken: 'fencing-token-restart-0001', sourceReleaseDigest: old.release, targetReleaseDigest: old.release,
      predecessorReleaseId: 'old', candidateSlot: 'green',
    }
    const accepted = await supervisor.accept(input)
    expect(accepted).toMatchObject({ action: 'restart', phase: 'control_ready', releaseId: 'old', releaseDigest: old.release })
    const completed = await supervisor.reconcile(accepted.deploymentId)
    expect(completed).toMatchObject({ action: 'restart', phase: 'completed', routeGeneration: 2, previousSlot: 'blue', candidateSlot: 'green' })
    expect(h.adapter.startControlPlaneUpdate).not.toHaveBeenCalled()
    expect(h.calls).not.toContain('control:start')
    expect(h.calls).toContain('activate:green:old')
  })

  it('clears the admission blocker and records reconciled handoff operations before completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-admission-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness()
    h.adapter.admissionSnapshot
      .mockResolvedValueOnce({ pending: 1, leased: 0, oldestAgeMs: 25 })
      .mockResolvedValueOnce({ pending: 0, leased: 0, oldestAgeMs: 0 })
    const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting).toMatchObject({ phase: 'verifying', admission: { pending: 1, reconciled: 0 }, blockers: ['admission_queue'] })
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed).toMatchObject({ phase: 'completed', admission: { pending: 0, reconciled: 1, oldestAgeMs: 0 }, blockers: [] })
  })

  it('keeps the deployment non-terminal until the control updater proves both new processes ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-control-wait-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.setControlStatus({ phase: 'pending' })
    const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting).toMatchObject({ phase: 'control_updating' })
    expect(waiting.routeGeneration).toBeUndefined()
    expect(h.route()).toMatchObject({ generation: 1, activeSlot: 'blue' })
    expect(h.adapter.requestPlannedRestart).not.toHaveBeenCalled()
    expect(h.adapter.startSlot).not.toHaveBeenCalled()

    const activatedAt = new Date().toISOString(); const readyAt = new Date().toISOString()
    h.setControlStatus({ phase: 'completed', previousSupervisorPid: 8, previousIngressPid: 9, ingressPid: 19, supervisorPid: 18, activatedAt, readyAt })
    const completed = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(completed).toMatchObject({
      phase: 'completed',
      controlPlane: { previousSupervisorPid: 8, previousIngressPid: 9, ingressPid: 19, supervisorPid: 18, activatedAt, readyAt },
    })
    expect(h.adapter.startControlPlaneUpdate).toHaveBeenCalledTimes(2)
  })

  it('restores the control plane before rolling Runtime back after target control failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-control-rollback-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.includeContinuation(); h.setControlStatus({ phase: 'rolled_back', error: 'target control unhealthy' })
    const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const rolledBack = await supervisor.reconcile(staged.deploymentId)
    expect(rolledBack.phase).toBe('rolled_back')
    expect(h.adapter.recoverControlPlane).toHaveBeenCalled()
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()
    expect(h.adapter.verifySlot).toHaveBeenCalledWith('blue', expect.anything())
    expect(h.route()).toMatchObject({ activeSlot: 'blue' })
  })

  it('does not drain or stop the origin Session Host until its deploy Tool result is durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-origin-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, {
      sourceReleaseDigest: old.release,
      origin: { sessionId: 'session-origin-0001', callId: 'call-deploy-0001' },
    }))
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting).toMatchObject({ phase: 'waiting_for_origin_result', blockers: ['origin_tool_result'] })
    expect(h.adapter.requestPlannedRestart).not.toHaveBeenCalled()
    expect(h.adapter.stopSlot).not.toHaveBeenCalled()

    h.persistOriginResult()
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed).toMatchObject({ phase: 'completed', origin: staged.origin })
    expect(completed.originResultPersistedAt).toEqual(expect.any(String))
    expect(h.adapter.originToolResultPersisted).toHaveBeenCalledWith('blue', staged.origin)
  })

  it('restores the predecessor and resumes persisted rollback after Supervisor restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-rollback-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.failNextVerification(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const receipt = await supervisor.reconcile(staged.deploymentId)
    expect(receipt.phase).toBe('rolled_back')
    const persisted = JSON.parse(await readFile(join(root, 'receipts', staged.deploymentId + '.json'), 'utf8'))
    await writeFile(join(root, 'receipts', staged.deploymentId + '.json'), JSON.stringify({ ...persisted, phase: 'rolling_back', receiptRevision: persisted.receiptRevision + 1, rollback: { predecessorReleaseId: 'old', outcome: 'pending' } }))
    const resumed = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(resumed.phase).toBe('rolled_back')
  })

  it('runs an operator rollback through a new planned handoff deployment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-operator-rollback-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed.phase).toBe('completed')

    const rollbackRequest: DedicatedDeployRequest = {
      schemaVersion: 1, action: 'rollback', operationId: 'operation-rollback-0001', deploymentId: 'deployment-rollback-0001',
      topology: 'dedicated-slots', unitId: 'local', requestedAt: new Date().toISOString(), expectedRouteGeneration: 2,
      fencingToken: 'fencing-token-rollback-0001', sourceReleaseDigest: next.release, targetReleaseDigest: old.release,
      predecessorReleaseId: 'old', candidateSlot: 'blue', targetDeploymentId: completed.deploymentId,
    }
    const rollback = await supervisor.accept(rollbackRequest)
    expect(rollback).toMatchObject({
      deploymentId: rollbackRequest.deploymentId, targetDeploymentId: completed.deploymentId, action: 'rollback',
      phase: 'staged', previousSlot: 'green', candidateSlot: 'blue', releaseId: 'old', predecessorReleaseId: 'next',
    })
    h.calls.splice(0)
    const rolledBack = await supervisor.reconcile(rollback.deploymentId)
    expect(rolledBack).toMatchObject({ phase: 'completed', action: 'rollback', routeGeneration: 3, rollback: { outcome: 'completed', pid: 7 } })
    expect(h.calls).toEqual([
      'control:start', 'restart:request', 'candidate:paused', 'runtime:clear', 'fence:set', 'restart:commit', 'stop:green',
      'activate:blue:old', 'start:blue', 'candidate:candidate', 'verify:blue', 'candidate:admission',
      'runtime:private', 'route:blue', 'runtime:public', 'candidate:clear',
    ])
  })

  it('resumes automatic rollback at a persisted stage without repeating predecessor activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-staged-rollback-resume-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.failNextVerification(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const rolledBack = await supervisor.reconcile(staged.deploymentId)
    expect(rolledBack.phase).toBe('rolled_back')
    const persisted = JSON.parse(await readFile(join(root, 'receipts', staged.deploymentId + '.json'), 'utf8'))
    await writeFile(join(root, 'receipts', staged.deploymentId + '.json'), JSON.stringify({
      ...persisted, phase: 'rolling_back', receiptRevision: persisted.receiptRevision + 1,
      rollback: { ...persisted.rollback, outcome: 'pending', stage: 'verifying' },
    }))
    h.calls.splice(0)
    const resumed = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(resumed.phase).toBe('rolled_back')
    expect(h.calls).not.toContain('activate:blue:old')
    expect(h.calls).not.toContain('start:blue')
    expect(h.calls).toContain('verify:blue')
  })

  it('replays a persisted predecessor-activation boundary idempotently after Supervisor crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-protocol-rollback-activation-boundary-')); roots.push(root)
    const old = await release(root, 'old', 'old'); const next = await submission(root, 'operation-deploy-0001', 'next')
    const h = harness(); h.failNextVerification(); const supervisor = new DedicatedDeploySupervisor(root, h.adapter)
    const staged = await supervisor.accept(request(next, { sourceReleaseDigest: old.release }))
    const rolledBack = await supervisor.reconcile(staged.deploymentId)
    expect(rolledBack.phase).toBe('rolled_back')
    const persisted = JSON.parse(await readFile(join(root, 'receipts', staged.deploymentId + '.json'), 'utf8'))
    await writeFile(join(root, 'receipts', staged.deploymentId + '.json'), JSON.stringify({
      ...persisted, phase: 'rolling_back', receiptRevision: persisted.receiptRevision + 1,
      rollback: { ...persisted.rollback, outcome: 'pending', stage: 'activating_predecessor' },
    }))
    h.calls.splice(0)
    const resumed = await new DedicatedDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(resumed.phase).toBe('rolled_back')
    expect(h.calls).toEqual(expect.arrayContaining(['candidate:paused', 'activate:blue:old', 'start:blue', 'candidate:candidate', 'verify:blue']))
  })
})

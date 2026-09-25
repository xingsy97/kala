import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type { HostRestartAttempt, HostRestartStatus } from '@agent-kernel/shared'

import { readJsonFile, writeJsonFile } from './atomic-json-file.js'
import type { UnitQuiescence } from './quiescence.js'
import {
  deploymentRequestDigest,
  parseDeploymentReceipt,
  parseDedicatedDeployRequest,
  promoteStagedRelease,
  redactedDeploymentError,
  verifyImmutableRelease,
  type DeploymentPhase,
  type DeploymentReceipt,
  type DedicatedDeployRequest,
} from './dedicated-deploy-protocol.js'
import { advanceDedicatedRoute, otherSlot, type DedicatedRouteState, type DedicatedSlot } from './dedicated-slot-state.js'

export type { DeploymentPhase, DeploymentReceipt } from './dedicated-deploy-protocol.js'

export type DeploySupervisorAdapter = {
  routeState(): Promise<DedicatedRouteState>
  inspectQuiescence(slot: DedicatedSlot): Promise<UnitQuiescence>
  originToolResultPersisted(slot: DedicatedSlot, origin: { sessionId: string; callId: string }): Promise<boolean>
  requestPlannedRestart(slot: DedicatedSlot, ownership: NonNullable<HostRestartAttempt['deployment']>): Promise<HostRestartAttempt>
  restartStatus(slot: DedicatedSlot): Promise<HostRestartStatus>
  commitPlannedRestart(slot: DedicatedSlot, attemptId: string): Promise<HostRestartAttempt>
  abortPlannedRestart(slot: DedicatedSlot, attemptId?: string): Promise<void>
  selfTestRelease(releaseDir: string): Promise<void>
  startControlPlaneUpdate(receipt: DeploymentReceipt): Promise<void>
  controlPlaneUpdateStatus(receipt: DeploymentReceipt): Promise<{
    phase: 'pending' | 'completed' | 'rolled_back' | 'rollback_failed'
    previousSupervisorPid?: number
    previousIngressPid?: number
    ingressPid?: number
    supervisorPid?: number
    activatedAt?: string
    readyAt?: string
    error?: string
  }>
  recoverControlPlane(receipt: DeploymentReceipt): Promise<{ phase: 'pending' | 'recovered' | 'failed'; error?: string }>
  writeRuntimeFence(ownership?: NonNullable<HostRestartAttempt['deployment']>): Promise<void>
  writeCandidateState(state?: { deploymentId: string; expectedRouteGeneration: number; phase: 'paused' | 'candidate' | 'admission'; origin?: string }): Promise<void>
  admissionSnapshot(): Promise<{ pending: number; leased: number; oldestAgeMs: number }>
  persistRuntimeReady(receipt: DeploymentReceipt, evidence: {
    pid: number
    processReadyAt: string
    runtimeReadyAt: string
    publicRoute: boolean
    routeGeneration?: number
  }): Promise<void>
  clearRuntimeReady(): Promise<void>
  activateSlot(slot: DedicatedSlot, releaseDir: string): Promise<void>
  startSlot(slot: DedicatedSlot): Promise<void>
  stopSlot(slot: DedicatedSlot): Promise<void>
  verifySlot(slot: DedicatedSlot, expected: {
    bundleSha256: string
    deployment?: NonNullable<HostRestartAttempt['deployment']>
    requireContinuation?: boolean
  }): Promise<{
    pid: number
    processReadyAt: string
    runtimeReadyAt: string
    continuation?: NonNullable<DeploymentReceipt['continuation']>
  }>
  switchRoute(state: DedicatedRouteState): Promise<void>
}

const abortablePhases = new Set<DeploymentPhase>([
  'staged', 'validating', 'waiting_for_origin_result',
  'control_updating', 'control_ready', 'waiting_for_boundary', 'reserved',
])
const abortPhasesRequiringRecovery = new Set<DeploymentPhase>([
  'control_updating', 'control_ready', 'waiting_for_boundary', 'reserved',
])
const terminalPhases = new Set<DeploymentPhase>(['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed'])
const phaseTransitions: Readonly<Record<DeploymentPhase, ReadonlySet<DeploymentPhase>>> = {
  staged: new Set(['validating', 'abort_requested', 'rolling_back']),
  validating: new Set(['waiting_for_origin_result', 'control_updating', 'abort_requested', 'rolling_back']),
  control_updating: new Set(['control_ready', 'rolling_back']),
  control_ready: new Set(['waiting_for_boundary', 'rolling_back']),
  waiting_for_origin_result: new Set(['control_updating', 'abort_requested', 'rolling_back']),
  waiting_for_boundary: new Set(['reserved', 'abort_requested', 'rolling_back']),
  reserved: new Set(['handed_off', 'rolling_back']),
  handed_off: new Set(['activating', 'rolling_back']),
  activating: new Set(['verifying', 'rolling_back']),
  verifying: new Set(['route_committing', 'rolling_back']),
  route_committing: new Set(['completed', 'rolling_back']),
  abort_requested: new Set(['aborted']),
  rolling_back: new Set(['rolled_back', 'rollback_failed', 'failed']),
  completed: new Set(),
  aborted: new Set(),
  rolled_back: new Set(),
  rollback_failed: new Set(),
  failed: new Set(),
}

export class DedicatedDeploySupervisor {
  private mutation = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly adapter: DeploySupervisorAdapter,
  ) {}

  async accept(raw: unknown): Promise<DeploymentReceipt> {
    return await this.serialize(async () => {
      const request = parseDedicatedDeployRequest(raw)
      const digest = deploymentRequestDigest(request)
      const existing = await this.findByOperation(request.operationId)
      if (existing) {
        if (existing.operationRequestDigests[request.operationId] !== digest) throw new Error('operationId conflicts with an existing deployment request')
        return existing
      }
      if (request.action === 'deploy') return await this.acceptDeploy(request, digest)
      if (request.action === 'restart') return await this.acceptRestart(request, digest)
      if (request.action === 'abort') return await this.acceptAbort(request, digest)
      return await this.acceptRollback(request, digest)
    })
  }

  private async acceptRestart(request: DedicatedDeployRequest, requestDigest: string): Promise<DeploymentReceipt> {
    await this.assertDeploymentIdAvailable(request.deploymentId)
    await this.assertNoActiveDeployment()
    const route = await this.adapter.routeState()
    assertRequestRoute(request, route)
    const releaseId = route.slots[route.activeSlot].releaseId
    if (request.predecessorReleaseId !== releaseId || request.sourceReleaseDigest !== request.targetReleaseDigest) throw new Error('restart release identity mismatch')
    const releaseDir = resolve(this.root, 'releases', releaseId)
    const bundleSha256 = sha256(await readFile(join(releaseDir, 'kala-runtime.cjs')))
    await verifyImmutableRelease({ deployRoot: this.root, releaseDir, releaseId, releaseDigest: request.targetReleaseDigest, bundleSha256 })
    const now = new Date().toISOString()
    const receipt: DeploymentReceipt = {
      schemaVersion: 1, receiptRevision: 1, deploymentId: request.deploymentId, operationId: request.operationId,
      operationIds: [request.operationId], requestDigest, operationRequestDigests: { [request.operationId]: requestDigest },
      action: 'restart', topology: 'dedicated-slots', unitId: 'local', phase: 'control_ready',
      releaseId, releaseDir, bundleSha256, releaseDigest: request.targetReleaseDigest, sourceReleaseDigest: request.sourceReleaseDigest,
      requestedAt: request.requestedAt, updatedAt: now, expectedRouteGeneration: request.expectedRouteGeneration,
      observedRouteGeneration: route.generation, fencingToken: request.fencingToken, predecessorReleaseId: releaseId,
      previousRelease: releaseDir, previousSlot: route.activeSlot, candidateSlot: request.candidateSlot,
    }
    await this.persist(receipt)
    return receipt
  }

  private async acceptDeploy(request: DedicatedDeployRequest, requestDigest: string): Promise<DeploymentReceipt> {
    await this.assertDeploymentIdAvailable(request.deploymentId)
    await this.assertNoActiveDeployment()
    const route = await this.adapter.routeState()
    assertRequestRoute(request, route)
    const releaseDir = await promoteStagedRelease({
      deployRoot: this.root,
      stagedReleaseDir: request.stagedReleaseDir!,
      operationId: request.operationId,
      releaseId: request.releaseId!,
      releaseDigest: request.targetReleaseDigest,
      bundleSha256: request.bundleSha256!,
    })
    const now = new Date().toISOString()
    const receipt: DeploymentReceipt = {
      schemaVersion: 1, receiptRevision: 1, deploymentId: request.deploymentId,
      operationId: request.operationId, operationIds: [request.operationId], requestDigest,
      operationRequestDigests: { [request.operationId]: requestDigest },
      action: 'deploy', topology: 'dedicated-slots', unitId: 'local', phase: 'staged',
      releaseId: request.releaseId!, releaseDir, bundleSha256: request.bundleSha256!,
      releaseDigest: request.targetReleaseDigest, sourceReleaseDigest: request.sourceReleaseDigest,
      requestedAt: request.requestedAt, updatedAt: now,
      expectedRouteGeneration: request.expectedRouteGeneration, observedRouteGeneration: route.generation,
      fencingToken: request.fencingToken, predecessorReleaseId: request.predecessorReleaseId,
      previousRelease: resolve(this.root, 'releases', request.predecessorReleaseId),
      previousSlot: route.activeSlot, candidateSlot: request.candidateSlot,
      ...(request.origin ? { origin: request.origin } : {}),
    }
    await this.persist(receipt)
    return receipt
  }

  private async acceptAbort(request: DedicatedDeployRequest, requestDigest: string): Promise<DeploymentReceipt> {
    let receipt = await this.requiredReceipt(request.targetDeploymentId!)
    if (!abortablePhases.has(receipt.phase)) throw new Error('deployment cannot be aborted from ' + receipt.phase)
    const route = await this.adapter.routeState()
    if (request.deploymentId !== receipt.deploymentId
      || request.expectedRouteGeneration !== receipt.expectedRouteGeneration
      || route.generation !== receipt.expectedRouteGeneration
      || route.activeSlot !== receipt.previousSlot
      || request.predecessorReleaseId !== receipt.predecessorReleaseId
      || request.candidateSlot !== receipt.candidateSlot
      || request.sourceReleaseDigest !== receipt.sourceReleaseDigest
      || request.targetReleaseDigest !== receipt.releaseDigest) throw new Error('abort request does not match the fenced deployment')
    const operation = {
      action: 'abort',
      operationId: request.operationId,
      operationIds: [...receipt.operationIds, request.operationId],
      requestDigest,
      operationRequestDigests: { ...receipt.operationRequestDigests, [request.operationId]: requestDigest },
    } as const
    if (abortPhasesRequiringRecovery.has(receipt.phase)) {
      const message = 'deployment aborted by operator before Runtime handoff'
      receipt = await this.transition(receipt, 'rolling_back', {
        ...operation,
        rollback: {
          predecessorReleaseId: receipt.predecessorReleaseId, outcome: 'pending',
          mode: 'cancel', stage: 'preparing',
        },
        error: redactedDeploymentError(message),
      })
      return await this.rollback(receipt, message)
    }
    receipt = await this.transition(receipt, 'abort_requested', operation)
    return await this.transition(receipt, 'aborted')
  }

  private async acceptRollback(request: DedicatedDeployRequest, requestDigest: string): Promise<DeploymentReceipt> {
    await this.assertDeploymentIdAvailable(request.deploymentId)
    await this.assertNoActiveDeployment()
    const receipt = await this.requiredReceipt(request.targetDeploymentId!)
    const route = await this.adapter.routeState()
    if (receipt.phase !== 'completed') throw new Error('rollback target must be a completed deployment')
    if (route.generation !== request.expectedRouteGeneration || route.activeSlot !== receipt.candidateSlot || route.slots[route.activeSlot].releaseId !== receipt.releaseId) throw new Error('stale rollback route generation, active slot, or release')
    if (request.predecessorReleaseId !== receipt.predecessorReleaseId || request.candidateSlot !== otherSlot(route.activeSlot) || request.targetReleaseDigest !== receipt.sourceReleaseDigest || request.sourceReleaseDigest !== receipt.releaseDigest) throw new Error('rollback release identity mismatch')
    const rollbackReleaseId = receipt.predecessorReleaseId
    const rollbackReleaseDir = resolve(this.root, 'releases', rollbackReleaseId)
    const rollbackBundleSha256 = sha256(await readFile(join(rollbackReleaseDir, 'kala-runtime.cjs')))
    await verifyImmutableRelease({
      deployRoot: this.root, releaseDir: rollbackReleaseDir, releaseId: rollbackReleaseId,
      releaseDigest: receipt.sourceReleaseDigest, bundleSha256: rollbackBundleSha256,
    })
    const next: DeploymentReceipt = {
      ...receipt, receiptRevision: 1, deploymentId: request.deploymentId,
      operationId: request.operationId, operationIds: [request.operationId], requestDigest,
      operationRequestDigests: { [request.operationId]: requestDigest }, targetDeploymentId: receipt.deploymentId,
      action: 'rollback', phase: 'staged', requestedAt: request.requestedAt, updatedAt: new Date().toISOString(),
      expectedRouteGeneration: request.expectedRouteGeneration, observedRouteGeneration: route.generation,
      fencingToken: request.fencingToken,
      releaseId: rollbackReleaseId, releaseDir: rollbackReleaseDir, bundleSha256: rollbackBundleSha256,
      releaseDigest: receipt.sourceReleaseDigest, sourceReleaseDigest: receipt.releaseDigest,
      predecessorReleaseId: receipt.releaseId, previousRelease: receipt.releaseDir,
      previousSlot: route.activeSlot, candidateSlot: otherSlot(route.activeSlot),
      rollback: { predecessorReleaseId: rollbackReleaseId, outcome: 'pending' },
      ...(request.origin ? { origin: request.origin } : {}),
    }
    delete next.routeGeneration
    delete next.activatedPid
    delete next.processReadyAt
    delete next.runtimeReadyAt
    delete next.controlPlane
    delete next.plannedRestart
    delete next.quiescence
    delete next.blockers
    delete next.continuation
    delete next.admission
    delete next.health
    delete next.error
    delete next.originResultPersistedAt
    if (!request.origin) delete next.origin
    await this.persist(next)
    return next
  }

  async reconcile(deploymentId: string): Promise<DeploymentReceipt> {
    return await this.serialize(() => this.reconcileUnsafe(deploymentId))
  }

  private async reconcileUnsafe(deploymentId: string): Promise<DeploymentReceipt> {
    let receipt = await this.requiredReceipt(deploymentId)
    if (terminal(receipt.phase)) return receipt
    if (receipt.phase === 'abort_requested') return await this.transition(receipt, 'aborted')
    if (receipt.phase === 'rolling_back') return await this.rollback(receipt, receipt.error?.message ?? 'deployment rollback resumed')
    try {
      if (receipt.phase === 'staged') receipt = await this.transition(receipt, 'validating')
      if (receipt.phase === 'validating') {
        const route = await this.adapter.routeState()
        assertReceiptRoute(receipt, route)
        await this.verifyRelease(receipt)
        const predecessorSums = await readFile(join(receipt.previousRelease!, 'SHA256SUMS'))
        if (sha256(predecessorSums) !== receipt.sourceReleaseDigest) throw new Error('predecessor immutable release changed')
        await this.adapter.selfTestRelease(receipt.releaseDir)
        if (receipt.origin && !receipt.originResultPersistedAt) {
          receipt = await this.transition(receipt, 'waiting_for_origin_result', { blockers: ['origin_tool_result'] })
        } else {
          // Install and daemon-reload the candidate unit templates while the
          // predecessor Runtime still owns the write lease. The updater may
          // restart Stable Ingress and this Supervisor, but it must complete
          // before systemd starts the candidate slot from those templates.
          receipt = await this.transition(receipt, 'control_updating')
        }
      }
      if (receipt.phase === 'waiting_for_origin_result') {
        if (!receipt.origin) throw new Error('origin result barrier is missing origin identity')
        if (!await this.adapter.originToolResultPersisted(receipt.previousSlot!, receipt.origin)) {
          return await this.refresh(receipt, { blockers: ['origin_tool_result'] })
        }
        receipt = await this.transition(receipt, 'control_updating', {
          originResultPersistedAt: new Date().toISOString(),
          blockers: [],
        })
      }
      if (receipt.phase === 'control_updating') {
        await this.adapter.startControlPlaneUpdate(receipt)
        const control = await this.adapter.controlPlaneUpdateStatus(receipt)
        if (control.phase === 'pending') return receipt
        if (control.phase !== 'completed' || !control.previousSupervisorPid || !control.previousIngressPid || !control.ingressPid || !control.supervisorPid || !control.activatedAt || !control.readyAt) {
          throw new Error(control.error ?? 'control-plane update ' + control.phase)
        }
        receipt = await this.transition(receipt, 'control_ready', {
          controlPlane: {
            previousSupervisorPid: control.previousSupervisorPid, previousIngressPid: control.previousIngressPid,
            ingressPid: control.ingressPid, supervisorPid: control.supervisorPid,
            activatedAt: control.activatedAt, readyAt: control.readyAt,
          },
        })
      }
      if (receipt.phase === 'control_ready') {
        const quiescence = await this.adapter.inspectQuiescence(receipt.previousSlot!)
        const attempt = await this.adapter.requestPlannedRestart(receipt.previousSlot!, deploymentOwnership(receipt))
        receipt = await this.transition(receipt, 'waiting_for_boundary', {
          quiescence,
          plannedRestart: { attemptId: attempt.attemptId, participants: attempt.sessions.length, checkpointed: checkpointed(attempt) },
          blockers: restartBlockers(attempt),
        })
      }
      if (receipt.phase === 'waiting_for_boundary') {
        const status = await this.adapter.restartStatus(receipt.previousSlot!)
        const attempt = exactAttempt(status, receipt.plannedRestart!.attemptId)
        if (!attempt) return receipt
        if (attempt.phase === 'aborted' || attempt.phase === 'failed') throw new Error('planned restart ' + attempt.phase)
        if (attempt.phase !== 'checkpoint_reached') return await this.refresh(receipt, {
          plannedRestart: { attemptId: attempt.attemptId, participants: attempt.sessions.length, checkpointed: checkpointed(attempt) },
          blockers: restartBlockers(attempt),
        })
        receipt = await this.transition(receipt, 'reserved', {
          plannedRestart: { attemptId: attempt.attemptId, participants: attempt.sessions.length, checkpointed: checkpointed(attempt) },
          blockers: [],
        })
      }
      if (receipt.phase === 'reserved') {
        await this.adapter.writeCandidateState({
          deploymentId: receipt.deploymentId,
          expectedRouteGeneration: receipt.expectedRouteGeneration,
          phase: 'paused',
        })
        receipt = await this.transition(receipt, 'handed_off')
      }
      if (receipt.phase === 'handed_off') {
        // The previous proof describes the old public runtime. Remove it before
        // that runtime is stopped so an observer can never mistake stale
        // readiness for the candidate's readiness after a crash or restart.
        await this.adapter.clearRuntimeReady()
        await this.adapter.writeRuntimeFence(deploymentOwnership(receipt))
        await this.adapter.commitPlannedRestart(receipt.previousSlot!, receipt.plannedRestart!.attemptId).catch((error) => {
          if (!isConnectionLoss(error)) throw error
          return {} as HostRestartAttempt
        })
        await this.adapter.stopSlot(receipt.previousSlot!)
        receipt = await this.transition(receipt, 'activating')
      }
      if (receipt.phase === 'activating') {
        await this.adapter.activateSlot(receipt.candidateSlot!, receipt.releaseDir)
        await this.adapter.startSlot(receipt.candidateSlot!)
        const route = await this.adapter.routeState()
        await this.adapter.writeCandidateState({
          deploymentId: receipt.deploymentId,
          expectedRouteGeneration: receipt.expectedRouteGeneration,
          phase: 'candidate',
          origin: route.slots[receipt.candidateSlot].origin,
        })
        receipt = await this.transition(receipt, 'verifying')
      }
      if (receipt.phase === 'verifying') {
        await this.verifyRelease(receipt)
        const verified = await this.adapter.verifySlot(receipt.candidateSlot, { bundleSha256: receipt.bundleSha256, deployment: deploymentOwnership(receipt) })
        receipt = await this.refresh(receipt, {
          activatedPid: verified.pid, runtimeReadyAt: verified.runtimeReadyAt, processReadyAt: verified.processReadyAt,
          ...(verified.continuation ? { continuation: verified.continuation } : {}),
        })
        // Candidate Socket.IO routing is enabled first so Executors required by
        // planned continuation can reconnect. Admission delivery is a separate
        // fence and opens only after every frozen participant has completed.
        // This prevents accepted handoff messages from advancing Session JSONL
        // while the RestartCoordinator is still validating checkpoint cursors.
        const candidateRoute = await this.adapter.routeState()
        await this.adapter.writeCandidateState({
          deploymentId: receipt.deploymentId,
          expectedRouteGeneration: receipt.expectedRouteGeneration,
          phase: 'admission',
          origin: candidateRoute.slots[receipt.candidateSlot].origin,
        })
        const admission = await this.adapter.admissionSnapshot()
        const pendingAdmission = admission.pending + admission.leased
        const reconciledAdmission = reconciledAdmissions(receipt, pendingAdmission)
        if (pendingAdmission > 0) return await this.refresh(receipt, { admission: { pending: pendingAdmission, reconciled: reconciledAdmission, oldestAgeMs: admission.oldestAgeMs }, blockers: ['admission_queue'] })
        const route = await this.adapter.routeState()
        if (route.generation !== receipt.expectedRouteGeneration || route.activeSlot !== receipt.previousSlot) throw new Error('route changed before candidate commit')
        await this.adapter.persistRuntimeReady(receipt, { ...verified, publicRoute: false })
        receipt = await this.transition(receipt, 'route_committing', {
          admission: { pending: 0, reconciled: reconciledAdmission, oldestAgeMs: 0 },
          blockers: [],
          health: { capabilities: true, digest: true, publicRoute: false },
        })
      }
      if (receipt.phase === 'route_committing') {
        const route = await this.adapter.routeState()
        if (route.generation === receipt.expectedRouteGeneration) await this.adapter.switchRoute(advanceDedicatedRoute(route, { slot: receipt.candidateSlot, releaseId: receipt.releaseId }))
        else if (route.generation !== receipt.expectedRouteGeneration + 1 || route.activeSlot !== receipt.candidateSlot || route.slots[receipt.candidateSlot].releaseId !== receipt.releaseId) throw new Error('route commit fence mismatch')
        const committed = await this.adapter.routeState()
        await this.adapter.persistRuntimeReady(receipt, {
          pid: receipt.activatedPid!,
          processReadyAt: receipt.processReadyAt!,
          runtimeReadyAt: receipt.runtimeReadyAt!,
          publicRoute: true,
          routeGeneration: committed.generation,
        })
        await this.adapter.writeCandidateState(undefined)
        return await this.transition(receipt, 'completed', {
          routeGeneration: committed.generation,
          observedRouteGeneration: committed.generation,
          health: { capabilities: true, digest: true, publicRoute: true },
          ...(receipt.action === 'rollback' ? { rollback: { predecessorReleaseId: receipt.rollback!.predecessorReleaseId, outcome: 'completed' as const, pid: receipt.activatedPid } } : {}),
        })
      }
      return receipt
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (receipt.previousRelease) {
        const cancel = ['staged', 'validating', 'control_updating', 'control_ready', 'waiting_for_origin_result', 'waiting_for_boundary', 'reserved'].includes(receipt.phase)
        return await this.rollback(await this.transition(receipt, 'rolling_back', {
          rollback: { predecessorReleaseId: receipt.predecessorReleaseId, outcome: 'pending', mode: cancel ? 'cancel' : 'replace', stage: 'preparing' },
          error: redactedDeploymentError(message),
        }), message)
      }
      return await this.transition(receipt, 'failed', { error: redactedDeploymentError(message) })
    }
  }

  private async rollback(receipt: DeploymentReceipt, message: string): Promise<DeploymentReceipt> {
    const previousRelease = receipt.previousRelease
    const previousSlot = receipt.previousSlot
    if (!previousRelease || !previousSlot) return await this.transition(receipt, 'failed', { error: redactedDeploymentError(`${message}; rollback predecessor missing`) })
    try {
      // Control installation precedes Runtime handoff, so every rollback must
      // first prove that the predecessor control plane is live. The adapter is
      // idempotent when no update started and resumes a persisted updater
      // rollback after either process crashes.
      const controlRecovery = await this.adapter.recoverControlPlane(receipt)
      if (controlRecovery.phase === 'pending') return receipt
      if (controlRecovery.phase === 'failed') throw new Error(controlRecovery.error ?? 'control-plane rollback failed')
      if (receipt.rollback?.mode === 'cancel') return await this.cancelBeforeHandoff(receipt, message, previousRelease, previousSlot)
      const routeAtRecovery = await this.adapter.routeState()
      const candidateContinued = Boolean(receipt.continuation) || await this.candidateContinuationCompleted(receipt)
      const routeAlreadyCommitted = routeAtRecovery.generation === receipt.expectedRouteGeneration + 1
        && routeAtRecovery.activeSlot === receipt.candidateSlot
        && routeAtRecovery.slots[routeAtRecovery.activeSlot].releaseId === receipt.releaseId
      if (routeAlreadyCommitted && !candidateContinued) throw new Error('route committed but candidate continuation ownership cannot be proven')
      const deployment = receipt.rollback?.deployment ?? (candidateContinued
        ? await automaticRollbackOwnership(receipt, routeAtRecovery)
        : deploymentOwnership(receipt))
      if (!receipt.rollback?.deployment) receipt = await this.refresh(receipt, {
        ...(candidateContinued && !receipt.continuation ? { continuation: { participants: 0, completed: 0, failed: 0 } } : {}),
        rollback: { ...receipt.rollback!, deployment },
      })
      const stage = receipt.rollback?.stage ?? 'preparing'
      if (stage === 'preparing') {
        const liveAttempt = await this.livePredecessorAttempt(receipt, previousSlot)
        if (liveAttempt) {
          await this.adapter.abortPlannedRestart(previousSlot, receipt.plannedRestart!.attemptId)
          receipt = await this.refresh(receipt, { rollback: { ...receipt.rollback!, stage: 'verifying_live' } })
        } else if (candidateContinued) {
          const attempt = await this.adapter.requestPlannedRestart(receipt.candidateSlot, deployment)
          receipt = await this.refresh(receipt, {
            plannedRestart: { attemptId: attempt.attemptId, participants: attempt.sessions.length, checkpointed: checkpointed(attempt) },
            blockers: restartBlockers(attempt),
            rollback: { ...receipt.rollback!, stage: 'waiting_for_boundary' },
          })
        } else {
          receipt = await this.refresh(receipt, { rollback: { ...receipt.rollback!, stage: 'activating_predecessor' } })
        }
      }
      if (receipt.rollback!.stage === 'activating_predecessor') {
        receipt = await this.activateRollbackPredecessor(receipt, deployment, previousSlot, previousRelease)
      }
      if (receipt.rollback!.stage === 'waiting_for_boundary') {
        const status = await this.adapter.restartStatus(receipt.candidateSlot)
        const attempt = exactAttempt(status, receipt.plannedRestart!.attemptId)
        if (!attempt) return receipt
        if (attempt.phase === 'aborted' || attempt.phase === 'failed') throw new Error('rollback planned restart ' + attempt.phase)
        if (attempt.phase !== 'checkpoint_reached') return await this.refresh(receipt, {
          plannedRestart: { attemptId: attempt.attemptId, participants: attempt.sessions.length, checkpointed: checkpointed(attempt) },
          blockers: restartBlockers(attempt),
        })
        await this.adapter.writeCandidateState({ deploymentId: deployment.deploymentId, expectedRouteGeneration: deployment.expectedRouteGeneration, phase: 'paused' })
        receipt = await this.refresh(receipt, { blockers: [], rollback: { ...receipt.rollback!, stage: 'handed_off' } })
      }
      if (receipt.rollback!.stage === 'handed_off') {
        await this.adapter.clearRuntimeReady().catch(() => undefined)
        await this.adapter.writeRuntimeFence(deployment)
        await this.adapter.commitPlannedRestart(receipt.candidateSlot, receipt.plannedRestart!.attemptId).catch((error) => {
          if (!isConnectionLoss(error)) throw error
          return {} as HostRestartAttempt
        })
        await this.adapter.stopSlot(receipt.candidateSlot).catch(() => undefined)
        await this.adapter.activateSlot(previousSlot, previousRelease)
        await this.adapter.startSlot(previousSlot)
        receipt = await this.refresh(receipt, { rollback: { ...receipt.rollback!, stage: 'activating' } })
      }
      if (receipt.rollback!.stage === 'verifying_live') {
        const verified = await this.adapter.verifySlot(previousSlot, {
          bundleSha256: sha256(await readFile(join(previousRelease, 'kala-runtime.cjs'))),
        })
        const recoveryReceipt = await rollbackRuntimeReceipt(receipt, previousRelease, previousSlot, deployment)
        const route = await this.adapter.routeState()
        await this.adapter.persistRuntimeReady(recoveryReceipt, {
          ...verified, publicRoute: true, routeGeneration: route.generation,
        })
        await this.adapter.writeCandidateState(undefined)
        await this.adapter.writeRuntimeFence(undefined)
        return await this.transition(receipt, 'rolled_back', {
          routeGeneration: route.generation, observedRouteGeneration: route.generation,
          rollback: { ...receipt.rollback!, outcome: 'completed', pid: verified.pid },
          error: redactedDeploymentError(message),
        })
      }
      const routeAfterStart = await this.adapter.routeState()
      if (receipt.rollback!.stage === 'activating') {
        await this.adapter.writeCandidateState({
          deploymentId: deployment.deploymentId, expectedRouteGeneration: deployment.expectedRouteGeneration, phase: 'candidate',
          origin: routeAfterStart.slots[previousSlot].origin,
        })
        receipt = await this.refresh(receipt, { rollback: { ...receipt.rollback!, stage: 'verifying' } })
      }
      if (receipt.rollback!.stage === 'verifying') {
        const verified = await this.adapter.verifySlot(previousSlot, {
          bundleSha256: sha256(await readFile(join(previousRelease, 'kala-runtime.cjs'))),
          deployment, requireContinuation: true,
        })
        await this.adapter.writeCandidateState({
          deploymentId: deployment.deploymentId, expectedRouteGeneration: deployment.expectedRouteGeneration, phase: 'admission',
          origin: routeAfterStart.slots[previousSlot].origin,
        })
        receipt = await this.refresh(receipt, {
          activatedPid: verified.pid, processReadyAt: verified.processReadyAt, runtimeReadyAt: verified.runtimeReadyAt,
          ...(verified.continuation ? { continuation: verified.continuation } : {}),
          rollback: { ...receipt.rollback!, stage: 'reconciling_admission' },
        })
      }
      if (receipt.rollback!.stage === 'reconciling_admission') {
        const admission = await this.adapter.admissionSnapshot()
        const pendingAdmission = admission.pending + admission.leased
        const reconciledAdmission = reconciledAdmissions(receipt, pendingAdmission)
        if (pendingAdmission > 0) return await this.refresh(receipt, {
          admission: { pending: pendingAdmission, reconciled: reconciledAdmission, oldestAgeMs: admission.oldestAgeMs },
          blockers: ['admission_queue'],
        })
        const recoveryReceipt = await rollbackRuntimeReceipt(receipt, previousRelease, previousSlot, deployment)
        await this.adapter.persistRuntimeReady(recoveryReceipt, {
          pid: receipt.activatedPid!, processReadyAt: receipt.processReadyAt!, runtimeReadyAt: receipt.runtimeReadyAt!, publicRoute: false,
        })
        receipt = await this.refresh(receipt, {
          admission: { pending: 0, reconciled: reconciledAdmission, oldestAgeMs: 0 }, blockers: [],
          rollback: { ...receipt.rollback!, stage: 'route_committing' },
        })
      }
      const recoveryReceipt = await rollbackRuntimeReceipt(receipt, previousRelease, previousSlot, deployment)
      const route = await this.adapter.routeState()
      if (route.generation === deployment.expectedRouteGeneration) {
        await this.adapter.switchRoute(advanceDedicatedRoute(route, { slot: previousSlot, releaseId: basename(previousRelease) }))
      } else if (route.generation !== deployment.expectedRouteGeneration + 1 || route.activeSlot !== previousSlot || route.slots[previousSlot].releaseId !== basename(previousRelease)) {
        throw new Error('rollback route commit fence mismatch')
      }
      const committed = await this.adapter.routeState()
      await this.adapter.persistRuntimeReady(recoveryReceipt, {
        pid: receipt.activatedPid!, processReadyAt: receipt.processReadyAt!, runtimeReadyAt: receipt.runtimeReadyAt!,
        publicRoute: true, routeGeneration: committed.generation,
      })
      await this.adapter.writeCandidateState(undefined)
      await this.adapter.writeRuntimeFence(undefined)
      return await this.transition(receipt, 'rolled_back', {
        routeGeneration: committed.generation,
        observedRouteGeneration: committed.generation,
        admission: { pending: 0, reconciled: receipt.admission?.reconciled ?? 0, oldestAgeMs: 0 },
        rollback: { predecessorReleaseId: receipt.predecessorReleaseId, outcome: 'completed', pid: receipt.activatedPid, deployment, stage: 'route_committing' },
        error: redactedDeploymentError(message),
      })
    } catch (rollbackError) {
      return await this.transition(receipt, 'rollback_failed', {
        rollback: receipt.rollback ? { ...receipt.rollback, outcome: 'failed' } : undefined,
        error: redactedDeploymentError(`${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`),
      })
    }
  }

  private async cancelBeforeHandoff(
    receipt: DeploymentReceipt, message: string, previousRelease: string, previousSlot: DedicatedSlot,
  ): Promise<DeploymentReceipt> {
    if (receipt.plannedRestart?.attemptId) await this.adapter.abortPlannedRestart(previousSlot, receipt.plannedRestart.attemptId).catch(() => undefined)
    await this.adapter.writeCandidateState(undefined)
    await this.adapter.writeRuntimeFence(undefined)
    const verified = await this.adapter.verifySlot(previousSlot, {
      bundleSha256: sha256(await readFile(join(previousRelease, 'kala-runtime.cjs'))),
    })
    const route = await this.adapter.routeState()
    const recoveryReceipt = await rollbackRuntimeReceipt(receipt, previousRelease, previousSlot, deploymentOwnership(receipt))
    await this.adapter.persistRuntimeReady(recoveryReceipt, { ...verified, publicRoute: true, routeGeneration: route.generation })
    return await this.transition(receipt, 'rolled_back', {
      routeGeneration: route.generation, observedRouteGeneration: route.generation,
      rollback: { ...receipt.rollback!, outcome: 'completed', pid: verified.pid, mode: 'cancel', stage: 'verifying_live' },
      error: redactedDeploymentError(message),
    })
  }

  private async activateRollbackPredecessor(
    receipt: DeploymentReceipt,
    deployment: NonNullable<HostRestartAttempt['deployment']>,
    previousSlot: DedicatedSlot,
    previousRelease: string,
  ): Promise<DeploymentReceipt> {
    // `activating_predecessor` is persisted before this idempotent side-effect
    // group. A Supervisor crash after start but before the next receipt can
    // safely replay activation instead of misclassifying the live predecessor
    // as a candidate that still needs a new continuation handoff.
    await this.adapter.writeCandidateState({ deploymentId: deployment.deploymentId, expectedRouteGeneration: deployment.expectedRouteGeneration, phase: 'paused' })
    await this.adapter.stopSlot(receipt.candidateSlot).catch(() => undefined)
    await this.adapter.clearRuntimeReady().catch(() => undefined)
    await this.adapter.writeRuntimeFence(deployment)
    await this.adapter.activateSlot(previousSlot, previousRelease)
    await this.adapter.startSlot(previousSlot)
    return await this.refresh(receipt, { rollback: { ...receipt.rollback!, stage: 'activating' } })
  }

  private async livePredecessorAttempt(receipt: DeploymentReceipt, previousSlot: DedicatedSlot): Promise<boolean> {
    const attemptId = receipt.plannedRestart?.attemptId
    if (!attemptId) return false
    const status = await this.adapter.restartStatus(previousSlot).catch(() => undefined)
    const attempt = status ? exactAttempt(status, attemptId) : undefined
    return attempt?.phase === 'requested' || attempt?.phase === 'draining' || attempt?.phase === 'checkpoint_reached' || attempt?.phase === 'aborted'
  }

  private async candidateContinuationCompleted(receipt: DeploymentReceipt): Promise<boolean> {
    const attemptId = receipt.plannedRestart?.attemptId
    if (!attemptId) return false
    const status = await this.adapter.restartStatus(receipt.candidateSlot).catch(() => undefined)
    const attempt = status ? exactAttempt(status, attemptId) : undefined
    return attempt?.phase === 'completed' && sameDeploymentOwnership(attempt.deployment, deploymentOwnership(receipt))
  }

  async get(deploymentId: string): Promise<DeploymentReceipt | null> {
    const value = await readJsonFile<unknown>(this.receiptPath(deploymentId))
    return value === undefined ? null : parseDeploymentReceipt(value)
  }

  async getByOperation(operationId: string): Promise<DeploymentReceipt | null> {
    return await this.findByOperation(operationId)
  }

  private async refresh(receipt: DeploymentReceipt, patch: Partial<DeploymentReceipt>): Promise<DeploymentReceipt> {
    const next = { ...receipt, ...patch, receiptRevision: receipt.receiptRevision + 1, updatedAt: new Date().toISOString() }
    await this.persist(next)
    return next
  }

  private async transition(receipt: DeploymentReceipt, phase: DeploymentPhase, patch: Partial<DeploymentReceipt> = {}): Promise<DeploymentReceipt> {
    assertPhaseTransition(receipt.phase, phase)
    const next = { ...receipt, ...patch, phase, receiptRevision: receipt.receiptRevision + 1, updatedAt: new Date().toISOString() }
    await this.persist(next)
    return next
  }

  private async requiredReceipt(deploymentId: string): Promise<DeploymentReceipt> {
    const receipt = await this.get(deploymentId)
    if (!receipt) throw new Error('deployment receipt not found')
    return receipt
  }

  private async assertDeploymentIdAvailable(deploymentId: string): Promise<void> {
    if (await this.get(deploymentId)) throw new Error('deploymentId is already bound to an existing deployment')
  }

  private async assertNoActiveDeployment(): Promise<void> {
    const names = await import('node:fs/promises').then((fs) => fs.readdir(join(this.root, 'receipts'))).catch(() => [])
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const value = await readJsonFile<unknown>(join(this.root, 'receipts', name))
      const receipt = value === undefined ? undefined : parseDeploymentReceipt(value)
      if (receipt && !terminal(receipt.phase)) throw new Error(`deployment ${receipt.deploymentId} is already active in phase ${receipt.phase}`)
    }
  }

  private async findByOperation(operationId: string): Promise<DeploymentReceipt | null> {
    const index = parseOperationIndex(await readJsonFile<unknown>(join(this.root, 'operation-index.json')))
    if (index[operationId]) return await this.get(index[operationId]!)
    // Receipt and operation-index are separately durable atomic files. A
    // Supervisor crash after the receipt rename but before the index rename
    // must rebuild the derived index instead of attempting the deployment a
    // second time or wedging on receiptRevision=1.
    const names = await import('node:fs/promises').then((fs) => fs.readdir(join(this.root, 'receipts'))).catch(() => [])
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const value = await readJsonFile<unknown>(join(this.root, 'receipts', name))
      const receipt = value === undefined ? undefined : parseDeploymentReceipt(value)
      if (!receipt?.operationIds.includes(operationId)) continue
      await this.rebuildOperationIndex(receipt)
      return receipt
    }
    return null
  }

  private async verifyRelease(receipt: DeploymentReceipt): Promise<void> {
    await verifyImmutableRelease({ deployRoot: this.root, releaseDir: receipt.releaseDir, releaseId: receipt.releaseId, releaseDigest: receipt.releaseDigest, bundleSha256: receipt.bundleSha256 })
  }

  private async persist(receipt: DeploymentReceipt): Promise<void> {
    parseDeploymentReceipt(receipt)
    await mkdir(join(this.root, 'receipts'), { recursive: true, mode: 0o700 })
    const currentValue = await readJsonFile<unknown>(this.receiptPath(receipt.deploymentId))
    const current = currentValue === undefined ? null : parseDeploymentReceipt(currentValue)
    if (current && receipt.receiptRevision <= current.receiptRevision) throw new Error('receipt revision must increase monotonically')
    if (current && (current.deploymentId !== receipt.deploymentId || current.requestedAt !== receipt.requestedAt || current.releaseDigest !== receipt.releaseDigest || current.sourceReleaseDigest !== receipt.sourceReleaseDigest || current.expectedRouteGeneration !== receipt.expectedRouteGeneration || current.fencingToken !== receipt.fencingToken || current.previousSlot !== receipt.previousSlot || current.candidateSlot !== receipt.candidateSlot)) throw new Error('immutable deployment receipt identity changed')
    await writeJsonFile(this.receiptPath(receipt.deploymentId), receipt, 0o640)
    await this.rebuildOperationIndex(receipt)
  }

  private async rebuildOperationIndex(receipt: DeploymentReceipt): Promise<void> {
    const indexPath = join(this.root, 'operation-index.json')
    const index = parseOperationIndex(await readJsonFile<unknown>(indexPath))
    const conflict = receipt.operationIds.find((operationId) => index[operationId] && index[operationId] !== receipt.deploymentId)
    if (conflict) throw new Error('operationId is already bound to another deployment')
    await writeJsonFile(indexPath, { ...index, ...Object.fromEntries(receipt.operationIds.map((operationId) => [operationId, receipt.deploymentId])) }, 0o640)
  }

  private receiptPath(deploymentId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(deploymentId)) throw new Error('invalid deployment id')
    return join(this.root, 'receipts', `${deploymentId}.json`)
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(() => undefined, () => undefined)
    return await result
  }
}

export async function activateRelease(currentLink: string, releaseDir: string): Promise<void> {
  const target = resolve(releaseDir)
  const temp = `${currentLink}.next-${process.pid}`
  await mkdir(dirname(currentLink), { recursive: true, mode: 0o700 })
  await unlink(temp).catch(() => undefined)
  await symlink(target, temp)
  await rename(temp, currentLink)
  const directory = await open(dirname(currentLink), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

function terminal(phase: DeploymentPhase): boolean {
  return terminalPhases.has(phase)
}

function reconciledAdmissions(receipt: DeploymentReceipt, currentPending: number): number {
  const previous = receipt.admission
  if (!previous) return 0
  return previous.reconciled + Math.max(0, previous.pending - currentPending)
}

function assertPhaseTransition(from: DeploymentPhase, to: DeploymentPhase): void {
  if (!phaseTransitions[from].has(to)) throw new Error(`invalid deployment phase transition: ${from} -> ${to}`)
}

async function readLinkTarget(path: string): Promise<string | undefined> {
  return await import('node:fs/promises').then((fs) => fs.readlink(path)).then((target) => resolve(dirname(path), target)).catch(() => undefined)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertRequestRoute(request: DedicatedDeployRequest, route: DedicatedRouteState): void {
  if (request.expectedRouteGeneration !== route.generation || request.predecessorReleaseId !== route.slots[route.activeSlot].releaseId || request.candidateSlot !== otherSlot(route.activeSlot)) throw new Error('stale route generation, predecessor, or candidate slot')
}

function assertReceiptRoute(receipt: DeploymentReceipt, route: DedicatedRouteState): void {
  if (receipt.expectedRouteGeneration !== route.generation || receipt.previousSlot !== route.activeSlot || receipt.predecessorReleaseId !== route.slots[route.activeSlot].releaseId) throw new Error('route changed after staging')
}

function deploymentOwnership(receipt: DeploymentReceipt): NonNullable<HostRestartAttempt['deployment']> {
  return { deploymentId: receipt.deploymentId, targetReleaseDigest: receipt.releaseDigest, expectedRouteGeneration: receipt.expectedRouteGeneration, fencingToken: receipt.fencingToken }
}

function sameDeploymentOwnership(
  actual: HostRestartAttempt['deployment'] | undefined,
  expected: NonNullable<HostRestartAttempt['deployment']>,
): boolean {
  return actual?.deploymentId === expected.deploymentId
    && actual.targetReleaseDigest === expected.targetReleaseDigest
    && actual.expectedRouteGeneration === expected.expectedRouteGeneration
    && actual.fencingToken === expected.fencingToken
}

async function automaticRollbackOwnership(
  receipt: DeploymentReceipt,
  route: DedicatedRouteState,
): Promise<NonNullable<HostRestartAttempt['deployment']>> {
  const beforeCommit = route.generation === receipt.expectedRouteGeneration
    && route.activeSlot === receipt.previousSlot
    && route.slots[route.activeSlot].releaseId === receipt.predecessorReleaseId
  const afterCommit = route.generation === receipt.expectedRouteGeneration + 1
    && route.activeSlot === receipt.candidateSlot
    && route.slots[route.activeSlot].releaseId === receipt.releaseId
  if (!beforeCommit && !afterCommit) throw new Error('automatic rollback route ownership is uncertain')
  const seed = `${receipt.deploymentId}:${receipt.fencingToken}:${route.generation}:${receipt.sourceReleaseDigest}`
  const identity = createHash('sha256').update(seed).digest('hex')
  return {
    deploymentId: `rollback-${identity.slice(0, 32)}`,
    targetReleaseDigest: receipt.sourceReleaseDigest,
    expectedRouteGeneration: route.generation,
    fencingToken: createHash('sha256').update(`fence:${seed}`).digest('base64url'),
  }
}

async function rollbackRuntimeReceipt(
  receipt: DeploymentReceipt,
  releaseDir: string,
  slot: DedicatedSlot,
  deployment: NonNullable<HostRestartAttempt['deployment']>,
): Promise<DeploymentReceipt> {
  return {
    ...receipt,
    deploymentId: deployment.deploymentId,
    releaseId: basename(releaseDir),
    releaseDir,
    bundleSha256: sha256(await readFile(join(releaseDir, 'kala-runtime.cjs'))),
    releaseDigest: receipt.sourceReleaseDigest,
    expectedRouteGeneration: deployment.expectedRouteGeneration,
    fencingToken: deployment.fencingToken,
    candidateSlot: slot,
  }
}

function exactAttempt(status: HostRestartStatus, attemptId: string): HostRestartAttempt | undefined {
  if (status.current?.attemptId === attemptId) return status.current
  if (status.last?.attemptId === attemptId) return status.last
  return undefined
}

function checkpointed(attempt: HostRestartAttempt): number {
  return attempt.sessions.filter((session) => ['safe', 'already_safe'].includes(session.checkpointStatus)).length
}

function restartBlockers(attempt: HostRestartAttempt): readonly string[] {
  return attempt.sessions.filter((session) => !['safe', 'already_safe'].includes(session.checkpointStatus)).map((session) => session.sessionId + ':' + session.checkpointStatus)
}

function isConnectionLoss(error: unknown): boolean {
  return /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/iu.test(error instanceof Error ? error.message : String(error))
}

function parseOperationIndex(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid operation index')
  const entries = Object.entries(value)
  for (const [operationId, deploymentId] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(operationId) || typeof deploymentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(deploymentId)) throw new Error('invalid operation index entry')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

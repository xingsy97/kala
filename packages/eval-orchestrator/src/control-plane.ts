import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  acceptEvaluationRunSpec,
  AnalysisJobSchema,
  AnalysisOutputManifestSchema,
  AnalyzerInputSchema,
  GradingResultSchema,
  assertTrialStateTransition,
  canonicalJson,
  counterfactualFailureFingerprint,
  CommittedAcknowledgementSchema,
  ControlPlaneCapabilitiesSchema,
  EvaluationCommandSchema,
  EvaluationEventSchema,
  EvaluationQuerySchema,
  EvaluationRunTemplatesSchema,
  DefectFindingSchema,
  CounterfactualResultSchema,
  FailureClusterPromotionSchema,
  FailureClusterSchema,
  TraceAlignmentResultSchema,
  decideFailureResponsibility,
  decideCatalogPolicy,
  LeaseHeartbeatSchema,
  PlatformMetricsSnapshotSchema,
  parseTrialTraceJsonl,
  leaderboardCompetitorKey,
  LeaderboardEntrySchema,
  negotiateProtocolVersion,
  RelativeArtifactPathSchema,
  sha256Hex,
  Sha256Schema,
  TrialLeaseSchema,
  TrialProgressUpdateSchema,
  TrialResultCommitSchema,
  verifyTrialEvidence,
  verifyReproductionBundleSignature,
  WorkerRegistrationSchema,
  type CommittedAcknowledgement,
  type ControlPlaneCapabilities,
  type EvaluationCommand,
  type EvaluationEvent,
  type EvaluationQuery,
  type EvaluationRunTemplate,
  type LeaseHeartbeat,
  type LeaderboardEntry,
  type AuditRecord,
  type DeletionImpact,
  type TrialLease,
  type TrialEvidence,
  type TrialProgressUpdate,
  type TrialResultCommit,
  type WorkerRegistration,
  type SigningKeyRegistry,
  type PolicyOperation,
} from '@agent-kernel/eval-protocol'

import { DurableJournal } from './journal.js'
import { currentPrincipal } from './principal-context.js'
import { ContainedArtifactStore } from './artifact-store.js'
import { type JournalDomainRecord, JournalTransactionSchema } from './model.js'
import { ControlPlaneProjection } from './projection.js'
import { decideRegressionGate, type PairedObservation } from './regression-gate.js'
import { generateEvaluationReport, type GeneratedReport } from './report-generator.js'
import { CAPABILITY_METHODOLOGY_VERSION, deriveCapabilityVector } from './capability-vector.js'
import type { TaskCatalog } from './task-catalog.js'
import { RegisteredTaskCatalog } from './task-catalog.js'
import { EvidenceArchive } from './evidence-archive.js'

export type ControlPlaneOptions = {
  journalPath: string
  reportRoot?: string
  taskCatalog: TaskCatalog
  evidenceArchive?: EvidenceArchive
  runTemplates?: readonly EvaluationRunTemplate[]
  now?: () => Date
  randomId?: () => string
  commitToken?: () => string
  signingKeyRegistry?: SigningKeyRegistry
}

export class EvaluationControlPlane {
  readonly journal: DurableJournal
  readonly projection = new ControlPlaneProjection()
  private readonly taskCatalog: TaskCatalog
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly commitToken: () => string
  readonly evidenceArchive: EvidenceArchive
  private readonly runTemplates: readonly EvaluationRunTemplate[]
  readonly artifactStore: ContainedArtifactStore
  private readonly signingKeyRegistry: SigningKeyRegistry
  private readonly generatedReports = new Map<string, GeneratedReport>()
  private mutationTail: Promise<void> = Promise.resolve()
  private artifactUploadFailures = 0
  private lastRecoveryMs = 0
  private readonly metricsPath: string

  constructor(options: ControlPlaneOptions) {
    this.journal = new DurableJournal(options.journalPath)
    this.taskCatalog = options.taskCatalog
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.commitToken = options.commitToken ?? (() => randomBytes(32).toString('hex'))
    this.signingKeyRegistry = options.signingKeyRegistry ?? { resolve: () => undefined }
    this.evidenceArchive = options.evidenceArchive ?? new EvidenceArchive()
    this.runTemplates = EvaluationRunTemplatesSchema.parse(options.runTemplates ?? [])
    this.artifactStore = new ContainedArtifactStore(options.reportRoot ?? resolve(dirname(options.journalPath), 'artifacts'))
    this.metricsPath = resolve(dirname(options.journalPath), 'platform-metrics.jsonl')
  }

  async initialize(): Promise<void> {
    const recoveryStartedAt = performance.now()
    await this.artifactStore.initialize()
    await this.evidenceArchive.initialize()
    this.projection.replay(await this.journal.readAll())
    if (this.taskCatalog instanceof RegisteredTaskCatalog) this.taskCatalog.restore([...this.projection.catalogSlices.entries()].map(([sliceManifestHash, value]) => ({ sliceManifestHash, taskIds: value.taskIds, tasks: value.tasks })))
    await this.persistCatalogRegistrations()
    await this.recoverExpiredLeases()
    await this.expireAnalysisJobs()
    for (const [runId, deletion] of this.projection.deletedRuns) {
      if (this.projection.completedRunDeletions.has(runId)) continue
      await this.artifactStore.deleteFiles(deletion.artifactPaths)
      const completedAt = this.now().toISOString()
      await this.commit([{ kind: 'run.deletion.completed', runId, completedAt }], 'run-deletion-complete-' + runId, completedAt)
    }
    this.lastRecoveryMs = Math.max(0, Math.round(performance.now() - recoveryStartedAt))
  }

  capabilities(): ControlPlaneCapabilities {
    return ControlPlaneCapabilitiesSchema.parse({
      schemaVersion: 1,
      protocolVersions: [1],
      controlPlaneVersion: '0.0.0',
      commands: ['run.create', 'run.start', 'run.cancel', 'trial.retry', 'run.grade', 'run.analyze', 'run.align', 'run.cluster', 'run.counterfactual', 'analysis.job.start', 'analysis.job.heartbeat', 'analysis.job.complete', 'analysis.job.fail', 'analysis.job.cancel', 'leaderboard.publish', 'leaderboard.invalidate', 'defect.record', 'failure-cluster.promote', 'defect.promote', 'regression.evaluate', 'report.generate', 'retention.set', 'run.delete', 'insight.record'],
      queryResources: ['capabilities', 'platform-metrics', 'runs', 'run', 'events', 'trials', 'trial', 'task', 'catalog', 'artifacts', 'leaderboard', 'analysis-jobs', 'analysis-job', 'analysis-output', 'capability-vectors', 'defects', 'failure-cluster-promotions', 'reproductions', 'regressions', 'regression-decisions', 'insights', 'reports', 'audit', 'retention', 'deletion-impact', 'workers', 'archive-summary', 'archived-runs', 'archived-run', 'archive-documents', 'archive-document', 'run-templates'],
      liveEvents: 'sse',
      standalone: true,
      cleanCutover: true,
      deprecatedCompatibilitySurfaces: [],
    })
  }

  stageTrialArtifact(input: { leaseId: string; commitToken: string; path: string; mediaType: string; bytes: number; sha256: string }, content: Uint8Array): Promise<void> {
    return this.mutate(async () => {
      try {
      const lease = this.projection.leases.get(input.leaseId)
      if (!lease || lease.state !== 'active') throw new Error('lease is not active: ' + input.leaseId)
      if (lease.lease.commitToken !== input.commitToken) throw new Error('artifact upload does not match active lease authority')
      this.assertTrialLeaseCurrent(lease)
      const path = RelativeArtifactPathSchema.parse(input.path)
      const sha256 = Sha256Schema.parse(input.sha256)
      if (!input.mediaType.trim()) throw new Error('artifact media type is required')
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes !== content.byteLength) throw new Error('artifact upload size mismatch: ' + path)
      const prefix = lease.lease.runId + '/' + lease.lease.trialId + '/'
      if (!path.startsWith(prefix)) throw new Error('trial artifact path is outside leased trial prefix')
      await this.artifactStore.writeIdempotent(path, content, sha256)
      } catch (error) { this.artifactUploadFailures += 1; throw error }
    })
  }

  stageAnalysisArtifact(input: { jobId: string; executorId: string; leaseToken?: string; generation?: number; path: string; mediaType: string; bytes: number; sha256: string }, content: Uint8Array): Promise<void> {
    return this.mutate(async () => {
      try {
      const job = this.requiredAnalysisJob(input.jobId)
      if (job.state !== 'running' || job.executorId !== input.executorId) throw new Error('analysis artifact upload does not match active job authority')
      this.assertAnalysisLease(job, input)
      if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= this.now().getTime()) throw new Error('analysis job lease has expired')
      const path = RelativeArtifactPathSchema.parse(input.path)
      const sha256 = Sha256Schema.parse(input.sha256)
      if (!input.mediaType.trim()) throw new Error('artifact media type is required')
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes !== content.byteLength) throw new Error('artifact upload size mismatch: ' + path)
      if (!path.startsWith('analysis/' + job.jobId + '/')) throw new Error('analysis artifact path is outside job prefix')
      await this.artifactStore.writeIdempotent(path, content, sha256)
      } catch (error) { this.artifactUploadFailures += 1; throw error }
    })
  }

  executeCommand(input: unknown): Promise<CommittedAcknowledgement> {
    const command = EvaluationCommandSchema.parse(input)
    return this.mutate(async () => { await this.persistCatalogRegistrations(); return await this.executeCommandExclusive(command) })
  }

  registerWorker(input: unknown): Promise<WorkerRegistration> {
    const worker = WorkerRegistrationSchema.parse(input)
    negotiateProtocolVersion(this.capabilities().protocolVersions, worker.protocolVersions)
    return this.mutate(async () => {
      const at = this.now().toISOString()
      await this.commit([{ kind: 'worker.registered', worker, registeredAt: at }], 'worker-register-' + worker.workerId, at)
      return worker
    })
  }

  heartbeatWorker(workerId: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.projection.workers.has(workerId)) throw new Error('unknown worker: ' + workerId)
      const at = this.now().toISOString()
      await this.commit([{ kind: 'worker.heartbeat', workerId, at }], 'worker-heartbeat-' + this.randomId(), at)
    })
  }

  issueLease(workerId: string, leaseMs: number): Promise<TrialLease | null> {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) return Promise.reject(new Error('leaseMs must be a positive integer'))
    return this.mutate(async () => {
      const worker = this.projection.workers.get(workerId)
      if (!worker) throw new Error('unknown worker: ' + workerId)
      const activeWorkerLeases = [...this.projection.leases.values()].filter((lease) => lease.state === 'active' && lease.lease.workerId === workerId)
      const activeCount = activeWorkerLeases.length
      if (activeCount >= worker.registration.capacity.maxTrials) return null
      await this.enforceBudgetStops()
      const trial = this.nextCompatibleQueuedTrial(worker.registration)
      if (!trial) return null
      const run = this.projection.runs.get(trial.runId)!
      const reserved = activeWorkerLeases.map((active) => this.projection.runs.get(active.lease.runId)!.accepted.spec.sandbox.resources).reduce((total, resources) => ({ cpu: total.cpu + resources.cpu, memoryMb: total.memoryMb + resources.memoryMb, diskMb: total.diskMb + resources.diskMb, gpu: total.gpu + (resources.gpu ?? 0) }), { cpu: 0, memoryMb: 0, diskMb: 0, gpu: 0 })
      const required = run.accepted.spec.sandbox.resources
      if (reserved.cpu + required.cpu > worker.registration.capacity.cpu || reserved.memoryMb + required.memoryMb > worker.registration.capacity.memoryMb || reserved.diskMb + required.diskMb > worker.registration.capacity.diskMb || reserved.gpu + (required.gpu ?? 0) > worker.registration.capacity.gpu) return null
      const attempt = trial.attempt + 1
      if (attempt > run.accepted.spec.execution.retryPolicy.maxAttempts) return null
      const issuedAt = this.now()
      const lease = TrialLeaseSchema.parse({
        schemaVersion: 1,
        leaseId: 'lease-' + this.randomId(),
        runId: trial.runId,
        trialId: trial.trialId,
        attempt,
        workerId,
        specHash: run.accepted.specHash,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + Math.min(leaseMs, run.accepted.spec.execution.leaseMs)).toISOString(),
        commitToken: this.commitToken(),
      })
      const event = this.event(trial.runId, 'trial.state', { trialId: trial.trialId, state: 'leased', leaseId: lease.leaseId }, trial.trialId, lease.leaseId)
      await this.commit([{ kind: 'lease.issued', lease }, { kind: 'event.appended', event }], lease.leaseId, lease.issuedAt)
      return lease
    })
  }

  heartbeatLease(input: unknown, executionReceipt: 'none' | 'known' | 'indeterminate'): Promise<LeaseHeartbeat> {
    const heartbeat = LeaseHeartbeatSchema.parse(input)
    return this.mutate(async () => {
      const lease = this.projection.leases.get(heartbeat.leaseId)
      if (!lease || lease.state !== 'active') throw new Error('lease is not active: ' + heartbeat.leaseId)
      if (lease.lease.workerId !== heartbeat.workerId) throw new Error('lease worker mismatch')
      const now = this.now()
      if (Date.parse(lease.expiresAt) <= now.getTime()) throw new Error('lease has expired: ' + heartbeat.leaseId)
      const leaseDurationMs = Date.parse(lease.lease.expiresAt) - Date.parse(lease.lease.issuedAt)
      const accepted = LeaseHeartbeatSchema.parse({ ...heartbeat, at: now.toISOString() })
      const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString()
      await this.commit([{ kind: 'lease.heartbeat', leaseId: accepted.leaseId, workerId: accepted.workerId, at: accepted.at, expiresAt, executionReceipt }], 'lease-heartbeat-' + this.randomId(), accepted.at)
      return accepted
    })
  }

  progressTrial(input: unknown): Promise<EvaluationEvent> {
    const requested = TrialProgressUpdateSchema.parse(input)
    return this.mutate(async () => {
      const lease = this.projection.leases.get(requested.leaseId)
      if (!lease || lease.state !== 'active') throw new Error('lease is not active: ' + requested.leaseId)
      if (lease.lease.workerId !== requested.workerId) throw new Error('lease worker mismatch')
      if (lease.lease.trialId !== requested.trialId) throw new Error('lease trial mismatch')
      if (Date.parse(lease.expiresAt) <= this.now().getTime()) throw new Error('lease has expired: ' + requested.leaseId)
      const trial = this.projection.trials.get(requested.trialId)!
      assertTrialStateTransition(trial.state, requested.state)
      const at = this.now().toISOString()
      const event = this.event(lease.lease.runId, 'trial.state', { trialId: requested.trialId, state: requested.state }, requested.trialId, requested.leaseId, at, 'worker')
      await this.commit([{ kind: 'event.appended', event }], 'trial-progress-' + this.randomId(), at)
      return event
    })
  }

  commitTrialResult(input: unknown): Promise<TrialResultCommit> {
    const commit = TrialResultCommitSchema.parse(input)
    return this.mutate(async () => {
      const failedAttemptKey = commit.trialId + '|' + String(commit.attempt)
      const priorAttempt = this.projection.failedAttempts.get(failedAttemptKey)
      if (priorAttempt) {
        if (priorAttempt.resultHash !== commit.resultHash || priorAttempt.artifactManifestHash !== commit.artifactManifestHash) throw new Error('conflicting duplicate failed attempt for trial: ' + commit.trialId)
        return priorAttempt
      }
      const prior = this.projection.resultCommits.get(commit.trialId)
      if (prior) {
        if (prior.resultHash !== commit.resultHash || prior.artifactManifestHash !== commit.artifactManifestHash) {
          throw new Error('conflicting duplicate completion for trial: ' + commit.trialId)
        }
        return prior
      }
      const lease = this.projection.leases.get(commit.leaseId)
      if (!lease || lease.state !== 'active') throw new Error('lease is not active: ' + commit.leaseId)
      if (lease.lease.trialId !== commit.trialId || lease.lease.attempt !== commit.attempt || lease.lease.commitToken !== commit.commitToken) {
        throw new Error('result commit does not match active lease authority')
      }
      this.assertTrialLeaseCurrent(lease)
      if (commit.evidence) {
        const artifactRun = this.projection.runs.get(lease.lease.runId)!
        const artifactDecision = await this.requireCatalogPolicy(artifactRun.accepted.spec, 'artifact_publication', commit.trialId, commit.committedAt)
        await this.commit([artifactDecision], 'policy-artifact-' + commit.trialId + '-' + String(commit.attempt), commit.committedAt)
        const evidence = await verifyTrialEvidence(commit.evidence)
        const trial = this.projection.trials.get(commit.trialId)!
        const run = this.projection.runs.get(lease.lease.runId)!
        if (evidence.runId !== lease.lease.runId || evidence.taskId !== trial.taskId || evidence.agentVariantId !== trial.agentVariantId || evidence.repeatIndex !== trial.repeatIndex) throw new Error('canonical evidence does not match leased trial identity')
        if (evidence.artifactManifest.runId !== lease.lease.runId || evidence.artifactManifest.trialId !== commit.trialId || evidence.artifactManifest.leaseId !== commit.leaseId) throw new Error('canonical artifact manifest does not match leased trial authority')
        if (evidence.environmentLock.provider !== run.accepted.spec.sandbox.provider) throw new Error('canonical evidence sandbox provider does not match accepted spec')
        if (evidence.environmentLock.imageDigest !== run.accepted.spec.sandbox.imageDigest.replace(/^local:/u, '') && evidence.environmentLock.imageDigest !== run.accepted.spec.sandbox.imageDigest) throw new Error('canonical evidence environment image does not match accepted spec')
        if (evidence.benchmarkResult.benchmarkId !== run.accepted.spec.taskPack.id) throw new Error('canonical evidence benchmark does not match accepted task pack')
        if (evidence.benchmarkResult.verifierId !== run.accepted.spec.verification.verifierId) throw new Error('canonical evidence verifier does not match accepted spec')
        if (evidence.benchmarkResult.verifierVersion !== run.accepted.spec.verification.verifierVersion) throw new Error('canonical evidence verifier version does not match accepted spec')
        if (evidence.evidenceLevel === 'official' && !evidence.benchmarkResult.officialEvidence) throw new Error('canonical evidence cannot claim official level without official verifier evidence')
        if (run.accepted.spec.verification.officialRequired && (!evidence.benchmarkResult.officialEvidence || evidence.evidenceLevel !== 'official')) throw new Error('official-required run lacks official canonical evidence')
        for (const entry of evidence.artifactManifest.entries) await this.artifactStore.readEntry(entry)
      }
      const trial = this.projection.trials.get(commit.trialId)!
      const run = this.projection.runs.get(lease.lease.runId)!
      if (commit.terminalState !== 'completed') assertFailureMatchesTerminal(commit)
      const retryable = commit.terminalState !== 'completed' && commit.terminalState !== 'indeterminate'
        && commit.failure!.retryable && commit.failure!.observedStateSufficientForRecovery
        && run.accepted.spec.execution.retryPolicy.retryableCategories.includes(commit.failure!.category)
        && commit.attempt < run.accepted.spec.execution.retryPolicy.maxAttempts
      if (retryable) {
        const at = commit.committedAt
        const retryNotBefore = new Date(Date.parse(at) + run.accepted.spec.execution.retryPolicy.backoffMs).toISOString()
        let sequence = run.events.length
        const terminal = EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: run.accepted.spec.runId, trialId: commit.trialId, leaseId: commit.leaseId, type: 'trial.state', producer: 'control-plane', failure: commit.failure, data: { trialId: commit.trialId, state: commit.terminalState, resultHash: commit.resultHash, leaseId: commit.leaseId } })
        sequence += 1
        const queued = EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: run.accepted.spec.runId, trialId: commit.trialId, type: 'trial.state', producer: 'control-plane', data: { trialId: commit.trialId, state: 'queued', reason: 'retryable_' + commit.failure!.category, retryNotBefore } })
        await this.commit([{ kind: 'attempt.failed', commit }, { kind: 'lease.closed', leaseId: commit.leaseId, at, reason: 'committed' }, { kind: 'event.appended', event: terminal }, { kind: 'event.appended', event: queued }], 'attempt-' + commit.trialId + '-' + String(commit.attempt), at)
        return commit
      }
      const trialStateEvents: EvaluationEvent[] = []
      let trialSequence = this.projection.runs.get(lease.lease.runId)!.events.length
      for (const state of completionPath(trial.state, commit.terminalState)) {
        trialStateEvents.push(EvaluationEventSchema.parse({ schemaVersion: 1, sequence: trialSequence, at: commit.committedAt, runId: lease.lease.runId, trialId: commit.trialId, type: 'trial.state', producer: 'control-plane', leaseId: commit.leaseId, data: { trialId: commit.trialId, state, resultHash: commit.resultHash } }))
        trialSequence += 1
      }
      const records: JournalDomainRecord[] = [
        { kind: 'result.committed', commit },
        { kind: 'lease.closed', leaseId: commit.leaseId, at: commit.committedAt, reason: 'committed' },
        ...trialStateEvents.map((event) => ({ kind: 'event.appended' as const, event })),
      ]
      const terminalCount = run.trialIds.filter((trialId) => trialId !== commit.trialId && terminalTrialState(this.projection.trials.get(trialId)!.state)).length + 1
      if (terminalCount === run.trialIds.length) {
        const failed = run.trialIds.some((trialId) => trialId !== commit.trialId && this.projection.trials.get(trialId)!.state !== 'completed') || commit.terminalState !== 'completed'
        let sequence = trialSequence
        const states = failed ? ['failed'] as const : ['verifying', 'analyzing', 'reporting', 'completed'] as const
        for (const state of states) {
          records.push({ kind: 'event.appended', event: EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at: commit.committedAt, runId: run.accepted.spec.runId, type: 'run.state', producer: 'control-plane', data: { state } }) })
          sequence += 1
        }
      }
      await this.commit(records, 'result-' + commit.trialId + '-' + String(commit.attempt), commit.committedAt)
      return commit
    })
  }

  expireLeases(): Promise<number> {
    return this.mutate(async () => await this.recoverExpiredLeases())
  }

  async query(input: unknown): Promise<unknown> {
    const query = EvaluationQuerySchema.parse(input)
    switch (query.resource) {
      case 'capabilities': return this.capabilities()
      case 'platform-metrics': return await this.platformMetrics()
      case 'runs': return page([...this.projection.runs.values()].filter((run) => (!query.state || run.state === query.state) && matchesSearch(run, query.search)), query.page)
      case 'run': return this.projection.runs.get(query.runId) ?? null
      case 'events': {
        const events = (this.projection.runs.get(query.runId)?.events ?? []).filter((event) => event.sequence > query.afterSequence)
        return page(events, query.page)
      }
      case 'trials': {
        const trials = [...this.projection.trials.values()].filter((trial) => trial.runId === query.runId && (!query.state || trial.state === query.state) && (!query.agentVariantId || trial.agentVariantId === query.agentVariantId) && (!query.taskId || trial.taskId === query.taskId))
        return page(trials, query.page)
      }
      case 'trial': return this.projection.trials.get(query.trialId) ?? null
      case 'task': return await this.taskCatalog.task(query.taskId)
      case 'catalog': {
        if (query.catalog === 'tasks') return page((await this.taskCatalog.list()).filter((item) => matchesSearch(item, query.search)), query.page)
        if (query.catalog === 'datasets') return page(unique([...this.projection.runs.values()].map((run) => run.accepted.spec.taskPack.evaluatedSlice.dataset), (dataset) => dataset.manifestHash).filter((item) => matchesSearch(item, query.search)), query.page)
        if (query.catalog === 'task-packs') return page(unique([...this.projection.runs.values()].map((run) => run.accepted.spec.taskPack), (taskPack) => taskPack.evaluatedSlice.sliceManifestHash).filter((item) => matchesSearch(item, query.search)), query.page)
        if (query.catalog === 'agents') return page(unique([...this.projection.runs.values()].flatMap((run) => run.accepted.spec.agents), (agent) => agent.backendId + '|' + agent.agentVersion + '|' + agent.configHash).filter((item) => matchesSearch(item, query.search)), query.page)
        if (query.catalog === 'sandboxes') return page(unique([...this.projection.runs.values()].map((run) => run.accepted.spec.sandbox), (sandbox) => sandbox.provider + '|' + sandbox.imageDigest).filter((item) => matchesSearch(item, query.search)), query.page)
        if (query.catalog === 'verifiers') return page(unique([...this.projection.runs.values()].map((run) => run.accepted.spec.verification), (verification) => verification.verifierId + '|' + verification.verifierVersion).filter((item) => matchesSearch(item, query.search)), query.page)
        return page(unique([...this.projection.runs.values()].flatMap((run) => run.accepted.spec.analysis.detectorIds), (detector) => detector).filter((item) => matchesSearch(item, query.search)), query.page)
      }
      case 'artifacts': {
        const evidence = [...this.projection.trials.values()].filter((trial) => trial.runId === query.runId && (!query.trialId || trial.trialId === query.trialId)).flatMap((trial) => trial.evidence?.artifactManifest.entries ?? []).filter((entry) => (!query.mediaType || entry.mediaType === query.mediaType) && (!query.classification || entry.classification === query.classification))
        return page(evidence, query.page)
      }
      case 'leaderboard': {
        const view = query.view ?? 'active'
        const direction = query.sortDirection === 'asc' ? 1 : -1
        const sortBy = query.sortBy ?? 'primary_metric'
        const entries = [...this.projection.leaderboardEntries.values()]
          .filter((entry) => entry.evaluatedSlice.sliceManifestHash === query.sliceManifestHash)
          .filter((entry) => view === 'active' ? entry.status === 'active' : entry.status !== 'active')
          .filter((entry) => !query.agentType || entry.agent.type === query.agentType)
          .filter((entry) => !query.modelId || entry.model.modelId === query.modelId)
          .sort((left, right) => direction * (leaderboardSortValue(left, sortBy) - leaderboardSortValue(right, sortBy)) || left.entryId.localeCompare(right.entryId))
        return { ...page(entries, query.page), pivot: query.pivot, rankingGroups: [...new Set(entries.map((entry) => [entry.evaluatedSlice.sliceManifestHash, entry.verifierVersion, entry.repeatPolicyHash, entry.evidenceLevel].join('|')))] }
      }
      case 'defects': return page([...this.projection.defects.values()].filter((finding) => (!query.runId || finding.runId === query.runId) && (!query.category || finding.category === query.category) && (!query.status || finding.status === query.status)), query.page)
      case 'analysis-jobs': return page([...this.projection.analysisJobs.values()].filter((job) => (!query.runId || job.runId === query.runId) && (!query.state || job.state === query.state) && (!query.kind || job.kind === query.kind)), query.page)
      case 'analysis-job': return this.projection.analysisJobs.get(query.jobId) ?? null
      case 'analysis-output': return this.projection.analysisOutputs.get(query.jobId) ?? null
      case 'capability-vectors': {
        const methodologyVersion = query.methodologyVersion ?? CAPABILITY_METHODOLOGY_VERSION
        const vectors = [...this.projection.runs.values()]
          .filter((run) => run.state === 'completed' && (!query.runId || run.accepted.spec.runId === query.runId))
          .flatMap((run) => run.accepted.spec.agents
            .filter((agent) => !query.agentVariantId || agent.variantId === query.agentVariantId)
            .map((agent) => deriveCapabilityVector({
              runId: run.accepted.spec.runId, agentVariantId: agent.variantId, methodologyVersion,
              trials: run.trialIds.map((trialId) => this.projection.trials.get(trialId)).filter((trial) => trial?.agentVariantId === agent.variantId && trial.evidence).map((trial) => trial!.evidence!),
              findings: [...this.projection.defects.values()].filter((finding) => finding.runId === run.accepted.spec.runId),
            })))
          .sort((left, right) => left.runId.localeCompare(right.runId) || left.agentVariantId.localeCompare(right.agentVariantId))
        return page(vectors, query.page)
      }
      case 'failure-cluster-promotions': return page([...this.projection.failureClusterPromotions.values()].filter((promotion) => !query.runId || promotion.runId === query.runId), query.page)
      case 'reproductions': return page([...this.projection.reproductions.values()].filter((bundle) => !query.findingId || bundle.findingId === query.findingId), query.page)
      case 'regressions': return page([...this.projection.regressionPacks.values()], query.page)
      case 'regression-decisions': return page([...this.projection.regressionDecisions.values()], query.page)
      case 'insights': return page([...this.projection.insights.values()], query.page)
      case 'reports': return page([...this.projection.reports.values()].filter((report) => !query.runId || report.runRefs.includes(query.runId)), query.page)
      case 'audit': {
        const records = this.projection.auditRecords.filter((record) => (!query.actorId || record.actor.id === query.actorId) && (!query.operation || record.operation === query.operation) && (!query.resourceType || record.resourceType === query.resourceType))
        return { ...page(records, query.page), trusted: true, authority: { transactionCount: this.projection.transactionCount, tipHash: this.projection.lastTransactionHash } }
      }
      case 'retention': return page([...this.projection.retentionPolicies.values()], query.page)
      case 'deletion-impact': return await this.deletionImpact(query.runId)
      case 'workers': {
        const now = this.now().getTime()
        const sessions = [...this.projection.workers.values()].map((worker) => {
          const activeLeases = [...this.projection.leases.values()].filter((lease) => lease.state === 'active' && lease.lease.workerId === worker.registration.workerId)
          const stale = now - Date.parse(worker.heartbeatAt) > 30_000
          const readinessOk = !worker.registration.readiness || (worker.registration.readiness.sandboxes.every((entry) => entry.ok) && worker.registration.readiness.agents.every((entry) => entry.ok))
          const status = stale ? 'stale' : readinessOk ? 'ready' : 'degraded'
          return { ...worker, session: { status, activeLeaseCount: activeLeases.length, leaseIds: activeLeases.map((lease) => lease.lease.leaseId), heartbeatAgeMs: Math.max(0, now - Date.parse(worker.heartbeatAt)) } }
        }).filter((worker) => !query.status || worker.session.status === query.status)
        return page(sessions, query.page)
      }
      case 'archive-summary': {
        const runs = this.evidenceArchive.runSummaries()
        const trialCount = runs.reduce((total, run) => total + run.trialCount, 0)
        return {
          schemaVersion: 1, generatedAt: this.now().toISOString(), rootAvailable: this.evidenceArchive.rootAvailable,
          documentCount: this.evidenceArchive.documents.size, runCount: runs.length, trialCount,
          passedTrials: runs.reduce((total, run) => total + run.passedTrials, 0),
          failedTrials: runs.reduce((total, run) => total + run.failedTrials, 0),
          unknownTrials: runs.reduce((total, run) => total + run.unknownTrials, 0),
          conclusions: this.evidenceArchive.conclusions, latestRuns: runs.slice(0, 8),
        }
      }
      case 'archived-runs': return page(this.evidenceArchive.runSummaries().filter((run) => (!query.taskPackId || run.taskPackId === query.taskPackId) && (!query.state || run.state === query.state) && matchesSearch(run, query.search)), query.page)
      case 'archived-run': return this.evidenceArchive.runs.get(query.runId) ?? null
      case 'archive-documents': return page([...this.evidenceArchive.documents.values()].map(({ content: _content, ...document }) => document).filter((document) => (!query.runId || document.runIds.includes(query.runId)) && (!query.kind || document.kind === query.kind) && matchesSearch(document, query.search)), query.page)
      case 'archive-document': return this.evidenceArchive.document(query.documentId) ?? null
      case 'run-templates': return page(this.runTemplates, query.page)
    }
  }

  private async executeCommandExclusive(command: EvaluationCommand): Promise<CommittedAcknowledgement> {
    const commandHash = await sha256Hex(canonicalJson(command))
    const prior = this.projection.commandAcks.get(command.idempotencyKey)
    if (prior) {
      if (prior.hash !== commandHash) throw new Error('idempotency key collision with different command payload')
      return prior.acknowledgement
    }
    const at = this.now().toISOString()
    const records: JournalDomainRecord[] = []
    if (command.type === 'run.create') {
      if (this.projection.runs.has(command.spec.runId)) throw new Error('run already exists: ' + command.spec.runId)
      records.push(await this.requireCatalogPolicy(command.spec, 'run_admission', command.spec.runId, at))
      const accepted = await acceptEvaluationRunSpec(command.spec, at)
      records.push({ kind: 'run.accepted', accepted })
      records.push({ kind: 'event.appended', event: this.eventForNewRun(command.spec.runId, 'run.state', { state: 'draft' }, at) })
    } else if (command.type === 'run.start') {
      const run = this.requiredRun(command.runId)
      if (!['draft', 'blocked', 'interrupted'].includes(run.state)) throw new Error('run cannot start from state: ' + run.state)
      const taskIds = await this.taskCatalog.taskIdsForSlice(run.accepted.spec.taskPack.evaluatedSlice)
      let sequence = run.events.length
      for (const taskId of taskIds) {
        for (const agent of run.accepted.spec.agents) {
          for (let repeatIndex = 0; repeatIndex < run.accepted.spec.execution.repeats; repeatIndex += 1) {
            const trialId = run.accepted.spec.runId + ':' + taskId + ':' + agent.variantId + ':' + String(repeatIndex)
            const event = EvaluationEventSchema.parse({
              schemaVersion: 1, sequence, at, runId: command.runId, trialId, type: 'trial.created', producer: 'control-plane',
              data: { trialId, taskId, agentVariantId: agent.variantId, backendId: agent.backendId, sandboxProvider: run.accepted.spec.sandbox.provider, repeatIndex },
            })
            records.push({ kind: 'event.appended', event })
            sequence += 1
          }
        }
      }
      for (const state of ['validating', 'preparing', 'running'] as const) {
        records.push({ kind: 'event.appended', event: EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: command.runId, type: 'run.state', producer: 'control-plane', data: { state } }) })
        sequence += 1
      }
    } else if (command.type === 'run.cancel') {
      const run = this.requiredRun(command.runId)
      if (terminalRunState(run.state)) throw new Error('run is already terminal: ' + run.state)
      let sequence = run.events.length
      for (const trialId of run.trialIds) {
        const trial = this.projection.trials.get(trialId)!
        if (terminalTrialState(trial.state)) continue
        records.push({ kind: 'event.appended', event: EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: command.runId, trialId, type: 'trial.state', producer: 'control-plane', data: { trialId, state: 'cancelled', reason: command.reason } }) })
        sequence += 1
        if (trial.activeLeaseId) records.push({ kind: 'lease.closed', leaseId: trial.activeLeaseId, at, reason: 'cancelled' })
      }
      records.push({ kind: 'event.appended', event: EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: command.runId, type: 'run.state', producer: 'control-plane', data: { state: 'cancelled', reason: command.reason } }) })
    } else if (command.type === 'trial.retry') {
      const run = this.requiredRun(command.runId)
      let sequence = run.events.length
      for (const trialId of command.trialIds) {
        const trial = this.projection.trials.get(trialId)
        if (!trial || trial.runId !== command.runId) throw new Error('unknown trial for run: ' + trialId)
        if (!terminalTrialState(trial.state) || trial.state === 'completed') throw new Error('trial is not eligible for selective retry: ' + trialId)
        if (trial.state === 'indeterminate' && command.indeterminateSideEffectConfirmation !== 'retry-indeterminate:' + trialId) throw new Error('indeterminate side effects require exact selective-retry confirmation: ' + trialId)
        if (trial.attempt >= run.accepted.spec.execution.retryPolicy.maxAttempts) throw new Error('trial exhausted maximum attempts: ' + trialId)
        records.push({ kind: 'event.appended', event: EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: command.runId, trialId, type: 'trial.state', producer: 'control-plane', data: { trialId, state: 'queued', retryNotBefore: at, requestedBy: command.commandId } }) }); sequence += 1
      }
      if (run.state === 'failed' || run.state === 'blocked' || run.state === 'interrupted') {
        for (const state of ['validating', 'preparing', 'running'] as const) {
          records.push({ kind: 'event.appended', event: EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: command.runId, type: 'run.state', producer: 'control-plane', data: { state, reason: 'selective_retry' } }) })
          sequence += 1
        }
      }
    } else if (command.type === 'run.grade') {
      const run = this.requiredRun(command.runId)
      const trials = run.trialIds.map((trialId) => this.projection.trials.get(trialId)!)
      if (trials.length === 0 || trials.some((trial) => trial.state !== 'completed' || !trial.evidence)) throw new Error('grading requires completed canonical evidence for every trial')
      const inputs = trials.map((trial) => ({ trialId: trial.trialId, resultHash: trial.evidence!.resultHash, verifierVersion: trial.evidence!.benchmarkResult.verifierVersion })).sort((left, right) => left.trialId.localeCompare(right.trialId))
      const inputManifestHash = await sha256Hex(canonicalJson({ schemaVersion: 1, runId: command.runId, specHash: run.accepted.specHash, verifier: run.accepted.spec.verification, inputs }))
      const jobId = 'grading-' + command.commandId
      records.push({ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({
        schemaVersion: 1, protocolVersion: 1, jobId, runId: command.runId, kind: 'grading', inputRefs: inputs.map((input) => 'trial-result:' + input.resultHash), inputManifestHash,
        implementationId: run.accepted.spec.verification.verifierId, implementationVersion: run.accepted.spec.verification.verifierVersion, configHash: run.accepted.spec.verification.configHash,
        attempt: 0, state: 'queued', createdAt: at, updatedAt: at,
      }) })
      records.push({ kind: 'event.appended', event: this.event(command.runId, 'command.requested', { commandType: command.type, commandId: command.commandId }) })
    } else if (command.type === 'run.analyze') {
      const run = this.requiredRun(command.runId)
      if (run.state !== 'completed') throw new Error('analysis requires a completed canonical run')
      const declared = new Set(run.accepted.spec.analysis.detectorIds)
      const detectorIds = [...new Set(command.detectorIds)].sort()
      if (detectorIds.length !== command.detectorIds.length) throw new Error('analysis detector IDs must be unique')
      for (const detectorId of detectorIds) if (!declared.has(detectorId)) throw new Error('analysis detector is not declared by the immutable run spec: ' + detectorId)
      const trials = run.trialIds.map((trialId) => this.projection.trials.get(trialId)!)
      if (trials.some((trial) => trial.state !== 'completed' || !trial.evidence)) throw new Error('analysis requires completed canonical evidence for every trial')
      const inputs = trials.map((trial) => ({ trialId: trial.trialId, resultHash: trial.evidence!.resultHash, artifactManifestHash: trial.evidence!.artifactManifest.manifestHash })).sort((left, right) => left.trialId.localeCompare(right.trialId))
      const inputManifestHash = await sha256Hex(canonicalJson({ schemaVersion: 1, runId: command.runId, specHash: run.accepted.specHash, detectorIds, inputs }))
      const jobId = 'analysis-' + command.commandId
      if (this.projection.analysisJobs.has(jobId)) throw new Error('analysis job already exists: ' + jobId)
      records.push({ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({
        schemaVersion: 1, protocolVersion: 1, jobId, runId: command.runId, kind: 'detectors',
        inputRefs: inputs.map((input) => 'trial-result:' + input.resultHash), inputManifestHash,
        implementationId: 'eval-analyzer', implementationVersion: '0.0.0', configHash: run.accepted.spec.analysis.configHash,
        detectorIds, attempt: 0, state: 'queued', createdAt: at, updatedAt: at,
      }) })
      records.push({ kind: 'event.appended', event: this.event(command.runId, 'command.requested', { commandType: command.type, commandId: command.commandId }) })
    } else if (command.type === 'run.align' || command.type === 'run.cluster' || command.type === 'run.counterfactual') {
      const run = this.requiredRun(command.runId)
      if (run.state !== 'completed') throw new Error('analysis requires a completed canonical run')
      const trials = run.trialIds.map((trialId) => this.projection.trials.get(trialId)!)
      if (trials.some((trial) => trial.state !== 'completed' || !trial.evidence)) throw new Error('analysis requires completed canonical evidence for every trial')
      if (command.type === 'run.align' && trials.length < 2) throw new Error('trace alignment requires at least two completed trials')
      if (command.type === 'run.counterfactual' && !trials.some((trial) => trial.trialId === command.request.sourceTrialId)) throw new Error('counterfactual source trial is outside the run')
      if (command.type === 'run.counterfactual') {
        const source = trials.find((trial) => trial.trialId === command.request.sourceTrialId)!
        if (command.request.checkpointSequence >= source.evidence!.normalizedEventCount) throw new Error('counterfactual checkpoint is outside the source trace')
        const entry = source.evidence!.artifactManifest.entries.find((candidate) => candidate.path === source.evidence!.analyzerInputRef)
        if (!entry) throw new Error('counterfactual source analyzer input is absent from canonical evidence')
        const artifact = await this.artifactStore.readEntry(entry)
        const sourceInput = AnalyzerInputSchema.parse(parseAnalysisJson(artifact.content, 'counterfactual source input'))
        const { inputManifestHash: _inputManifestHash, ...unsignedSourceInput } = sourceInput
        if (sourceInput.runId !== command.runId || sourceInput.trialId !== source.trialId || await sha256Hex(canonicalJson(unsignedSourceInput)) !== sourceInput.inputManifestHash) throw new Error('counterfactual source input authority mismatch')
        if (sourceInput.verifierIntegrity.passed) throw new Error('counterfactual continuation requires a failed source trial')
        if (await counterfactualFailureFingerprint(sourceInput.events, command.request.checkpointSequence) !== command.request.sourceFailureFingerprint) throw new Error('counterfactual source failure fingerprint mismatch')
      }
      const kind = command.type === 'run.align' ? 'trace-alignment' : command.type === 'run.cluster' ? 'clustering' : 'counterfactual'
      const inputs = trials.map((trial) => ({ trialId: trial.trialId, resultHash: trial.evidence!.resultHash, artifactManifestHash: trial.evidence!.artifactManifest.manifestHash })).sort((left, right) => left.trialId.localeCompare(right.trialId))
      const request = command.type === 'run.counterfactual' ? command.request : undefined
      const inputManifestHash = await sha256Hex(canonicalJson({ schemaVersion: 1, runId: command.runId, specHash: run.accepted.specHash, kind, inputs, ...(request ? { request } : {}) }))
      const jobId = kind + '-' + command.commandId
      records.push({ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({
        schemaVersion: 1, protocolVersion: 1, jobId, runId: command.runId, kind,
        inputRefs: inputs.map((input) => 'trial-result:' + input.resultHash), inputManifestHash, implementationId: 'eval-analyzer', implementationVersion: '0.0.0',
        configHash: run.accepted.spec.analysis.configHash, ...(request ? { counterfactualRequest: request } : {}),
        attempt: 0, state: 'queued', createdAt: at, updatedAt: at,
      }) })
      records.push({ kind: 'event.appended', event: this.event(command.runId, 'command.requested', { commandType: command.type, commandId: command.commandId }) })
    } else if (command.type === 'analysis.job.start') {
      const job = this.requiredAnalysisJob(command.jobId)
      if (job.state !== 'queued') throw new Error('analysis job cannot start from state: ' + job.state)
      const leaseExpiresAt = new Date(this.now().getTime() + command.leaseMs).toISOString()
      records.push({ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({ ...job, state: 'running', generation: (job.generation ?? 0) + 1, leaseToken: this.commitToken(), executorId: command.executorId, startedAt: at, heartbeatAt: at, leaseExpiresAt, updatedAt: at }) })
    } else if (command.type === 'analysis.job.heartbeat') {
      const job = this.requiredAnalysisJob(command.jobId)
      if (job.state !== 'running' || job.executorId !== command.executorId) throw new Error('analysis job heartbeat does not match active job authority')
      this.assertAnalysisLease(job, command)
      if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= this.now().getTime()) throw new Error('analysis job lease has expired')
      const leaseExpiresAt = new Date(this.now().getTime() + command.leaseMs).toISOString()
      records.push({ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({ ...job, heartbeatAt: at, leaseExpiresAt, updatedAt: at }) })
    } else if (command.type === 'analysis.job.complete') {
      const job = this.requiredAnalysisJob(command.jobId)
      if (job.state !== 'running') throw new Error('analysis job cannot complete from state: ' + job.state)
      if (job.executorId !== command.executorId) throw new Error('analysis job executor mismatch')
      this.assertAnalysisLease(job, command)
      if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= this.now().getTime()) throw new Error('analysis job lease has expired')
      const output = AnalysisOutputManifestSchema.parse(command.outputManifest)
      if (output.jobId !== job.jobId || output.runId !== job.runId || output.inputManifestHash !== job.inputManifestHash) throw new Error('analysis output manifest authority mismatch')
      const { manifestHash: _manifestHash, ...unsignedOutput } = output
      if (await sha256Hex(canonicalJson(unsignedOutput)) !== output.manifestHash) throw new Error('analysis output manifest hash mismatch')
      const findings: import('@agent-kernel/eval-protocol').DefectFinding[] = []
      const derivedTraceTrialIds = new Set<string>()
      const gradingTrialIds = new Set<string>()
      const counterfactualInterventions = new Set<string>()
      for (const artifact of output.outputs) {
        if (!artifact.artifactRef.startsWith('analysis/' + job.jobId + '/')) throw new Error('analysis output artifact is outside job prefix')
        const stored = await this.artifactStore.readRegisteredFile({ path: artifact.artifactRef, mediaType: artifact.mediaType, bytes: artifact.bytes, sha256: artifact.sha256 })
        if (artifact.kind === 'finding') {
          let parsed: unknown
          try { parsed = JSON.parse(stored.content.toString('utf8')) } catch { throw new Error('analysis finding artifact must contain valid JSON') }
          const finding = DefectFindingSchema.parse(parsed)
          if (finding.runId !== job.runId || !this.projection.trials.has(finding.trialId)) throw new Error('analysis finding authority mismatch')
          if (this.projection.defects.has(finding.findingId)) throw new Error('analysis finding already exists: ' + finding.findingId)
          findings.push(finding)
        } else if (artifact.kind === 'trace') {
          if (job.kind !== 'detectors' || artifact.mediaType !== 'application/x-ndjson') throw new Error('derived analyzer trace requires a detector job and NDJSON media type')
          const trace = parseTrialTraceJsonl(stored.content.toString('utf8'))
          const trial = this.projection.trials.get(trace.trialId)
          const sourceEntry = trial?.evidence?.traceRef ? trial.evidence.artifactManifest.entries.find((entry) => entry.path === trial.evidence!.traceRef) : undefined
          if (!trial?.evidence || trial.runId !== job.runId || !sourceEntry || !job.inputRefs.includes('trial-result:' + trial.evidence.resultHash)) throw new Error('derived analyzer trace authority mismatch')
          const source = parseTrialTraceJsonl((await this.artifactStore.readEntry(sourceEntry)).content.toString('utf8'))
          if (trace.traceId !== source.traceId || trace.spans.length !== source.spans.length + 1 || canonicalJson(trace.spans.slice(0, source.spans.length)) !== canonicalJson(source.spans)) throw new Error('derived analyzer trace must append to the immutable source trace')
          const added = trace.spans.slice(source.spans.length)
          if (added.length !== 1 || added[0]!.name !== 'analyzer.detect') throw new Error('derived analyzer trace requires exactly one analyzer.detect span')
          const findingRefs = new Set(output.outputs.filter((candidate) => candidate.kind === 'finding').map((candidate) => candidate.artifactRef))
          if (added[0]!.artifactRefs.some((reference) => !findingRefs.has(reference))) throw new Error('analyzer trace references an undeclared finding artifact')
          if (derivedTraceTrialIds.has(trace.trialId)) throw new Error('detector output contains duplicate derived trial traces')
          derivedTraceTrialIds.add(trace.trialId)
        } else if (artifact.kind === 'trace-alignment') {
          if (job.kind !== 'trace-alignment') throw new Error('trace alignment output requires a trace-alignment job')
          const alignment = TraceAlignmentResultSchema.parse(parseAnalysisJson(stored.content, 'trace alignment'))
          for (const trialId of [alignment.leftTrialId, alignment.rightTrialId]) {
            const trial = this.projection.trials.get(trialId)
            if (!trial || trial.runId !== job.runId || !trial.evidence || !job.inputRefs.includes('trial-result:' + trial.evidence.resultHash)) throw new Error('trace alignment authority mismatch')
          }
        } else if (artifact.kind === 'failure-cluster') {
          if (job.kind !== 'clustering') throw new Error('failure cluster output requires a clustering job')
          const cluster = FailureClusterSchema.parse(parseAnalysisJson(stored.content, 'failure cluster'))
          if (cluster.status !== 'unknown') throw new Error('analyzer clusters cannot enter the canonical taxonomy without human promotion')
          for (const findingId of cluster.memberFindingIds) {
            const finding = this.projection.defects.get(findingId)
            if (!finding || finding.runId !== job.runId || finding.category !== 'unknown') throw new Error('failure cluster member authority mismatch')
          }
        } else if (artifact.kind === 'counterfactual') {
          if (job.kind !== 'counterfactual' || !job.counterfactualRequest) throw new Error('counterfactual output requires a counterfactual job')
          const result = CounterfactualResultSchema.parse(parseAnalysisJson(stored.content, 'counterfactual result'))
          if (result.sourceTrialId !== job.counterfactualRequest.sourceTrialId || result.checkpointSequence !== job.counterfactualRequest.checkpointSequence) throw new Error('counterfactual result authority mismatch')
          const intervention = job.counterfactualRequest.interventions.find((candidate) => candidate.kind === result.intervention)
          if (!intervention) throw new Error('counterfactual intervention is outside the immutable request')
          const sourceTrial = this.projection.trials.get(result.sourceTrialId)
          const sourceEntry = sourceTrial?.evidence?.artifactManifest.entries.find((entry) => entry.path === sourceTrial.evidence!.analyzerInputRef)
          if (!sourceTrial?.evidence || sourceTrial.runId !== job.runId || !sourceEntry || !job.inputRefs.includes('trial-result:' + sourceTrial.evidence.resultHash)) throw new Error('counterfactual source evidence authority mismatch')
          const sourceArtifact = await this.artifactStore.readEntry(sourceEntry)
          const sourceInput = AnalyzerInputSchema.parse(parseAnalysisJson(sourceArtifact.content, 'counterfactual source input'))
          const { inputManifestHash: _inputManifestHash, ...unsignedSourceInput } = sourceInput
          if (sourceInput.runId !== job.runId || sourceInput.trialId !== sourceTrial.trialId || await sha256Hex(canonicalJson(unsignedSourceInput)) !== sourceInput.inputManifestHash) throw new Error('counterfactual source input hash mismatch')
          const checkpointHash = await sha256Hex(canonicalJson(sourceInput.events.slice(0, result.checkpointSequence + 1)))
          if (result.checkpointHash !== checkpointHash) throw new Error('counterfactual checkpoint hash mismatch')
          const verification = {
            passed: result.outcome === 'resolved',
            ...(result.outcome === 'infrastructure_error' ? { infrastructureError: true } : {}),
            evidenceRefs: result.evidenceRefs,
          }
          const continuationHash = await sha256Hex(canonicalJson({ checkpointHash, intervention, continuationEvents: result.continuationEvents, verification }))
          if (result.continuationHash !== continuationHash) throw new Error('counterfactual continuation hash mismatch')
          if (result.outcome === 'same_failure' && result.observedFailureFingerprint !== job.counterfactualRequest.sourceFailureFingerprint) throw new Error('counterfactual same-failure fingerprint mismatch')
          if (result.outcome === 'different_failure' && result.observedFailureFingerprint === job.counterfactualRequest.sourceFailureFingerprint) throw new Error('counterfactual different-failure fingerprint mismatch')
          if (counterfactualInterventions.has(result.intervention)) throw new Error('duplicate counterfactual intervention output: ' + result.intervention)
          counterfactualInterventions.add(result.intervention)
        } else if (artifact.kind === 'grading-result') {
          if (job.kind !== 'grading') throw new Error('grading output requires a grading job')
          let parsed: unknown
          try { parsed = JSON.parse(stored.content.toString('utf8')) } catch { throw new Error('grading result artifact must contain valid JSON') }
          const grading = GradingResultSchema.parse(parsed)
          const trial = this.projection.trials.get(grading.trialId)
          if (grading.jobId !== job.jobId || grading.runId !== job.runId || !trial || trial.runId !== job.runId || !trial.evidence) throw new Error('grading result authority mismatch')
          if (grading.taskId !== trial.taskId || grading.agentVariantId !== trial.agentVariantId || grading.sourceResultHash !== trial.evidence.resultHash || grading.sourceArtifactManifestHash !== trial.evidence.artifactManifest.manifestHash) throw new Error('grading result trial evidence mismatch')
          const raw = trial.evidence.artifactManifest.entries.find((entry) => entry.path === trial.evidence!.benchmarkResult.rawResultRef)
          if (!raw || grading.rawArtifactSha256 !== raw.sha256 || canonicalJson(grading.benchmarkResult) !== canonicalJson(trial.evidence.benchmarkResult) || grading.evidenceLevel !== trial.evidence.evidenceLevel) throw new Error('grading result does not match canonical verifier evidence')
          const policy = this.requiredRun(job.runId).accepted.spec.verification
          if (grading.officialRequired !== policy.officialRequired || grading.benchmarkResult.verifierId !== policy.verifierId || grading.benchmarkResult.verifierVersion !== policy.verifierVersion) throw new Error('grading result does not match immutable verifier policy')
          if (!job.inputRefs.includes('trial-result:' + grading.sourceResultHash)) throw new Error('grading result is outside immutable job inputs')
          if (gradingTrialIds.has(grading.trialId)) throw new Error('duplicate grading result for trial: ' + grading.trialId)
          gradingTrialIds.add(grading.trialId)
        }
      }
      if (job.kind === 'grading') {
        const expected = new Set(this.requiredRun(job.runId).trialIds)
        if (output.outputs.some((artifact) => artifact.kind !== 'grading-result') || gradingTrialIds.size !== expected.size || [...expected].some((trialId) => !gradingTrialIds.has(trialId))) throw new Error('grading output must cover every canonical trial exactly once')
      }
      if (job.kind === 'detectors') {
        const expectedTraceTrials = [...this.projection.trials.values()].filter((trial) => trial.runId === job.runId && trial.evidence?.traceRef && job.inputRefs.includes('trial-result:' + trial.evidence.resultHash))
        if (expectedTraceTrials.some((trial) => !derivedTraceTrialIds.has(trial.trialId))) throw new Error('detector output must include one derived trace per trace-bearing input trial')
        if (output.outputs.some((artifact) => artifact.kind !== 'finding' && artifact.kind !== 'trace')) throw new Error('detector jobs may emit only findings and derived traces')
      }
      if (job.kind === 'trace-alignment' && (output.outputs.length === 0 || output.outputs.some((artifact) => artifact.kind !== 'trace-alignment'))) throw new Error('trace-alignment jobs require only trace alignment outputs')
      if (job.kind === 'clustering' && (output.outputs.length === 0 || output.outputs.some((artifact) => artifact.kind !== 'failure-cluster'))) throw new Error('clustering jobs require one or more failure cluster outputs')
      if (job.kind === 'counterfactual' && (
        output.outputs.length !== job.counterfactualRequest!.interventions.length
        || output.outputs.some((artifact) => artifact.kind !== 'counterfactual')
        || job.counterfactualRequest!.interventions.some((intervention) => !counterfactualInterventions.has(intervention.kind))
      )) throw new Error('counterfactual jobs require one output per requested intervention')
      const outputManifestBody = Buffer.from(canonicalJson(output))
      await this.artifactStore.writeIdempotent('analysis/' + job.jobId + '/output-manifest.json', outputManifestBody, await sha256Hex(outputManifestBody))
      records.push({ kind: 'analysis-output.recorded', manifest: output })
      records.push(...findings.map((finding) => ({ kind: 'defect.recorded' as const, finding })))
      records.push({ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({ ...job, state: 'completed', finishedAt: at, updatedAt: at, outputManifestRef: 'analysis/' + job.jobId + '/output-manifest.json', outputManifestHash: output.manifestHash }) })
    } else if (command.type === 'analysis.job.fail') {
      const job = this.requiredAnalysisJob(command.jobId)
      if (job.state !== 'running') throw new Error('analysis job cannot fail from state: ' + job.state)
      if (job.executorId !== command.executorId) throw new Error('analysis job executor mismatch')
      this.assertAnalysisLease(job, command)
      if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= this.now().getTime()) throw new Error('analysis job lease has expired')
      records.push({ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({ ...job, state: 'failed', finishedAt: at, updatedAt: at, failure: command.failure }) })
    } else if (command.type === 'analysis.job.cancel') {
      const job = this.requiredAnalysisJob(command.jobId)
      if (job.state !== 'queued' && job.state !== 'running') throw new Error('analysis job cannot cancel from state: ' + job.state)
      records.push({ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({ ...job, state: 'cancelled', finishedAt: at, updatedAt: at, failure: { code: 'ANALYSIS_CANCELLED', summary: command.reason } }) })
    } else if (command.type === 'leaderboard.publish') {
      const publicationRun = this.requiredRun(command.runId)
      records.push(await this.requireCatalogPolicy(publicationRun.accepted.spec, 'leaderboard_publication', command.runId, at))
      const entries = await this.leaderboardEntriesForRun(command.runId, at)
      const newKeys = new Set(entries.map(leaderboardCompetitorKey))
      const superseded = [...this.projection.leaderboardEntries.values()].filter((entry) => entry.status === 'active' && newKeys.has(leaderboardCompetitorKey(entry)) && !entries.some((candidate) => candidate.entryId === entry.entryId))
      records.push(...superseded.map((entry) => ({ kind: 'leaderboard.status.changed' as const, entry: LeaderboardEntrySchema.parse({ ...entry, status: 'superseded' }), reason: 'replaced by a newer canonical publication for the same competitor identity' })))
      records.push(...entries.map((entry) => ({ kind: 'leaderboard.published' as const, entry })))
      records.push({ kind: 'event.appended', event: this.event(command.runId, 'leaderboard.published', { entryIds: entries.map((entry) => entry.entryId) }) })
    } else if (command.type === 'leaderboard.invalidate') {
      const entry = this.projection.leaderboardEntries.get(command.entryId)
      if (!entry) throw new Error('unknown Leaderboard entry: ' + command.entryId)
      if (entry.status === 'invalidated') throw new Error('Leaderboard entry is already invalidated')
      records.push({ kind: 'leaderboard.status.changed', entry: LeaderboardEntrySchema.parse({ ...entry, status: 'invalidated' }), reason: command.reason })
    } else if (command.type === 'defect.record') {
      const trial = this.projection.trials.get(command.finding.trialId)
      if (!trial || trial.runId !== command.finding.runId || !trial.evidence) throw new Error('defect finding must reference canonical trial evidence')
      records.push({ kind: 'defect.recorded', finding: command.finding })
    } else if (command.type === 'failure-cluster.promote') {
      const job = this.requiredAnalysisJob(command.sourceJobId)
      if (job.runId !== command.runId || job.kind !== 'clustering' || job.state !== 'completed') throw new Error('cluster promotion requires a completed canonical clustering job')
      const output = this.projection.analysisOutputs.get(job.jobId)
      const entry = output?.outputs.find((candidate) => candidate.kind === 'failure-cluster' && candidate.outputId === command.clusterId)
      if (!entry) throw new Error('unknown canonical failure cluster: ' + command.clusterId)
      const stored = await this.artifactStore.readRegisteredFile({ path: entry.artifactRef, mediaType: entry.mediaType, bytes: entry.bytes, sha256: entry.sha256 })
      const cluster = FailureClusterSchema.parse(parseAnalysisJson(stored.content, 'failure cluster'))
      if (cluster.status !== 'unknown' || cluster.clusterId !== command.clusterId) throw new Error('only an unknown canonical cluster can be promoted')
      const promotionId = 'promotion-' + command.commandId
      records.push({ kind: 'failure-cluster.promotion.recorded', promotion: FailureClusterPromotionSchema.parse({
        schemaVersion: 1, promotionId, sourceJobId: job.jobId, runId: command.runId,
        cluster: { ...cluster, status: 'human_named', humanName: command.humanName, promotedCategory: command.promotedCategory },
        promotedBy: command.promotedBy, promotedAt: at,
      }) })
    } else if (command.type === 'defect.promote') {
      const finding = this.projection.defects.get(command.findingId)
      if (!finding || finding.status !== 'human_validated') throw new Error('only human-validated defects can be promoted')
      if (command.pack.promotionSourceFindingId !== command.findingId || command.reproduction.findingId !== command.findingId) throw new Error('promotion resources must reference the same defect finding')
      await this.verifyReproductionForPromotion(command.reproduction)
      records.push({ kind: 'defect.recorded', finding: { ...finding, status: 'promoted' } })
      records.push({ kind: 'reproduction.recorded', bundle: command.reproduction })
      records.push({ kind: 'regression-pack.recorded', pack: command.pack })
    } else if (command.type === 'regression.evaluate') {
      const decision = { ...this.evaluateRegression(command), baselineRunId: command.baseline.runId, candidateRunId: command.candidate.runId }
      records.push({ kind: 'regression-decision.recorded', decision })
    } else if (command.type === 'report.generate') {
      if (this.projection.reports.has(command.reportId)) throw new Error('report already exists: ' + command.reportId)
      for (const runId of command.runIds) records.push(await this.requireCatalogPolicy(this.requiredRun(runId).accepted.spec, 'report_publication', runId, at))
      const report = await this.generateReport(command.reportId, command.runIds, command.methodologyVersion, at)
      records.push({ kind: 'report.recorded', report: report.manifest })
    } else if (command.type === 'retention.set') {
      records.push({ kind: 'retention.recorded', policy: command.policy })
    } else if (command.type === 'run.delete') {
      const { impact, artifactPaths } = await this.deletionPlan(command.runId)
      if (command.confirmation !== 'delete:' + command.runId) throw new Error('run deletion requires exact destructive confirmation')
      if (command.expectedImpactHash !== impact.impactHash) throw new Error('run deletion impact changed; fetch a fresh impact preview')
      if (impact.blockedByRefs.length > 0) throw new Error('run deletion is blocked by protected references')
      records.push({ kind: 'run.deleted', impact, artifactPaths, deletedAt: at })
    } else if (command.type === 'insight.record') {
      const pack = this.projection.regressionPacks.get(command.insight.regressionPackId)
      if (!pack) throw new Error('insight regression pack is not registered')
      if (command.insight.status === 'validated') {
        const candidateRun = this.projection.runs.get(command.insight.postFixCandidateRunId!)
        const gate = this.projection.regressionDecisions.get(command.insight.postFixGateId!)
        if (!candidateRun || candidateRun.state !== 'completed') throw new Error('validated insight post-fix candidate run must be completed')
        if (pack.taskPackRef !== candidateRun.accepted.spec.taskPack.id + '@' + candidateRun.accepted.spec.taskPack.version) throw new Error('validated insight candidate run must use the same regression pack task pack')
        if (!gate || gate.decision !== 'pass' || gate.candidateRunId !== command.insight.postFixCandidateRunId) throw new Error('validated insight requires a passing gate for its post-fix candidate run')
        if (!command.insight.postFixValidationRefs.includes(gate.gateId)) throw new Error('validated insight post-fix evidence must include its passing gate')
      }
      records.push({ kind: 'insight.recorded', insight: command.insight })
    }
    const transactionSequence = this.projection.transactionCount
    const acknowledgement = CommittedAcknowledgementSchema.parse({ schemaVersion: 1, idempotencyKey: command.idempotencyKey, commandId: command.commandId, committedSequence: transactionSequence, committedAt: at, projectionVersion: transactionSequence + 1 })
    records.push({ kind: 'command.acknowledged', commandHash, acknowledgement })
    await this.commit(records, command.commandId, at)
    if (command.type === 'run.delete') {
      const deletion = this.projection.deletedRuns.get(command.runId)!
      await this.artifactStore.deleteFiles(deletion.artifactPaths)
      const completedAt = this.now().toISOString()
      await this.commit([{ kind: 'run.deletion.completed', runId: command.runId, completedAt }], 'run-deletion-complete-' + command.runId, completedAt)
    }
    return acknowledgement
  }

  private nextCompatibleQueuedTrial(worker: WorkerRegistration) {
    const now = this.now().getTime()
    return [...this.projection.trials.values()]
      .filter((trial) => {
        const run = this.projection.runs.get(trial.runId)!
        const activeForRun = [...this.projection.leases.values()].filter((lease) => lease.state === 'active' && lease.lease.runId === trial.runId).length
        const activeForBackend = [...this.projection.leases.values()].filter((lease) => lease.state === 'active' && lease.lease.runId === trial.runId && this.projection.trials.get(lease.lease.trialId)?.backendId === trial.backendId).length
        const activeForProvider = [...this.projection.leases.values()].filter((lease) => lease.state === 'active' && lease.lease.runId === trial.runId && this.projection.trials.get(lease.lease.trialId)?.sandboxProvider === trial.sandboxProvider).length
        return run.state === 'running' && trial.state === 'queued' && (!trial.retryNotBefore || Date.parse(trial.retryNotBefore) <= now) && activeForRun < run.accepted.spec.execution.maxConcurrency && activeForBackend < run.accepted.spec.execution.maxConcurrencyPerBackend && activeForProvider < run.accepted.spec.execution.maxConcurrencyPerProvider && workerSupportsRun(worker, run.accepted.spec) && this.runWithinBudgets(run)
      })
      .sort((left, right) => {
        const leftRun = this.projection.runs.get(left.runId)!
        const rightRun = this.projection.runs.get(right.runId)!
        return rightRun.accepted.spec.execution.priority - leftRun.accepted.spec.execution.priority || (leftRun.lastLeaseSequence ?? -1) - (rightRun.lastLeaseSequence ?? -1) || leftRun.createdSequence - rightRun.createdSequence || left.attempt - right.attempt || left.trialId.localeCompare(right.trialId)
      })[0] ?? null
  }

  private async recoverExpiredLeases(): Promise<number> {
    const now = this.now()
    let expired = 0
    for (const leaseProjection of [...this.projection.leases.values()]) {
      if (leaseProjection.state !== 'active' || Date.parse(leaseProjection.expiresAt) > now.getTime()) continue
      const { lease, executionReceipt } = leaseProjection
      const trial = this.projection.trials.get(lease.trialId)!
      const run = this.projection.runs.get(lease.runId)!
      const retryAllowed = executionReceipt === 'none' && trial.attempt < run.accepted.spec.execution.retryPolicy.maxAttempts
      const state = retryAllowed ? 'queued' : executionReceipt === 'none' ? 'environment_error' : 'indeterminate'
      const reason = retryAllowed ? 'expired_retryable' : 'expired_indeterminate'
      const at = now.toISOString()
      const retryNotBefore = retryAllowed ? new Date(now.getTime() + run.accepted.spec.execution.retryPolicy.backoffMs).toISOString() : undefined
      const failure = executionReceipt === 'none' ? undefined : { schemaVersion: 1 as const, ...decideFailureResponsibility({ category: 'indeterminate_side_effect', origin: 'unknown', observedStateSufficientForRecovery: false, sideEffectMayHaveOccurred: true, retryRequested: false }), code: 'LEASE_EXPIRED_AFTER_EFFECT', summary: 'lease expired after an execution effect may have started', evidenceRefs: ['lease:' + lease.leaseId] }
      const event = this.event(lease.runId, 'trial.state', { trialId: lease.trialId, state, leaseId: lease.leaseId, ...(retryNotBefore ? { retryNotBefore } : {}) }, lease.trialId, lease.leaseId, at)
      const enriched = failure ? EvaluationEventSchema.parse({ ...event, failure }) : event
      await this.commit([{ kind: 'lease.closed', leaseId: lease.leaseId, at, reason }, { kind: 'event.appended', event: enriched }], 'lease-expire-' + lease.leaseId, at)
      expired += 1
    }
    return expired
  }

  async expireAnalysisJobs(): Promise<number> {
    return await this.mutate(async () => {
      let expired = 0
      const at = this.now().toISOString()
      for (const job of [...this.projection.analysisJobs.values()]) {
        if (job.state !== 'running' || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > this.now().getTime()) continue
        await this.commit([{ kind: 'analysis-job.recorded', job: AnalysisJobSchema.parse({
          ...job, state: 'queued', attempt: job.attempt + 1, updatedAt: at,
          executorId: undefined, startedAt: undefined, heartbeatAt: undefined, leaseExpiresAt: undefined, leaseToken: undefined,
        }) }], 'analysis-expire-' + job.jobId + '-' + String(job.attempt), at)
        expired += 1
      }
      return expired
    })
  }

  private async persistCatalogRegistrations(): Promise<void> {
    if (!(this.taskCatalog instanceof RegisteredTaskCatalog)) return
    for (const registration of this.taskCatalog.registrations()) {
      if (this.projection.catalogSlices.has(registration.sliceManifestHash)) continue
      const taskIdsHash = await sha256Hex(canonicalJson(registration.taskIds))
      const at = this.now().toISOString()
      await this.commit([{ kind: 'catalog.slice.registered', sliceManifestHash: registration.sliceManifestHash, taskIdsHash, taskIds: [...registration.taskIds], tasks: [...registration.tasks] }], 'catalog-register-' + registration.sliceManifestHash, at)
    }
  }

  private async leaderboardEntriesForRun(runId: string, publishedAt: string): Promise<LeaderboardEntry[]> {
    const run = this.requiredRun(runId)
    if (run.state !== 'completed') throw new Error('only completed runs can be published')
    const trials = run.trialIds.map((trialId) => this.projection.trials.get(trialId)!)
    if (trials.some((trial) => trial.state !== 'completed' || !trial.evidence)) throw new Error('every expected trial must have completed canonical evidence')
    const expectedPerAgent = run.accepted.spec.taskPack.evaluatedSlice.selectedItems * run.accepted.spec.execution.repeats
    const repeatPolicyHash = await sha256Hex(canonicalJson({ repeats: run.accepted.spec.execution.repeats, analysisRepeatsRequired: run.accepted.spec.analysis.repeatsRequired }))
    return await Promise.all(run.accepted.spec.agents.map(async (agent) => {
      const agentTrials = trials.filter((trial) => trial.agentVariantId === agent.variantId)
      if (agentTrials.length !== expectedPerAgent) throw new Error('completed trial coverage does not match immutable evaluated slice for ' + agent.variantId)
      const evidence = agentTrials.map((trial) => trial.evidence!)
      if (evidence.some((result) => result.benchmarkResult.verifierVersion !== run.accepted.spec.verification.verifierVersion)) throw new Error('verifier version mismatch prevents Leaderboard publication')
      const levels = [...new Set(evidence.map((result) => result.evidenceLevel))]
      if (levels.length !== 1) throw new Error('mixed evidence levels prevent Leaderboard publication')
      const numericMetrics = evidence.flatMap((result) => Object.entries(result.benchmarkResult.nativeMetrics).filter((entry): entry is [string, number | boolean] => typeof entry[1] === 'number' || typeof entry[1] === 'boolean'))
      const primaryName = numericMetrics.find(([name]) => name === 'resolved')?.[0] ?? numericMetrics[0]?.[0]
      if (!primaryName) throw new Error('run has no numeric native primary metric')
      const values = evidence.map((result) => result.benchmarkResult.nativeMetrics[primaryName]).map((value) => typeof value === 'boolean' ? Number(value) : typeof value === 'number' ? value : Number.NaN)
      if (values.some((value) => !Number.isFinite(value))) throw new Error('native primary metric is not numeric for all trials')
      const primaryValue = values.reduce((sum, value) => sum + value, 0) / values.length
      return LeaderboardEntrySchema.parse({
        schemaVersion: 1, entryId: 'entry-' + (await sha256Hex(canonicalJson({ runId, variantId: agent.variantId, slice: run.accepted.spec.taskPack.evaluatedSlice.sliceManifestHash }))).slice(0, 24),
        model: agent.model, agent: { type: agent.backendId, version: agent.agentVersion, configHash: agent.configHash }, evaluatedSlice: run.accepted.spec.taskPack.evaluatedSlice,
        verifierVersion: run.accepted.spec.verification.verifierVersion, repeatPolicyHash, repeats: run.accepted.spec.execution.repeats,
        completedTrials: agentTrials.length, expectedTrials: expectedPerAgent, primaryMetric: { name: primaryName, value: primaryValue, unit: 'ratio' },
        secondaryMetrics: {}, evidenceLevel: levels[0], runRefs: [runId], publishedAt, status: 'active',
      })
    }))
  }

  private evaluateRegression(command: Extract<EvaluationCommand, { type: 'regression.evaluate' }>) {
    const baselineRun = this.requiredRun(command.baseline.runId)
    const candidateRun = this.requiredRun(command.candidate.runId)
    const baselineAgent = baselineRun.accepted.spec.agents.find((agent) => agent.variantId === command.baseline.agentVariantId)
    const candidateAgent = candidateRun.accepted.spec.agents.find((agent) => agent.variantId === command.candidate.agentVariantId)
    if (!baselineAgent || !candidateAgent) throw new Error('regression comparison references an unknown Agent variant')
    if (baselineRun.state !== 'completed' || candidateRun.state !== 'completed') throw new Error('regression comparison requires completed runs')
    const baselineSlice = baselineRun.accepted.spec.taskPack.evaluatedSlice.sliceManifestHash
    const candidateSlice = candidateRun.accepted.spec.taskPack.evaluatedSlice.sliceManifestHash
    if (baselineSlice !== candidateSlice) throw new Error('regression comparison requires identical evaluated slice manifests')
    if (baselineRun.accepted.spec.execution.repeats !== candidateRun.accepted.spec.execution.repeats) throw new Error('regression comparison requires identical repeat counts')
    const baseline = this.trialEvidenceByCoordinate(baselineRun.accepted.spec.runId, baselineAgent.variantId)
    const candidate = this.trialEvidenceByCoordinate(candidateRun.accepted.spec.runId, candidateAgent.variantId)
    if (baseline.size !== candidate.size) throw new Error('regression comparison has unmatched trial coverage')
    const observations: PairedObservation[] = []
    for (const [coordinate, baselineEvidence] of [...baseline.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const candidateEvidence = candidate.get(coordinate)
      if (!candidateEvidence) throw new Error('regression comparison is missing candidate coordinate: ' + coordinate)
      const baselineDefects = this.defectsForTrial(baselineEvidence.trialId)
      const candidateDefects = this.defectsForTrial(candidateEvidence.trialId)
      observations.push({
        taskId: baselineEvidence.taskId, repeatIndex: baselineEvidence.repeatIndex,
        baseline: { passed: evidencePassed(baselineEvidence), costUsd: evidenceCost(baselineEvidence) ?? this.projection.resultCommits.get(baselineEvidence.trialId)?.resourceUsage?.costUsd, latencyMs: this.projection.resultCommits.get(baselineEvidence.trialId)?.resourceUsage?.wallMs, evidenceComplete: evidenceIsComplete(baselineEvidence), criticalDefects: baselineDefects.filter((finding) => finding.severity === 'critical').length, testGaming: baselineDefects.some((finding) => finding.category === 'test_gaming'), evidenceRef: baselineEvidence.resultHash },
        candidate: { passed: evidencePassed(candidateEvidence), costUsd: evidenceCost(candidateEvidence) ?? this.projection.resultCommits.get(candidateEvidence.trialId)?.resourceUsage?.costUsd, latencyMs: this.projection.resultCommits.get(candidateEvidence.trialId)?.resourceUsage?.wallMs, evidenceComplete: evidenceIsComplete(candidateEvidence), criticalDefects: candidateDefects.filter((finding) => finding.severity === 'critical').length, testGaming: candidateDefects.some((finding) => finding.category === 'test_gaming'), evidenceRef: candidateEvidence.resultHash },
      })
    }
    return decideRegressionGate({ gateId: command.gateId, baselineConfigHash: baselineAgent.configHash, candidateConfigHash: candidateAgent.configHash, observations, rules: command.rules })
  }

  private trialEvidenceByCoordinate(runId: string, variantId: string) {
    const run = this.requiredRun(runId)
    const evidence = run.trialIds.map((trialId) => this.projection.trials.get(trialId)!).filter((trial) => trial.agentVariantId === variantId)
    const output = new Map<string, TrialEvidence>()
    for (const trial of evidence) {
      if (trial.state !== 'completed' || !trial.evidence) throw new Error('regression comparison requires canonical completed evidence')
      const key = trial.taskId + '|' + String(trial.repeatIndex)
      if (output.has(key)) throw new Error('duplicate regression evidence coordinate: ' + key)
      output.set(key, trial.evidence)
    }
    return output
  }

  private defectsForTrial(trialId: string) { return [...this.projection.defects.values()].filter((finding) => finding.trialId === trialId && finding.status !== 'rejected') }

  private async verifyReproductionForPromotion(input: import('@agent-kernel/eval-protocol').ReproductionBundle): Promise<void> {
    const bundle = await verifyReproductionBundleSignature(input, this.signingKeyRegistry, this.now())
    const finding = this.projection.defects.get(bundle.findingId)!
    const trial = this.projection.trials.get(finding.trialId)
    if (!trial?.evidence) throw new Error('reproduction source trial has no canonical evidence')
    if (await sha256Hex(canonicalJson(trial.evidence.environmentLock)) !== bundle.environmentLockHash) throw new Error('reproduction environment lock differs from source trial')
    const files = new Map<string, Awaited<ReturnType<ContainedArtifactStore['readRegisteredFile']>>>()
    for (const file of bundle.files) files.set(file.path, await this.artifactStore.readRegisteredFile(file))
    const traceFile = bundle.files.find((file) => file.path.endsWith('/trace.jsonl'))!
    const trace = parseTrialTraceJsonl(files.get(traceFile.path)!.content.toString('utf8'))
    if (trace.runId !== finding.runId || trace.trialId !== finding.trialId) throw new Error('reproduction trace does not match source defect authority')
    if (!trace.spans.some((span) => span.name === 'analyzer.detect')) throw new Error('reproduction trace has no analyzer.detect evidence')
    const verificationSpans = trace.spans.filter((span) => span.name === 'reproduction.verify')
    if (verificationSpans.length !== bundle.reproduction.attempts.length + 1) throw new Error('reproduction trace must cover every fresh attempt and the success control')
    if (verificationSpans.some((span) => span.status !== 'ok')) throw new Error('promoted reproduction trace contains a failed verification span')
    const checksum = bundle.files.find((file) => file.path.endsWith('/SHA256SUMS'))!
    const prefix = 'bundles/' + bundle.bundleId + '/'
    const expected = bundle.files.filter((file) => file.path !== checksum.path).sort((left, right) => left.path.localeCompare(right.path)).map((file) => file.sha256 + '  ' + file.path.slice(prefix.length)).join('\n') + '\n'
    if (files.get(checksum.path)!.content.toString('utf8') !== expected) throw new Error('reproduction SHA256SUMS does not match signed file manifest')
  }

  private async generateReport(reportId: string, runIds: readonly string[], methodologyVersion: string, generatedAt: string): Promise<GeneratedReport> {
    const uniqueRunIds = [...new Set(runIds)]
    if (uniqueRunIds.length !== runIds.length) throw new Error('report runIds must be unique')
    const runs = uniqueRunIds.map((runId) => {
      const run = this.requiredRun(runId)
      if (run.state !== 'completed') throw new Error('report generation requires completed runs')
      return { accepted: run.accepted, trials: run.trialIds.map((trialId) => this.projection.trials.get(trialId)?.evidence).filter((value): value is NonNullable<typeof value> => value !== undefined) }
    })
    const runSet = new Set(uniqueRunIds)
    const defects = [...this.projection.defects.values()].filter((finding) => runSet.has(finding.runId))
    const findingIds = new Set(defects.map((finding) => finding.findingId))
    const reproductions = [...this.projection.reproductions.values()].filter((bundle) => findingIds.has(bundle.findingId))
    const reports = await generateEvaluationReport({ reportId, methodologyVersion, generatedAt, runs, defects, reproductions, regressionDecisions: [...this.projection.regressionDecisions.values()], insights: [...this.projection.insights.values()] })
    for (const file of reports.files) await this.artifactStore.writeExclusive(file.path, file.content, reports.manifest.formats.find((entry) => entry.format === file.format)!.sha256)
    this.generatedReports.set(reportId, reports)
    return reports
  }

  private async platformMetrics() {
    const now = this.now()
    const runs = [...this.projection.runs.values()]
    const trials = [...this.projection.trials.values()]
    const queued = trials.filter((trial) => trial.state === 'queued')
    const activeLeases = [...this.projection.leases.values()].filter((lease) => lease.state === 'active').length
    const trialCapacity = [...this.projection.workers.values()].reduce((total, worker) => total + worker.registration.capacity.maxTrials, 0)
    const traceSpans: import('@agent-kernel/eval-protocol').TraceSpan[] = []
    let traceTrials = 0
    let traceReadFailures = 0
    for (const trial of trials) {
      const evidence = trial.evidence
      if (!evidence?.traceRef) continue
      const entry = evidence.artifactManifest.entries.find((candidate) => candidate.path === evidence.traceRef)
      if (!entry) { traceReadFailures += 1; continue }
      try {
        const artifact = await this.artifactStore.readEntry(entry)
        const trace = parseTrialTraceJsonl(artifact.content.toString('utf8'))
        if (trace.runId !== trial.runId || trace.trialId !== trial.trialId) throw new Error('trace authority mismatch')
        traceSpans.push(...trace.spans); traceTrials += 1
      } catch { traceReadFailures += 1 }
    }
    const environmentDurations = traceSpans.filter((span) => span.name === 'environment.prepare').map(spanDuration)
    const modelSpans = traceSpans.filter((span) => span.name === 'model.call')
    const toolSpans = traceSpans.filter((span) => span.name === 'tool.call')
    const firstModelCall = groupFirstModelLatency(traceSpans)
    const completedEvidence = trials.filter((trial) => trial.state === 'completed' && trial.evidence).map((trial) => trial.evidence!)
    const manifestChecks = await Promise.allSettled(completedEvidence.map(verifyTrialEvidence))
    const manifestFailures = manifestChecks.filter((result) => result.status === 'rejected').length + traceReadFailures
    const grading = [...this.projection.analysisJobs.values()].filter((job) => job.kind === 'grading')
    const usage = [...this.projection.resultCommits.values()].reduce((total, commit) => ({ inputTokens: total.inputTokens + (commit.resourceUsage?.inputTokens ?? 0), outputTokens: total.outputTokens + (commit.resourceUsage?.outputTokens ?? 0), costUsd: total.costUsd + (commit.resourceUsage?.costUsd ?? 0) }), { inputTokens: 0, outputTokens: 0, costUsd: 0 })
    const observationStartedAt = runs.map((run) => Date.parse(run.accepted.acceptedAt)).filter(Number.isFinite).sort((left, right) => left - right)[0] ?? now.getTime()
    const elapsedSeconds = Math.max(1, (now.getTime() - observationStartedAt) / 1000)
    const terminalOutcomes = countBy(trials.filter((trial) => terminalTrialState(trial.state)).map((trial) => trial.state))
    const flakyTaskIds = new Set([...this.projection.regressionDecisions.values()].flatMap((decision) => decision.flakyTasks))
    const evaluatedTaskIds = new Set(trials.map((trial) => trial.taskId))
    const cancellationDelays = runs.flatMap((run) => run.events.filter((event) => event.type === 'run.state' && event.data.state === 'cancelled').flatMap((event) => run.events.filter((trialEvent) => trialEvent.type === 'trial.state' && trialEvent.data.state === 'cancelled').map((trialEvent) => Math.abs(Date.parse(trialEvent.at) - Date.parse(event.at)))))
    const infrastructureAttributionFailures = [...this.projection.resultCommits.values(), ...this.projection.failedAttempts.values()].filter((commit) => commit.failure && ['environment_failure', 'provider_failure', 'verifier_failure'].includes(commit.failure.category) && commit.failure.responsibility === 'agent').length
    const officialAuthorityFailures = completedEvidence.filter((evidence) => evidence.evidenceLevel === 'official' && !evidence.benchmarkResult.officialEvidence).length
    const duplicateFailures = trials.filter((trial) => trial.terminalResultHash).length - this.projection.resultCommits.size
    const slos = [
      this.projection.lastTransactionHash
        ? slo('restart-durability', true, 'journal replay completes with a verified hash-chain tip', 'replayed ' + String(this.projection.transactionCount) + ' hash-chained transactions in ' + String(this.lastRecoveryMs) + ' ms', ['journal:' + this.projection.lastTransactionHash])
        : { id: 'restart-durability' as const, status: 'unknown' as const, target: 'journal replay completes with a verified hash-chain tip', observed: 'no durable transaction exists in the observation window', evidenceRefs: [] },
      slo('duplicate-commit-prevention', duplicateFailures === 0, 'zero duplicated committed trial results', String(Math.max(0, duplicateFailures)) + ' duplicate terminal commits', [...this.projection.resultCommits.values()].map((commit) => 'trial-result:' + commit.resultHash)),
      { id: 'bounded-cancellation' as const, status: cancellationDelays.length === 0 ? 'unknown' as const : Math.max(...cancellationDelays) <= 1_000 ? 'meeting' as const : 'at_risk' as const, target: 'Control Plane cancellation projection within 1000 ms', observed: cancellationDelays.length === 0 ? 'no cancellation observed' : 'maximum ' + String(Math.max(...cancellationDelays)) + ' ms', evidenceRefs: runs.filter((run) => run.state === 'cancelled').map((run) => 'run:' + run.accepted.spec.runId) },
      slo('manifest-integrity', manifestFailures === 0, 'all committed evidence and trace manifests verify', String(completedEvidence.length - manifestFailures) + '/' + String(completedEvidence.length) + ' completed evidence records verified', completedEvidence.map((evidence) => 'manifest:' + evidence.artifactManifest.manifestHash)),
      slo('infrastructure-attribution', infrastructureAttributionFailures === 0, 'infrastructure errors are never counted as Agent responsibility', String(infrastructureAttributionFailures) + ' misattributed infrastructure failures', []),
      slo('official-ingest-authority', officialAuthorityFailures === 0, 'official claims require official result ingest', String(officialAuthorityFailures) + ' invalid official claims', completedEvidence.filter((evidence) => evidence.evidenceLevel === 'official').map((evidence) => 'trial-result:' + evidence.resultHash)),
    ]
    const snapshot = PlatformMetricsSnapshotSchema.parse({
      schemaVersion: 1, generatedAt: now.toISOString(), observationStartedAt: new Date(observationStartedAt).toISOString(),
      queue: { queuedTrials: queued.length, oldestAgeMs: queued.length ? Math.max(...queued.map((trial) => Math.max(0, now.getTime() - Date.parse(trial.updatedAt)))) : 0 },
      workers: { registered: this.projection.workers.size, activeLeases, trialCapacity, utilization: trialCapacity === 0 ? 0 : Math.min(1, activeLeases / trialCapacity) },
      environmentPreparation: distribution(environmentDurations), firstModelCall: distribution(firstModelCall), modelCalls: distribution(modelSpans.map(spanDuration)),
      toolCalls: { ...distribution(toolSpans.map(spanDuration)), failuresByCategory: countBy(toolSpans.filter((span) => span.status === 'error').map((span) => span.outcomeCategory ?? 'unknown')) },
      artifacts: { uploadFailures: this.artifactUploadFailures, manifestsVerified: completedEvidence.length - manifestFailures, manifestFailures },
      grader: { completed: grading.filter((job) => job.state === 'completed').length, failed: grading.filter((job) => job.state === 'failed').length, failureRate: ratio(grading.filter((job) => job.state === 'failed').length, grading.filter((job) => job.state === 'completed' || job.state === 'failed').length) },
      orchestrator: { lastRecoveryMs: this.lastRecoveryMs, journalTransactions: this.projection.transactionCount },
      usage: { ...usage, tokensPerSecond: (usage.inputTokens + usage.outputTokens) / elapsedSeconds, costUsdPerHour: usage.costUsd / elapsedSeconds * 3600 },
      terminalOutcomes, flakes: { taskRate: ratio(flakyTaskIds.size, evaluatedTaskIds.size), verifierRate: ratio(flakyTaskIds.size, evaluatedTaskIds.size), flakyTasks: flakyTaskIds.size, evaluatedTasks: evaluatedTaskIds.size },
      traceCoverage: { trialsWithTrace: traceTrials, completedTrials: completedEvidence.length }, slos,
    })
    await mkdir(dirname(this.metricsPath), { recursive: true })
    await appendFile(this.metricsPath, canonicalJson(snapshot) + '\n', { encoding: 'utf8', mode: 0o600 })
    return snapshot
  }

  private async deletionImpact(runId: string): Promise<DeletionImpact> { return (await this.deletionPlan(runId)).impact }

  private async deletionPlan(runId: string): Promise<{ impact: DeletionImpact; artifactPaths: string[] }> {
    const run = this.requiredRun(runId)
    if (!terminalRunState(run.state)) throw new Error('only terminal runs can be deleted')
    const trials = run.trialIds.map((trialId) => this.projection.trials.get(trialId)!).filter(Boolean)
    const findingIds = new Set([...this.projection.defects.values()].filter((finding) => finding.runId === runId).map((finding) => finding.findingId))
    const reproductions = [...this.projection.reproductions.values()].filter((bundle) => findingIds.has(bundle.findingId))
    const analysisJobs = [...this.projection.analysisJobs.values()].filter((job) => job.runId === runId)
    const clusterPromotions = [...this.projection.failureClusterPromotions.values()].filter((promotion) => promotion.runId === runId)
    const analysisOutputs = analysisJobs.map((job) => this.projection.analysisOutputs.get(job.jobId)).filter((value): value is NonNullable<typeof value> => value !== undefined)
    const packIds = new Set([...this.projection.regressionPacks.values()].filter((pack) => findingIds.has(pack.promotionSourceFindingId)).map((pack) => pack.packId))
    const reports = [...this.projection.reports.values()].filter((report) => report.runRefs.includes(runId))
    const leaderboard = [...this.projection.leaderboardEntries.values()].filter((entry) => entry.runRefs.includes(runId))
    const insights = [...this.projection.insights.values()].filter((insight) => packIds.has(insight.regressionPackId) || insight.evidenceRefs.some((reference) => findingIds.has(reference)))
    const artifactEntries = trials.flatMap((trial) => trial.evidence?.artifactManifest.entries ?? [])
    const artifactPaths = [...new Set([...artifactEntries.map((entry) => entry.path), ...analysisJobs.flatMap((job) => job.outputManifestRef ? [job.outputManifestRef] : []), ...analysisOutputs.flatMap((output) => output.outputs.map((entry) => entry.artifactRef)), ...reports.flatMap((report) => report.formats.map((format) => format.path)), ...reproductions.flatMap((bundle) => bundle.files.map((file) => file.path))])].sort()
    const derivedResourceIds = [...new Set([...trials.map((trial) => trial.trialId), ...analysisJobs.map((job) => job.jobId), ...clusterPromotions.map((promotion) => promotion.promotionId), ...findingIds, ...reproductions.map((bundle) => bundle.bundleId), ...packIds, ...reports.map((report) => report.reportId), ...leaderboard.map((entry) => entry.entryId), ...insights.map((insight) => insight.insightId)])].sort()
    const blockedByRefs: string[] = []
    const policies = [...this.projection.retentionPolicies.values()]
    if (leaderboard.length > 0 && policies.some((policy) => policy.protectPublishedLeaderboardEvidence)) blockedByRefs.push(...leaderboard.map((entry) => 'leaderboard:' + entry.entryId))
    if (packIds.size > 0 && policies.some((policy) => policy.protectRegressionEvidence)) blockedByRefs.push(...[...packIds].map((packId) => 'regression-pack:' + packId))
    const bytes = artifactEntries.reduce((total, entry) => total + entry.bytes, 0)
    const unsigned = { schemaVersion: 1 as const, resourceType: 'run', resourceId: runId, artifactCount: artifactPaths.length, bytes, derivedResourceIds, blockedByRefs: blockedByRefs.sort() }
    return { impact: { ...unsigned, impactHash: await sha256Hex(canonicalJson(unsigned)) }, artifactPaths }
  }

  private runWithinBudgets(run: ReturnType<EvaluationControlPlane['requiredRun']>): boolean {
    const budget = run.accepted.spec.execution.budget
    if (!budget) return true
    if (budget.maxTokens !== undefined && run.resourceUsage.inputTokens + run.resourceUsage.outputTokens >= budget.maxTokens) return false
    if (budget.maxUsd !== undefined && run.resourceUsage.costUsd >= budget.maxUsd) return false
    if (budget.maxWallMs !== undefined && run.startedAt && this.now().getTime() - Date.parse(run.startedAt) >= budget.maxWallMs) return false
    return true
  }

  private async enforceBudgetStops(): Promise<void> {
    for (const run of this.projection.runs.values()) {
      if (run.state !== 'running' || this.runWithinBudgets(run)) continue
      const at = this.now().toISOString(); const records: JournalDomainRecord[] = []; let sequence = run.events.length
      for (const trialId of run.trialIds) {
        const trial = this.projection.trials.get(trialId)!; if (trial.state !== 'queued') continue
        records.push({ kind: 'event.appended', event: EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: run.accepted.spec.runId, trialId, type: 'trial.state', producer: 'control-plane', data: { trialId, state: 'blocked', reason: 'budget_exhausted' } }) }); sequence += 1
      }
      records.push({ kind: 'event.appended', event: EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at, runId: run.accepted.spec.runId, type: 'run.state', producer: 'control-plane', data: { state: 'blocked', reason: 'budget_exhausted' } }) })
      await this.commit(records, 'budget-stop-' + run.accepted.spec.runId + '-' + this.randomId(), at)
    }
  }

  private event(runId: string, type: string, data: Record<string, unknown>, trialId?: string, leaseId?: string, at = this.now().toISOString(), producer: 'control-plane' | 'worker' = 'control-plane'): EvaluationEvent {
    const run = this.requiredRun(runId)
    return EvaluationEventSchema.parse({ schemaVersion: 1, sequence: run.events.length, at, runId, ...(trialId ? { trialId } : {}), type, producer, ...(leaseId ? { leaseId } : {}), data })
  }

  private eventForNewRun(runId: string, type: string, data: Record<string, unknown>, at: string): EvaluationEvent {
    return EvaluationEventSchema.parse({ schemaVersion: 1, sequence: 0, at, runId, type, producer: 'control-plane', data })
  }

  private requiredRun(runId: string) {
    const run = this.projection.runs.get(runId)
    if (!run) throw new Error('unknown run: ' + runId)
    return run
  }

  private requiredAnalysisJob(jobId: string) {
    const job = this.projection.analysisJobs.get(jobId)
    if (!job) throw new Error('unknown analysis job: ' + jobId)
    return job
  }

  private assertTrialLeaseCurrent(lease: import('./model.js').LeaseProjection): void {
    const trial = this.projection.trials.get(lease.lease.trialId)
    if (!trial || trial.activeLeaseId !== lease.lease.leaseId || trial.attempt !== lease.lease.attempt) throw new Error('lease generation is no longer current')
    if (Date.parse(lease.expiresAt) <= this.now().getTime()) throw new Error('lease has expired: ' + lease.lease.leaseId)
  }

  private assertAnalysisLease(job: ReturnType<EvaluationControlPlane['requiredAnalysisJob']>, authority: { leaseToken?: string; generation?: number }): void {
    if (authority.leaseToken !== undefined && authority.leaseToken !== job.leaseToken) throw new Error('analysis job lease token mismatch')
    if (authority.generation !== undefined && authority.generation !== job.generation) throw new Error('analysis job generation mismatch')
  }

  private async requireCatalogPolicy(spec: import('@agent-kernel/eval-protocol').EvaluationRunSpec, operation: PolicyOperation, resourceId: string, at: string): Promise<JournalDomainRecord> {
    const decision = decideCatalogPolicy({ operation, dataset: spec.taskPack.evaluatedSlice.dataset.policy, taskPack: spec.taskPack.policy })
    const record: JournalDomainRecord = { kind: 'policy.decision', resourceId, ...decision }
    if (!decision.allowed) {
      await this.commit([record], 'policy-denied-' + operation + '-' + resourceId + '-' + this.randomId(), at)
      throw new Error('catalog policy denied ' + operation + ': ' + decision.denials.map((denial) => denial.subject + '.' + denial.dimension + '=' + denial.status).join(', '))
    }
    return record
  }

  private async commit(records: JournalDomainRecord[], transactionId: string, committedAt: string): Promise<void> {
    const transactionSequence = this.projection.transactionCount
    const auditedRecords: JournalDomainRecord[] = [...records, { kind: 'audit.recorded', record: this.auditRecord(records, transactionId, committedAt, transactionSequence) }]
    const unsigned = { schemaVersion: 1 as const, transactionSequence, transactionId, committedAt, previousHash: this.projection.lastTransactionHash, records: auditedRecords }
    const transaction = JournalTransactionSchema.parse({ ...unsigned, transactionHash: await sha256Hex(canonicalJson(unsigned)) })
    await this.journal.append(transaction)
    this.projection.apply(transaction)
  }

  private auditRecord(records: readonly JournalDomainRecord[], transactionId: string, at: string, committedSequence: number): AuditRecord {
    const command = records.find((record) => record.kind === 'command.acknowledged')
    const resource = records.find((record) => !['event.appended', 'command.acknowledged', 'audit.recorded'].includes(record.kind)) ?? records[0]!
    const clusterPromotion = resource.kind === 'failure-cluster.promotion.recorded' ? resource.promotion : undefined
    const policyDecision = resource.kind === 'policy.decision' ? resource : undefined
    const principal = currentPrincipal()
    const principalKind = principal?.role === 'worker' ? 'worker' : principal ? 'operator' : undefined
    return {
      schemaVersion: 1,
      sequence: this.projection.auditRecords.length,
      at,
      actor: principal
        ? { kind: principalKind!, id: principal.principalId }
        : clusterPromotion
          ? { kind: 'operator', id: clusterPromotion.promotedBy.actorId }
          : { kind: resource.kind.startsWith('worker.') || resource.kind.startsWith('lease.') || resource.kind === 'result.committed' ? 'worker' : 'control-plane', id: resource.kind.startsWith('worker.') && 'workerId' in resource ? String(resource.workerId) : 'local-control-plane' },
      operation: resource.kind,
      resourceType: resource.kind.split('.')[0]!,
      resourceId: transactionId,
      ...(command ? { commandId: command.acknowledgement.commandId } : {}),
      committedSequence,
      details: policyDecision
        ? { recordCount: records.length, transactionId, allowed: policyDecision.allowed, operation: policyDecision.operation, denialCount: policyDecision.denials.length, denials: policyDecision.denials.map((denial) => denial.subject + '.' + denial.dimension + '=' + denial.status).join(',') }
        : clusterPromotion
          ? { recordCount: records.length, transactionId, authority: clusterPromotion.promotedBy.authority, clusterId: clusterPromotion.cluster.clusterId }
          : { recordCount: records.length, transactionId, ...(principal ? { authenticatedPrincipalId: principal.principalId, authenticatedRole: principal.role } : {}) },
    }
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const task = this.mutationTail.then(async () => {
      try { resolveResult(await action()) } catch (error) { rejectResult(error) }
    })
    this.mutationTail = task.catch(() => undefined)
    return result
  }
}

function workerSupportsRun(worker: WorkerRegistration, spec: import('@agent-kernel/eval-protocol').EvaluationRunSpec): boolean {
  if (!worker.sandboxProviders.includes(spec.sandbox.provider) || !worker.benchmarkAdapters.includes(spec.taskPack.id)) return false
  if (spec.agents.some((agent) => !worker.agentBackends.includes(agent.backendId))) return false
  if (!worker.readiness) return true
  const sandbox = worker.readiness.sandboxes.find((entry) => entry.provider === spec.sandbox.provider && entry.imageDigest === spec.sandbox.imageDigest && entry.networkMode === spec.sandbox.network.mode && canonicalJson(entry.allowedDestinations) === canonicalJson(spec.sandbox.network.allowedDestinations))
  if (!sandbox?.ok) return false
  return spec.agents.every((agent) => worker.readiness!.agents.some((entry) => entry.backendId === agent.backendId && entry.configHash === agent.configHash && entry.ok))
}

function page<T>(items: readonly T[], request: { cursor?: string; limit: number }): { items: T[]; page: { nextCursor?: string; hasMore: boolean; total: number } } {
  const offset = request.cursor === undefined ? 0 : Number(request.cursor)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid page cursor')
  const end = offset + request.limit
  const hasMore = end < items.length
  return { items: items.slice(offset, end), page: { ...(hasMore ? { nextCursor: String(end) } : {}), hasMore, total: items.length } }
}

function matchesSearch(value: unknown, search?: string): boolean {
  return !search || JSON.stringify(value).toLocaleLowerCase().includes(search.toLocaleLowerCase())
}

function leaderboardSortValue(entry: LeaderboardEntry, sortBy: 'primary_metric' | 'cost' | 'p50_duration' | 'p95_duration' | 'published_at'): number {
  if (sortBy === 'primary_metric') return entry.primaryMetric.value
  if (sortBy === 'published_at') return Date.parse(entry.publishedAt)
  const metric = sortBy === 'cost' ? 'costUsd' : sortBy === 'p50_duration' ? 'p50DurationMs' : 'p95DurationMs'
  const value = entry.secondaryMetrics[metric]
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const values = new Map<string, T>()
  for (const item of items) values.set(key(item), item)
  return [...values.values()]
}

function parseAnalysisJson(content: Uint8Array, kind: string): unknown {
  try { return JSON.parse(Buffer.from(content).toString('utf8')) } catch { throw new Error('analysis ' + kind + ' artifact must contain valid JSON') }
}

function terminalRunState(state: string): boolean { return ['completed', 'failed', 'cancelled'].includes(state) }
function terminalTrialState(state: string): boolean { return ['completed', 'blocked', 'timeout', 'cancelled', 'agent_error', 'environment_error', 'verifier_error', 'indeterminate'].includes(state) }
function completionPath(current: import('@agent-kernel/eval-protocol').TrialState, terminal: import('@agent-kernel/eval-protocol').TrialResultCommit['terminalState']): import('@agent-kernel/eval-protocol').TrialState[] {
  if (terminal !== 'completed') return [terminal]
  const order: import('@agent-kernel/eval-protocol').TrialState[] = ['leased', 'environment_preparing', 'agent_running', 'artifacts_collecting', 'verifying', 'analyzing', 'completed']
  const currentIndex = order.indexOf(current)
  if (currentIndex < 0) throw new Error('completed result cannot advance from trial state: ' + current)
  return order.slice(currentIndex + 1)
}
function assertFailureMatchesTerminal(commit: import('@agent-kernel/eval-protocol').TrialResultCommit): void {
  if (!commit.failure) throw new Error('terminal failure commit lacks normalized failure')
  const categories: Readonly<Record<Exclude<import('@agent-kernel/eval-protocol').TrialResultCommit['terminalState'], 'completed'>, readonly import('@agent-kernel/eval-protocol').FailureCategory[]>> = {
    blocked: ['unmet_precondition'],
    timeout: ['timeout'],
    cancelled: ['cancelled'],
    agent_error: ['agent_failure', 'invalid_action', 'provider_failure'],
    environment_error: ['environment_failure', 'provider_failure'],
    verifier_error: ['verifier_failure'],
    indeterminate: ['indeterminate_side_effect'],
  }
  if (commit.terminalState === 'completed' || !categories[commit.terminalState].includes(commit.failure.category)) throw new Error('normalized failure category does not match terminal trial state')
}
function evidencePassed(evidence: TrialEvidence): boolean {
  const metrics = evidence.benchmarkResult.nativeMetrics
  const key = ['resolved', 'passed', 'reward', 'compile_passed', 'journey_completed', ...Object.keys(metrics).sort()].find((name) => name in metrics)
  if (!key) throw new Error('regression evidence has no native metric: ' + evidence.trialId)
  const value = metrics[key]
  return value === true || typeof value === 'number' && value > 0 || typeof value === 'string' && /^(?:pass|passed|success|resolved)$/iu.test(value)
}
function evidenceCost(evidence: TrialEvidence): number | undefined { return evidence.usage.availability === 'available' ? evidence.usage.costUsd : undefined }
function evidenceIsComplete(evidence: TrialEvidence): boolean {
  const paths = new Set(evidence.artifactManifest.entries.map((entry) => entry.path.split(String.fromCharCode(92)).join('/')))
  const references = [evidence.nativeEventsRef, evidence.normalizedEventsRef, evidence.analyzerInputRef, evidence.finalDiffRef, evidence.stdoutRef, evidence.stderrRef, evidence.benchmarkResult.rawResultRef]
  return evidence.resultHash.length === 64 && evidence.artifactManifest.manifestHash.length === 64 && references.every((reference) => paths.has(reference.split(String.fromCharCode(92)).join('/')))
}
function spanDuration(span: import('@agent-kernel/eval-protocol').TraceSpan): number { return Math.max(0, Date.parse(span.completedAt) - Date.parse(span.startedAt)) }
function distribution(values: readonly number[]): { count: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null } {
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null }
  const sorted = [...values].sort((left, right) => left - right)
  return { count: values.length, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1)! }
}
function percentile(sorted: readonly number[], quantile: number): number { return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]! }
function groupFirstModelLatency(spans: readonly import('@agent-kernel/eval-protocol').TraceSpan[]): number[] {
  const byTrial = new Map<string, { agent?: import('@agent-kernel/eval-protocol').TraceSpan; models: import('@agent-kernel/eval-protocol').TraceSpan[] }>()
  for (const span of spans) {
    const value = byTrial.get(span.refs.trialId) ?? { models: [] }
    if (span.name === 'agent.execute') value.agent = span
    if (span.name === 'model.call') value.models.push(span)
    byTrial.set(span.refs.trialId, value)
  }
  return [...byTrial.values()].flatMap((value) => value.agent && value.models.length ? [Math.max(0, Math.min(...value.models.map((span) => Date.parse(span.startedAt))) - Date.parse(value.agent.startedAt))] : [])
}
function countBy(values: readonly string[]): Record<string, number> { const output: Record<string, number> = {}; for (const value of values) output[value] = (output[value] ?? 0) + 1; return output }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : numerator / denominator }
function slo(id: 'restart-durability' | 'duplicate-commit-prevention' | 'manifest-integrity' | 'infrastructure-attribution' | 'official-ingest-authority', meeting: boolean, target: string, observed: string, evidenceRefs: string[]) { return { id, status: meeting ? 'meeting' as const : 'at_risk' as const, target, observed, evidenceRefs } }

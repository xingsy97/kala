import { assertAnalysisJobTransition, assertRunStateTransition, assertTrialStateTransition, type AnalysisJob, type AnalysisOutputManifest, type AuditRecord, type CommittedAcknowledgement, type DefectFinding, type EvaluationEvent, type FailureClusterPromotion, type LeaderboardEntry, type ProductInsight, type RegressionGateDecision, type RegressionPack, type ReportManifest, type ReproductionBundle, type RetentionPolicy, type RunState, type TrialResultCommit, type TrialState } from '@agent-kernel/eval-protocol'

import type { JournalDomainRecord, JournalTransaction, LeaseProjection, RunProjection, TrialProjection, WorkerProjection } from './model.js'

export class ControlPlaneProjection {
  readonly runs = new Map<string, RunProjection>()
  readonly catalogSlices = new Map<string, { taskIdsHash: string; taskIds: string[]; tasks: import('@agent-kernel/eval-protocol').ResolvedTask[] }>()
  readonly catalogTasks = new Map<string, import('@agent-kernel/eval-protocol').ResolvedTask>()
  readonly trials = new Map<string, TrialProjection>()
  readonly workers = new Map<string, WorkerProjection>()
  readonly leases = new Map<string, LeaseProjection>()
  readonly commandAcks = new Map<string, { hash: string; acknowledgement: CommittedAcknowledgement }>()
  readonly failedAttempts = new Map<string, TrialResultCommit>()
  readonly resultCommits = new Map<string, TrialResultCommit>()
  readonly analysisJobs = new Map<string, AnalysisJob>()
  readonly analysisOutputs = new Map<string, AnalysisOutputManifest>()
  readonly leaderboardEntries = new Map<string, LeaderboardEntry>()
  readonly defects = new Map<string, DefectFinding>()
  readonly failureClusterPromotions = new Map<string, FailureClusterPromotion>()
  readonly reproductions = new Map<string, ReproductionBundle>()
  readonly regressionPacks = new Map<string, RegressionPack>()
  readonly regressionDecisions = new Map<string, RegressionGateDecision>()
  readonly reports = new Map<string, ReportManifest>()
  readonly insights = new Map<string, ProductInsight>()
  readonly auditRecords: AuditRecord[] = []
  readonly retentionPolicies = new Map<string, RetentionPolicy>()
  readonly deletedRuns = new Map<string, { impact: import('@agent-kernel/eval-protocol').DeletionImpact; artifactPaths: string[]; deletedAt: string }>()
  readonly completedRunDeletions = new Set<string>()
  transactionCount = 0
  lastTransactionHash: string | null = null

  replay(transactions: readonly JournalTransaction[]): void {
    this.clear()
    for (const transaction of transactions) this.apply(transaction)
  }

  apply(transaction: JournalTransaction): void {
    if (transaction.transactionSequence !== this.transactionCount) throw new Error('projection transaction sequence mismatch')
    if (transaction.previousHash !== this.lastTransactionHash) throw new Error('projection transaction hash chain mismatch')
    for (const record of transaction.records) this.applyRecord(record, transaction.transactionSequence)
    this.lastTransactionHash = transaction.transactionHash
    this.transactionCount += 1
  }

  private applyRecord(record: JournalDomainRecord, sequence: number): void {
    switch (record.kind) {
      case 'policy.decision':
        return
      case 'catalog.slice.registered':
        this.catalogSlices.set(record.sliceManifestHash, { taskIdsHash: record.taskIdsHash, taskIds: [...record.taskIds], tasks: [...record.tasks] })
        for (const task of record.tasks) this.catalogTasks.set(task.taskId, task)
        return
      case 'run.accepted': {
        const runId = record.accepted.spec.runId
        if (this.runs.has(runId)) throw new Error('duplicate run ID in journal: ' + runId)
        this.runs.set(runId, { accepted: record.accepted, state: 'draft', events: [], trialIds: [], createdSequence: sequence, resourceUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 }, updatedAt: record.accepted.acceptedAt })
        return
      }
      case 'event.appended':
        this.applyEvent(record.event)
        return
      case 'worker.registered':
        this.workers.set(record.worker.workerId, { registration: record.worker, registeredAt: record.registeredAt, heartbeatAt: record.registeredAt })
        return
      case 'worker.heartbeat': {
        const worker = required(this.workers, record.workerId, 'worker')
        worker.heartbeatAt = record.at
        return
      }
      case 'lease.issued': {
        const trial = required(this.trials, record.lease.trialId, 'trial')
        trial.activeLeaseId = record.lease.leaseId
        trial.attempt = record.lease.attempt
        delete trial.retryNotBefore
        trial.updatedAt = record.lease.issuedAt
        const run = required(this.runs, record.lease.runId, 'run')
        run.lastLeaseSequence = sequence
        this.leases.set(record.lease.leaseId, { lease: record.lease, state: 'active', executionReceipt: 'none', heartbeatAt: record.lease.issuedAt, expiresAt: record.lease.expiresAt })
        return
      }
      case 'lease.heartbeat': {
        const lease = required(this.leases, record.leaseId, 'lease')
        lease.heartbeatAt = record.at
        lease.expiresAt = record.expiresAt
        lease.executionReceipt = record.executionReceipt
        return
      }
      case 'lease.closed': {
        const lease = required(this.leases, record.leaseId, 'lease')
        lease.state = 'closed'
        lease.closeReason = record.reason
        const trial = required(this.trials, lease.lease.trialId, 'trial')
        delete trial.activeLeaseId
        trial.updatedAt = record.at
        return
      }
      case 'result.committed': {
        const prior = this.resultCommits.get(record.commit.trialId)
        if (prior && prior.resultHash !== record.commit.resultHash) throw new Error('conflicting result commit in journal')
        this.resultCommits.set(record.commit.trialId, record.commit)
        const trial = required(this.trials, record.commit.trialId, 'trial')
        trial.terminalResultHash = record.commit.resultHash
        if (record.commit.evidence) trial.evidence = record.commit.evidence
        if (record.commit.failure) trial.failure = record.commit.failure
        trial.updatedAt = record.commit.committedAt
        const run = required(this.runs, trial.runId, 'run')
        if (record.commit.resourceUsage) {
          run.resourceUsage.inputTokens += record.commit.resourceUsage.inputTokens
          run.resourceUsage.outputTokens += record.commit.resourceUsage.outputTokens
          run.resourceUsage.costUsd += record.commit.resourceUsage.costUsd
          run.resourceUsage.wallMs += record.commit.resourceUsage.wallMs
        }
        return
      }
      case 'analysis-job.recorded': {
        const prior = this.analysisJobs.get(record.job.jobId)
        if (prior) assertAnalysisJobTransition(prior.state, record.job.state)
        else if (record.job.state !== 'queued') throw new Error('first analysis job state must be queued')
        this.analysisJobs.set(record.job.jobId, record.job)
        return
      }
      case 'analysis-output.recorded': {
        if (this.analysisOutputs.has(record.manifest.jobId)) throw new Error('duplicate analysis output manifest in journal: ' + record.manifest.jobId)
        this.analysisOutputs.set(record.manifest.jobId, record.manifest)
        return
      }
      case 'attempt.failed': {
        const key = attemptKey(record.commit.trialId, record.commit.attempt)
        const prior = this.failedAttempts.get(key)
        if (prior && (prior.resultHash !== record.commit.resultHash || prior.artifactManifestHash !== record.commit.artifactManifestHash)) throw new Error('conflicting failed attempt in journal')
        this.failedAttempts.set(key, record.commit)
        return
      }
      case 'leaderboard.published':
        this.leaderboardEntries.set(record.entry.entryId, record.entry)
        return
      case 'leaderboard.status.changed': {
        const prior = required(this.leaderboardEntries, record.entry.entryId, 'Leaderboard entry')
        if (prior.status === record.entry.status) throw new Error('Leaderboard status change must change status')
        this.leaderboardEntries.set(record.entry.entryId, record.entry)
        return
      }
      case 'defect.recorded':
        this.defects.set(record.finding.findingId, record.finding)
        return
      case 'failure-cluster.promotion.recorded':
        if (this.failureClusterPromotions.has(record.promotion.promotionId)) throw new Error('duplicate failure cluster promotion in journal: ' + record.promotion.promotionId)
        this.failureClusterPromotions.set(record.promotion.promotionId, record.promotion)
        return
      case 'reproduction.recorded':
        this.reproductions.set(record.bundle.bundleId, record.bundle)
        return
      case 'regression-pack.recorded':
        this.regressionPacks.set(record.pack.packId, record.pack)
        return
      case 'regression-decision.recorded':
        this.regressionDecisions.set(record.decision.gateId, record.decision)
        return
      case 'report.recorded':
        this.reports.set(record.report.reportId, record.report)
        return
      case 'insight.recorded':
        this.insights.set(record.insight.insightId, record.insight)
        return
      case 'audit.recorded':
        if (record.record.sequence !== this.auditRecords.length) throw new Error('non-contiguous audit sequence')
        this.auditRecords.push(record.record)
        return
      case 'retention.recorded':
        this.retentionPolicies.set(record.policy.policyId, record.policy)
        return
      case 'run.deleted':
        this.applyRunDeletion(record.impact.resourceId, record.impact, record.artifactPaths, record.deletedAt)
        return
      case 'run.deletion.completed':
        if (!this.deletedRuns.has(record.runId)) throw new Error('deletion completion without deletion request: ' + record.runId)
        this.completedRunDeletions.add(record.runId)
        return
      case 'command.acknowledged':
        this.commandAcks.set(record.acknowledgement.idempotencyKey, { hash: record.commandHash, acknowledgement: record.acknowledgement })
        return
    }
  }

  private applyEvent(event: EvaluationEvent): void {
    const run = required(this.runs, event.runId, 'run')
    if (event.sequence !== run.events.length) throw new Error('non-contiguous run event sequence for ' + event.runId)
    run.events.push(event)
    run.updatedAt = event.at
    if (event.type === 'run.state') {
      assertRunStateTransition(run.events.length === 1 ? undefined : run.state, event.data.state)
      run.state = event.data.state
      if (run.state === 'running' && !run.startedAt) run.startedAt = event.at
    }
    if (event.type === 'trial.created') {
      const trialId = requiredString(event.data.trialId, 'trialId')
      if (this.trials.has(trialId)) throw new Error('duplicate trial ID in journal: ' + trialId)
      const trial: TrialProjection = {
        trialId,
        runId: event.runId,
        taskId: requiredString(event.data.taskId, 'taskId'),
        agentVariantId: requiredString(event.data.agentVariantId, 'agentVariantId'),
        backendId: requiredString(event.data.backendId, 'backendId'),
        sandboxProvider: requiredString(event.data.sandboxProvider, 'sandboxProvider'),
        repeatIndex: requiredNumber(event.data.repeatIndex, 'repeatIndex'),
        state: 'queued',
        attempt: 0,
        updatedAt: event.at,
      }
      this.trials.set(trialId, trial)
      run.trialIds.push(trialId)
    }
    if (event.type === 'trial.state') {
      const trial = required(this.trials, event.data.trialId, 'trial')
      assertTrialStateTransition(trial.state, event.data.state)
      trial.state = event.data.state
      if (trial.state === 'queued' && typeof event.data.retryNotBefore === 'string') trial.retryNotBefore = event.data.retryNotBefore
      else if (trial.state !== 'queued') delete trial.retryNotBefore
      trial.updatedAt = event.at
    }
  }

  private clear(): void {
    this.runs.clear(); this.catalogSlices.clear(); this.catalogTasks.clear(); this.trials.clear(); this.workers.clear(); this.leases.clear(); this.commandAcks.clear(); this.failedAttempts.clear(); this.resultCommits.clear(); this.analysisJobs.clear(); this.analysisOutputs.clear(); this.leaderboardEntries.clear(); this.defects.clear(); this.failureClusterPromotions.clear(); this.reproductions.clear(); this.regressionPacks.clear(); this.regressionDecisions.clear(); this.reports.clear(); this.insights.clear(); this.auditRecords.length = 0; this.retentionPolicies.clear(); this.deletedRuns.clear(); this.completedRunDeletions.clear(); this.transactionCount = 0; this.lastTransactionHash = null
  }

  private applyRunDeletion(runId: string, impact: import('@agent-kernel/eval-protocol').DeletionImpact, artifactPaths: string[], deletedAt: string): void {
    const run = this.runs.get(runId)
    const trialIds = new Set(run?.trialIds ?? [])
    const resultHashes = new Set([...this.resultCommits.values()].filter((commit) => trialIds.has(commit.trialId)).map((commit) => commit.resultHash))
    for (const trialId of trialIds) {
      this.trials.delete(trialId); this.resultCommits.delete(trialId)
      for (const key of this.failedAttempts.keys()) if (key.startsWith(trialId + '|')) this.failedAttempts.delete(key)
    }
    for (const [leaseId, lease] of this.leases) if (trialIds.has(lease.lease.trialId)) this.leases.delete(leaseId)
    for (const [jobId, job] of this.analysisJobs) if (job.runId === runId) { this.analysisJobs.delete(jobId); this.analysisOutputs.delete(jobId) }
    for (const [promotionId, promotion] of this.failureClusterPromotions) if (promotion.runId === runId) this.failureClusterPromotions.delete(promotionId)
    const findingIds = new Set([...this.defects.values()].filter((finding) => finding.runId === runId || trialIds.has(finding.trialId)).map((finding) => finding.findingId))
    for (const findingId of findingIds) this.defects.delete(findingId)
    const bundleIds = new Set([...this.reproductions.values()].filter((bundle) => findingIds.has(bundle.findingId)).map((bundle) => bundle.bundleId))
    for (const bundleId of bundleIds) this.reproductions.delete(bundleId)
    const packIds = new Set([...this.regressionPacks.values()].filter((pack) => findingIds.has(pack.promotionSourceFindingId)).map((pack) => pack.packId))
    for (const packId of packIds) this.regressionPacks.delete(packId)
    for (const [insightId, insight] of this.insights) if (packIds.has(insight.regressionPackId) || insight.evidenceRefs.some((reference) => findingIds.has(reference))) this.insights.delete(insightId)
    for (const [entryId, entry] of this.leaderboardEntries) if (entry.runRefs.includes(runId)) this.leaderboardEntries.delete(entryId)
    for (const [reportId, report] of this.reports) if (report.runRefs.includes(runId)) this.reports.delete(reportId)
    for (const [gateId, decision] of this.regressionDecisions) if (decision.evidenceRefs.some((reference) => trialIds.has(reference) || resultHashes.has(reference))) this.regressionDecisions.delete(gateId)
    this.runs.delete(runId)
    this.deletedRuns.set(runId, { impact, artifactPaths, deletedAt })
  }
}

function attemptKey(trialId: string, attempt: number): string { return trialId + '|' + String(attempt) }

function required<K, V>(map: ReadonlyMap<K, V>, key: K, kind: string): V {
  const value = map.get(key)
  if (!value) throw new Error('unknown ' + kind + ': ' + String(key))
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid ' + name + ' in journal event')
  return value
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid ' + name + ' in journal event')
  return value
}

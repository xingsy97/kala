import { z } from 'zod'

import {
  AcceptedEvaluationRunSpecSchema,
  AnalysisJobSchema,
  AnalysisOutputManifestSchema,
  CommittedAcknowledgementSchema,
  EvaluationEventSchema,
  TrialLeaseSchema,
  TrialResultCommitSchema,
  LeaderboardEntrySchema,
  AuditRecordSchema,
  DefectFindingSchema,
  FailureClusterPromotionSchema,
  ProductInsightSchema,
  RegressionPackSchema,
  ReportManifestSchema,
  ReproductionBundleSchema,
  RegressionGateDecisionSchema,
  RetentionPolicySchema,
  DeletionImpactSchema,
  PolicyStatusSchema,
  RelativeArtifactPathSchema,
  ResolvedTaskSchema,
  Sha256Schema,
  WorkerRegistrationSchema,
  type RunState,
  type TrialState,
} from '@agent-kernel/eval-protocol'

export const JournalDomainRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('policy.decision'), operation: z.enum(['run_admission', 'artifact_publication', 'report_publication', 'leaderboard_publication']), resourceId: z.string().min(1), allowed: z.boolean(), purpose: z.enum(['evaluation', 'training']), denials: z.array(z.object({ subject: z.enum(['dataset', 'task_pack']), dimension: z.string().min(1), status: PolicyStatusSchema }).strict()) }).strict(),
  z.object({ kind: z.literal('catalog.slice.registered'), sliceManifestHash: Sha256Schema, taskIdsHash: Sha256Schema, taskIds: z.array(z.string().min(1)).min(1), tasks: z.array(ResolvedTaskSchema) }),
  z.object({ kind: z.literal('run.accepted'), accepted: AcceptedEvaluationRunSpecSchema }),
  z.object({ kind: z.literal('event.appended'), event: EvaluationEventSchema }),
  z.object({ kind: z.literal('worker.registered'), worker: WorkerRegistrationSchema, registeredAt: z.string().datetime() }),
  z.object({ kind: z.literal('worker.heartbeat'), workerId: z.string().min(1), at: z.string().datetime() }),
  z.object({ kind: z.literal('lease.issued'), lease: TrialLeaseSchema }),
  z.object({ kind: z.literal('lease.heartbeat'), leaseId: z.string().min(1), workerId: z.string().min(1), at: z.string().datetime(), expiresAt: z.string().datetime(), executionReceipt: z.enum(['none', 'known', 'indeterminate']) }),
  z.object({ kind: z.literal('lease.closed'), leaseId: z.string().min(1), at: z.string().datetime(), reason: z.enum(['committed', 'expired_retryable', 'expired_indeterminate', 'cancelled']) }),
  z.object({ kind: z.literal('attempt.failed'), commit: TrialResultCommitSchema }),
  z.object({ kind: z.literal('result.committed'), commit: TrialResultCommitSchema }),
  z.object({ kind: z.literal('analysis-job.recorded'), job: AnalysisJobSchema }),
  z.object({ kind: z.literal('analysis-output.recorded'), manifest: AnalysisOutputManifestSchema }),
  z.object({ kind: z.literal('leaderboard.published'), entry: LeaderboardEntrySchema }),
  z.object({ kind: z.literal('leaderboard.status.changed'), entry: LeaderboardEntrySchema, reason: z.string().min(1) }),
  z.object({ kind: z.literal('defect.recorded'), finding: DefectFindingSchema }),
  z.object({ kind: z.literal('failure-cluster.promotion.recorded'), promotion: FailureClusterPromotionSchema }),
  z.object({ kind: z.literal('reproduction.recorded'), bundle: ReproductionBundleSchema }),
  z.object({ kind: z.literal('regression-pack.recorded'), pack: RegressionPackSchema }),
  z.object({ kind: z.literal('regression-decision.recorded'), decision: RegressionGateDecisionSchema }),
  z.object({ kind: z.literal('report.recorded'), report: ReportManifestSchema }),
  z.object({ kind: z.literal('insight.recorded'), insight: ProductInsightSchema }),
  z.object({ kind: z.literal('audit.recorded'), record: AuditRecordSchema }),
  z.object({ kind: z.literal('retention.recorded'), policy: RetentionPolicySchema }),
  z.object({ kind: z.literal('run.deleted'), impact: DeletionImpactSchema, artifactPaths: z.array(RelativeArtifactPathSchema), deletedAt: z.string().datetime() }),
  z.object({ kind: z.literal('run.deletion.completed'), runId: z.string().min(1), completedAt: z.string().datetime() }),
  z.object({ kind: z.literal('command.acknowledged'), commandHash: z.string().regex(/^[a-f0-9]{64}$/u), acknowledgement: CommittedAcknowledgementSchema }),
])

export const JournalTransactionSchema = z.object({
  schemaVersion: z.literal(1),
  transactionSequence: z.number().int().nonnegative(),
  transactionId: z.string().min(1),
  committedAt: z.string().datetime(),
  previousHash: Sha256Schema.nullable(),
  records: z.array(JournalDomainRecordSchema).min(1),
  transactionHash: Sha256Schema,
})

export type JournalDomainRecord = z.infer<typeof JournalDomainRecordSchema>
export type JournalTransaction = z.infer<typeof JournalTransactionSchema>

export type RunProjection = {
  accepted: z.infer<typeof AcceptedEvaluationRunSpecSchema>
  state: RunState
  events: z.infer<typeof EvaluationEventSchema>[]
  trialIds: string[]
  createdSequence: number
  startedAt?: string
  lastLeaseSequence?: number
  resourceUsage: { inputTokens: number; outputTokens: number; costUsd: number; wallMs: number }
  updatedAt: string
}

export type TrialProjection = {
  trialId: string
  runId: string
  taskId: string
  agentVariantId: string
  backendId: string
  sandboxProvider: string
  repeatIndex: number
  state: TrialState
  attempt: number
  activeLeaseId?: string
  retryNotBefore?: string
  terminalResultHash?: string
  evidence?: import('@agent-kernel/eval-protocol').TrialEvidence
  failure?: import('@agent-kernel/eval-protocol').NormalizedFailure
  updatedAt: string
}

export type WorkerProjection = {
  registration: z.infer<typeof WorkerRegistrationSchema>
  registeredAt: string
  heartbeatAt: string
}

export type LeaseProjection = {
  lease: z.infer<typeof TrialLeaseSchema>
  state: 'active' | 'closed'
  executionReceipt: 'none' | 'known' | 'indeterminate'
  heartbeatAt: string
  expiresAt: string
  closeReason?: 'committed' | 'expired_retryable' | 'expired_indeterminate' | 'cancelled'
}

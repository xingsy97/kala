import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema, Sha256Schema } from './common.js'
import { EvaluationRunSpecSchema } from './run-spec.js'
import { DefectFindingSchema } from './defects.js'
import { ProductInsightSchema } from './insights.js'
import { RegressionPackSchema, RegressionRulesSchema } from './regression.js'
import { ReproductionBundleSchema } from './reproduction.js'
import { RetentionPolicySchema } from './governance.js'
import { AnalysisOutputManifestSchema } from './analysis-jobs.js'
import { CounterfactualContinuationRequestSchema } from './analyzer.js'
import { DefectCategorySchema } from './defects.js'

const CommandEnvelopeSchema = z.object({ schemaVersion: z.literal(1), commandId: IdentifierSchema, idempotencyKey: IdentifierSchema, submittedAt: z.string().datetime() })
export const EvaluationCommandSchema = z.discriminatedUnion('type', [
  CommandEnvelopeSchema.extend({ type: z.literal('run.create'), spec: EvaluationRunSpecSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('run.start'), runId: IdentifierSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('run.cancel'), runId: IdentifierSchema, reason: NonEmptyStringSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('trial.retry'), runId: IdentifierSchema, trialIds: z.array(IdentifierSchema).min(1), indeterminateSideEffectConfirmation: NonEmptyStringSchema.optional() }),
  CommandEnvelopeSchema.extend({ type: z.literal('run.grade'), runId: IdentifierSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('run.analyze'), runId: IdentifierSchema, detectorIds: z.array(IdentifierSchema).min(1) }),
  CommandEnvelopeSchema.extend({ type: z.literal('run.align'), runId: IdentifierSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('run.cluster'), runId: IdentifierSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('run.counterfactual'), runId: IdentifierSchema, request: CounterfactualContinuationRequestSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('analysis.job.start'), jobId: IdentifierSchema, executorId: IdentifierSchema, leaseMs: z.number().int().positive() }),
  CommandEnvelopeSchema.extend({ type: z.literal('analysis.job.heartbeat'), jobId: IdentifierSchema, executorId: IdentifierSchema, leaseMs: z.number().int().positive(), leaseToken: NonEmptyStringSchema.optional(), generation: z.number().int().positive().optional() }),
  CommandEnvelopeSchema.extend({ type: z.literal('analysis.job.complete'), jobId: IdentifierSchema, executorId: IdentifierSchema, leaseToken: NonEmptyStringSchema.optional(), generation: z.number().int().positive().optional(), outputManifest: AnalysisOutputManifestSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('analysis.job.fail'), jobId: IdentifierSchema, executorId: IdentifierSchema, leaseToken: NonEmptyStringSchema.optional(), generation: z.number().int().positive().optional(), failure: z.object({ code: IdentifierSchema, summary: NonEmptyStringSchema }).strict() }),
  CommandEnvelopeSchema.extend({ type: z.literal('analysis.job.cancel'), jobId: IdentifierSchema, reason: NonEmptyStringSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('leaderboard.publish'), runId: IdentifierSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('leaderboard.invalidate'), entryId: IdentifierSchema, reason: NonEmptyStringSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('defect.record'), finding: DefectFindingSchema }),
  CommandEnvelopeSchema.extend({
    type: z.literal('failure-cluster.promote'), runId: IdentifierSchema, sourceJobId: IdentifierSchema, clusterId: IdentifierSchema,
    humanName: NonEmptyStringSchema, promotedCategory: DefectCategorySchema.exclude(['unknown']),
    promotedBy: z.object({ actorId: IdentifierSchema, authority: z.enum(['operator', 'reviewer']) }).strict(),
  }),
  CommandEnvelopeSchema.extend({ type: z.literal('defect.promote'), findingId: IdentifierSchema, pack: RegressionPackSchema, reproduction: ReproductionBundleSchema }),
  CommandEnvelopeSchema.extend({
    type: z.literal('regression.evaluate'), gateId: IdentifierSchema,
    baseline: z.object({ runId: IdentifierSchema, agentVariantId: IdentifierSchema }).strict(),
    candidate: z.object({ runId: IdentifierSchema, agentVariantId: IdentifierSchema }).strict(),
    rules: RegressionRulesSchema,
  }),
  CommandEnvelopeSchema.extend({ type: z.literal('report.generate'), reportId: IdentifierSchema, runIds: z.array(IdentifierSchema).min(1), methodologyVersion: NonEmptyStringSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('retention.set'), policy: RetentionPolicySchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('run.delete'), runId: IdentifierSchema, expectedImpactHash: z.string().regex(/^[a-f0-9]{64}$/u), confirmation: NonEmptyStringSchema }),
  CommandEnvelopeSchema.extend({ type: z.literal('insight.record'), insight: ProductInsightSchema }),
])
export type EvaluationCommand = z.infer<typeof EvaluationCommandSchema>

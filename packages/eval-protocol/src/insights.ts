import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema } from './common.js'

export const ProductInsightSchema = z.object({
  schemaVersion: z.literal(1),
  insightId: IdentifierSchema,
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
  failureCluster: NonEmptyStringSchema,
  affectedTaskRate: z.number().min(0).max(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  suspectedLayer: z.enum(['model', 'prompt', 'tool', 'runtime', 'environment', 'verifier']),
  confidence: z.number().min(0).max(1),
  recommendation: NonEmptyStringSchema,
  expectedMetric: NonEmptyStringSchema,
  regressionPackId: IdentifierSchema,
  owner: NonEmptyStringSchema,
  status: z.enum(['proposed', 'accepted', 'implemented', 'validated', 'rejected']),
  postFixValidationRefs: z.array(NonEmptyStringSchema),
  postFixCandidateRunId: IdentifierSchema.optional(),
  postFixGateId: IdentifierSchema.optional(),
}).superRefine((insight, ctx) => {
  if (insight.status === 'validated' && insight.postFixValidationRefs.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['postFixValidationRefs'], message: 'validated insights require post-fix evidence' })
  }
  if (insight.status === 'validated' && !insight.postFixCandidateRunId) ctx.addIssue({ code: 'custom', path: ['postFixCandidateRunId'], message: 'validated insights require a post-fix candidate run' })
  if (insight.status === 'validated' && !insight.postFixGateId) ctx.addIssue({ code: 'custom', path: ['postFixGateId'], message: 'validated insights require a passing regression gate' })
})

export type ProductInsight = z.infer<typeof ProductInsightSchema>

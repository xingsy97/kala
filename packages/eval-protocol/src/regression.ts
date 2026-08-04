import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from './common.js'

export const RegressionPackSchema = z.object({
  schemaVersion: z.literal(1),
  packId: IdentifierSchema,
  version: NonEmptyStringSchema,
  taskPackRef: NonEmptyStringSchema,
  environmentLockHashes: z.array(Sha256Schema).min(1),
  verifierSemanticsHash: Sha256Schema,
  faultScenarioIds: z.array(IdentifierSchema),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  owner: NonEmptyStringSchema,
  allowedFlakeRate: z.number().min(0).max(1),
  baselineEvidenceRefs: z.array(NonEmptyStringSchema).min(1),
  promotionSourceFindingId: IdentifierSchema,
})

export const RegressionRulesSchema = z.object({
  maxSuccessRateDropPp: z.number().nonnegative(),
  maxNewCriticalDefects: z.number().int().nonnegative(),
  maxTestGamingRate: z.number().min(0).max(1),
  maxP95CostIncreasePct: z.number().nonnegative(),
  allowedFlakeRate: z.number().min(0).max(1),
  confidenceLevel: z.number().gt(0).lt(1),
}).strict()

export const RegressionGateDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  gateId: IdentifierSchema,
  baselineRunId: IdentifierSchema.optional(),
  candidateRunId: IdentifierSchema.optional(),
  baselineConfigHash: Sha256Schema,
  candidateConfigHash: Sha256Schema,
  pairedTasks: z.number().int().positive(),
  repeats: z.number().int().positive(),
  confidenceLevel: z.number().min(0).max(1),
  flakyTasks: z.array(IdentifierSchema),
  infrastructureFailures: z.array(IdentifierSchema),
  violations: z.array(z.object({ rule: IdentifierSchema, observed: z.number(), threshold: z.number() })),
  statistics: z.object({
    baselineSuccessRate: z.number().min(0).max(1), candidateSuccessRate: z.number().min(0).max(1), successRateDelta: z.number().min(-1).max(1),
    pairedWins: z.number().int().nonnegative(), pairedLosses: z.number().int().nonnegative(), pairedTies: z.number().int().nonnegative(),
    mcnemarPValue: z.number().min(0).max(1),
    confidenceInterval: z.object({ level: z.number().min(0).max(1), lower: z.number(), upper: z.number(), method: z.literal('paired-bootstrap').optional(), samples: z.number().int().min(1_000).optional() }),
    repeatedRunVariance: z.object({ baseline: z.number().nonnegative(), candidate: z.number().nonnegative(), taskCount: z.number().int().nonnegative() }).strict().optional(),
    evidenceCompleteness: z.object({ baseline: z.number().min(0).max(1), candidate: z.number().min(0).max(1), completePairs: z.number().int().nonnegative(), totalPairs: z.number().int().positive() }).strict().optional(),
    pareto: z.object({ relation: z.enum(['candidate_dominates', 'baseline_dominates', 'tradeoff', 'equivalent', 'insufficient_evidence']), baseline: z.object({ quality: z.number().min(0).max(1), costUsd: z.number().nonnegative().nullable(), latencyMs: z.number().nonnegative().nullable() }), candidate: z.object({ quality: z.number().min(0).max(1), costUsd: z.number().nonnegative().nullable(), latencyMs: z.number().nonnegative().nullable() }) }).strict().optional(),
    taskDeltas: z.array(z.object({ taskId: IdentifierSchema, baseline: z.number().min(0).max(1), candidate: z.number().min(0).max(1), delta: z.number().min(-1).max(1), repeats: z.number().int().positive() }).strict()).optional(),
    flakeRate: z.number().min(0).max(1),
  }).strict().optional(),
  decision: z.enum(['pass', 'block', 'indeterminate']),
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
})

export type RegressionPack = z.infer<typeof RegressionPackSchema>
export type RegressionRules = z.infer<typeof RegressionRulesSchema>
export type RegressionGateDecision = z.infer<typeof RegressionGateDecisionSchema>

import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema } from './common.js'

export const DefectDetectorDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersions: z.array(z.number().int().positive()).min(1).default([1]),
  id: IdentifierSchema,
  version: NonEmptyStringSchema,
  capabilities: z.array(IdentifierSchema).min(1).default(['analyze']),
}).strict()

export const TaskConstraintSchema = z.object({
  id: IdentifierSchema,
  kind: z.enum(['must', 'must_not', 'scope', 'ordering', 'evidence']),
  sourceRef: NonEmptyStringSchema,
  verifierId: IdentifierSchema,
  verifierVersion: NonEmptyStringSchema,
  verifierMetric: IdentifierSchema.optional(),
})

export const ConstraintLifecycleSchema = z.object({
  constraintId: IdentifierSchema,
  state: z.enum(['introduced', 'acknowledged', 'acted_on', 'satisfied', 'violated', 'recovered']),
  eventSequence: z.number().int().nonnegative(),
  evidenceRefs: z.array(NonEmptyStringSchema),
})

export const DefectCategorySchema = z.enum([
  'instruction_drift',
  'context_forgetting',
  'test_gaming',
  'tool_recovery',
  'planning_execution',
  'trace_divergence',
  'unknown',
])

export const DefectFindingSchema = z.object({
  schemaVersion: z.literal(1),
  findingId: IdentifierSchema,
  detectorId: IdentifierSchema,
  detectorVersion: NonEmptyStringSchema,
  runId: IdentifierSchema,
  trialId: IdentifierSchema,
  category: DefectCategorySchema,
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(1),
  firstDivergenceSequence: z.number().int().nonnegative().optional(),
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
  status: z.enum(['detected', 'human_validated', 'rejected', 'promoted']),
})

export type TaskConstraint = z.infer<typeof TaskConstraintSchema>
export type ConstraintLifecycle = z.infer<typeof ConstraintLifecycleSchema>
export type DefectCategory = z.infer<typeof DefectCategorySchema>
export type DefectFinding = z.infer<typeof DefectFindingSchema>
export type DefectDetectorDescriptor = z.infer<typeof DefectDetectorDescriptorSchema>

export interface DefectDetector<AnalysisInput, ReproductionHarness, MinimalReproduction> {
  readonly descriptor: DefectDetectorDescriptor
  analyze(input: AnalysisInput): Promise<DefectFinding[]>
  minimize?(finding: DefectFinding, harness: ReproductionHarness): Promise<MinimalReproduction>
}

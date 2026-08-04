import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from './common.js'

export const ArchiveOutcomeSchema = z.enum(['passed', 'failed', 'unknown'])
export const ArchiveNativeMetricSchema = z.union([z.string(), z.number(), z.boolean()])

export const ArchiveTrialSummarySchema = z.object({
  trialId: IdentifierSchema,
  taskId: IdentifierSchema.optional(),
  agentVariantId: IdentifierSchema.optional(),
  benchmarkId: IdentifierSchema.optional(),
  evidenceLevel: NonEmptyStringSchema.optional(),
  outcome: ArchiveOutcomeSchema,
  nativeMetrics: z.record(z.string(), ArchiveNativeMetricSchema),
  normalizedEventCount: z.number().int().nonnegative().optional(),
  resultHash: Sha256Schema.optional(),
  artifactManifestHash: Sha256Schema.optional(),
}).strict()

export const ArchiveDocumentSummarySchema = z.object({
  documentId: IdentifierSchema,
  fileName: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  kind: z.enum(['lifecycle', 'reproduction', 'closed-loop', 'acceptance', 'other']),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  generatedAt: z.string().datetime().optional(),
  scope: NonEmptyStringSchema.optional(),
  runIds: z.array(IdentifierSchema),
}).strict()

export const ArchiveConclusionSchema = z.object({
  conclusionId: IdentifierSchema,
  kind: z.enum(['run-result', 'finding', 'reproduction', 'regression', 'insight', 'report', 'closed-loop']),
  title: NonEmptyStringSchema,
  status: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  confidence: z.number().min(0).max(1).optional(),
  recommendation: NonEmptyStringSchema.optional(),
  runIds: z.array(IdentifierSchema),
  evidenceRefs: z.array(NonEmptyStringSchema),
  sourceDocumentId: IdentifierSchema,
  data: z.unknown().optional(),
}).strict()

export const ArchivedRunSummarySchema = z.object({
  runId: IdentifierSchema,
  state: NonEmptyStringSchema,
  taskPackId: IdentifierSchema.optional(),
  generatedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  trialCount: z.number().int().nonnegative(),
  passedTrials: z.number().int().nonnegative(),
  failedTrials: z.number().int().nonnegative(),
  unknownTrials: z.number().int().nonnegative(),
  outcome: ArchiveOutcomeSchema,
  agentIds: z.array(IdentifierSchema),
  taskIds: z.array(IdentifierSchema),
  cleanupVerified: z.boolean().optional(),
  defectCount: z.number().int().nonnegative().optional(),
  sourceDocumentIds: z.array(IdentifierSchema),
  sourceFiles: z.array(NonEmptyStringSchema),
}).strict()

export const ArchivedRunDetailSchema = ArchivedRunSummarySchema.extend({
  trials: z.array(ArchiveTrialSummarySchema),
  conclusions: z.array(ArchiveConclusionSchema),
  documents: z.array(ArchiveDocumentSummarySchema),
  workerErrors: z.array(z.unknown()),
}).strict()

export const ArchiveSummarySchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  rootAvailable: z.boolean(),
  documentCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  trialCount: z.number().int().nonnegative(),
  passedTrials: z.number().int().nonnegative(),
  failedTrials: z.number().int().nonnegative(),
  unknownTrials: z.number().int().nonnegative(),
  conclusions: z.array(ArchiveConclusionSchema),
  latestRuns: z.array(ArchivedRunSummarySchema),
}).strict()

export type ArchiveTrialSummary = z.infer<typeof ArchiveTrialSummarySchema>
export type ArchiveDocumentSummary = z.infer<typeof ArchiveDocumentSummarySchema>
export type ArchiveConclusion = z.infer<typeof ArchiveConclusionSchema>
export type ArchivedRunSummary = z.infer<typeof ArchivedRunSummarySchema>
export type ArchivedRunDetail = z.infer<typeof ArchivedRunDetailSchema>
export type ArchiveSummary = z.infer<typeof ArchiveSummarySchema>

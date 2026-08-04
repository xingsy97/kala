import { z } from 'zod'

import { NormalizedAgentEventSchema } from './agent-backend.js'
import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema, canonicalJson, sha256Hex } from './common.js'
import { ConstraintLifecycleSchema, DefectCategorySchema, TaskConstraintSchema } from './defects.js'
import { FailureCategorySchema } from './failure.js'

export const MemoryProbeSchema = z.object({
  probeId: IdentifierSchema, introducedSequence: z.number().int().nonnegative(), observedSequence: z.number().int().nonnegative(),
  kind: z.enum(['retention', 'correction', 'deletion', 'isolation', 'compaction']),
  outcome: z.enum(['retained', 'forgotten', 'stale_used', 'deletion_ignored', 'cross_contaminated', 'post_compaction_violation']),
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
}).strict()

export const ToolAttemptSchema = z.object({
  sequence: z.number().int().nonnegative(), tool: IdentifierSchema, schemaValid: z.boolean(), executable: z.boolean(),
  outcome: z.enum(['success', 'failure', 'indeterminate']), failureCategory: FailureCategorySchema.optional(),
  observedStateSufficientForRecovery: z.boolean(), replayOfSequence: z.number().int().nonnegative().optional(),
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
}).strict()

export const PlanStepEvidenceSchema = z.object({
  stepId: IdentifierSchema, prerequisiteStepIds: z.array(IdentifierSchema), critical: z.boolean(),
  startedSequence: z.number().int().nonnegative().optional(), completedSequence: z.number().int().nonnegative().optional(),
  verifiedSequence: z.number().int().nonnegative().optional(), abandoned: z.boolean(),
  contradictionSequence: z.number().int().nonnegative().optional(), replannedSequence: z.number().int().nonnegative().optional(),
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
}).strict()

export const WorkspaceIntegrityEvidenceSchema = z.object({
  changedPaths: z.array(NonEmptyStringSchema), deletedPaths: z.array(NonEmptyStringSchema),
  protectedPaths: z.array(NonEmptyStringSchema), hiddenVerifierPaths: z.array(NonEmptyStringSchema),
  verifierLeakagePaths: z.array(NonEmptyStringSchema), suspiciousLiteralEvidenceRefs: z.array(NonEmptyStringSchema),
}).strict()

export const VerifierIntegrityEvidenceSchema = z.object({
  passed: z.boolean(), protectedIntegrityPassed: z.boolean(), hiddenVerifierPassed: z.boolean(),
  selectedTestFraction: z.number().min(0).max(1), mutationScore: z.number().min(0).max(1).optional(),
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
}).strict()

export const AnalyzerInputSchema = z.object({
  schemaVersion: z.literal(1), runId: IdentifierSchema, trialId: IdentifierSchema, taskId: IdentifierSchema,
  traceHash: Sha256Schema, projectionHash: Sha256Schema, normalizationVersion: NonEmptyStringSchema,
  events: z.array(NormalizedAgentEventSchema), constraints: z.array(TaskConstraintSchema),
  constraintLifecycle: z.array(ConstraintLifecycleSchema), memoryProbes: z.array(MemoryProbeSchema),
  toolAttempts: z.array(ToolAttemptSchema), planSteps: z.array(PlanStepEvidenceSchema),
  workspaceIntegrity: WorkspaceIntegrityEvidenceSchema, verifierIntegrity: VerifierIntegrityEvidenceSchema,
  inputManifestHash: Sha256Schema,
}).strict().superRefine((input, ctx) => {
  for (let index = 0; index < input.events.length; index += 1) {
    if (input.events[index]!.sequence !== index) ctx.addIssue({ code: 'custom', path: ['events', index, 'sequence'], message: 'normalized analyzer events must be contiguous' })
    if (!input.events[index]!.nativeEventRef) ctx.addIssue({ code: 'custom', path: ['events', index, 'nativeEventRef'], message: 'analyzer events must reference immutable native evidence' })
  }
  const nativeRefs = input.events.map((event) => event.nativeEventRef).filter((value): value is string => value !== undefined)
  if (new Set(nativeRefs).size !== nativeRefs.length) ctx.addIssue({ code: 'custom', path: ['events'], message: 'analyzer native event references must be unique' })
  const constraints = new Set(input.constraints.map((constraint) => constraint.id))
  for (const [index, lifecycle] of input.constraintLifecycle.entries()) {
    if (!constraints.has(lifecycle.constraintId)) ctx.addIssue({ code: 'custom', path: ['constraintLifecycle', index, 'constraintId'], message: 'constraint lifecycle references an unknown constraint' })
  }
})

export const DetectorValidationReportSchema = z.object({
  schemaVersion: z.literal(1), corpusId: IdentifierSchema, corpusVersion: NonEmptyStringSchema, corpusManifestHash: Sha256Schema,
  detectorId: IdentifierSchema, detectorVersion: NonEmptyStringSchema, cases: z.number().int().positive(),
  truePositive: z.number().int().nonnegative(), falsePositive: z.number().int().nonnegative(),
  trueNegative: z.number().int().nonnegative(), falseNegative: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1), recall: z.number().min(0).max(1), f1: z.number().min(0).max(1),
  confidenceIntervals: z.object({
    method: z.literal('group-bootstrap'), confidenceLevel: z.literal(0.95), samples: z.number().int().positive(), seed: z.number().int().nonnegative(),
    precision: z.object({ lower: z.number().min(0).max(1), upper: z.number().min(0).max(1) }).strict(),
    recall: z.object({ lower: z.number().min(0).max(1), upper: z.number().min(0).max(1) }).strict(),
    f1: z.object({ lower: z.number().min(0).max(1), upper: z.number().min(0).max(1) }).strict(),
  }).strict().optional(),
  calibration: z.object({ brier: z.number().min(0).max(1), ece: z.number().min(0).max(1), bins: z.number().int().positive() }).strict().optional(),
  annotation: z.object({ annotatedCases: z.number().int().nonnegative(), doubleAnnotatedCases: z.number().int().nonnegative(), agreement: z.number().min(0).max(1), adjudicatedCases: z.number().int().nonnegative() }).strict().optional(),
  generatedAt: z.string().datetime(),
}).strict().superRefine((report, ctx) => {
  if (report.truePositive + report.falsePositive + report.trueNegative + report.falseNegative !== report.cases) {
    ctx.addIssue({ code: 'custom', path: ['cases'], message: 'validation confusion-matrix counts must equal cases' })
  }
})

export const DetectorValidationCaseMetadataSchema = z.object({
  provenance: z.enum(['recorded-normalized-trace', 'synthetic-derived']), sourceEvidenceRef: NonEmptyStringSchema,
  agentId: IdentifierSchema, groupId: IdentifierSchema, split: z.enum(['train', 'holdout']),
  difficulty: z.enum(['standard', 'difficult-negative', 'missing-evidence']),
  transformations: z.array(z.enum(['redacted', 'noise-injected', 'evidence-removed', 'none'])).min(1),
  annotation: z.object({
    guidelineVersion: NonEmptyStringSchema, annotatedAt: z.string().datetime(), annotatorIds: z.array(IdentifierSchema).min(1),
    labels: z.array(z.boolean()).min(1), adjudicatedLabel: z.boolean(), adjudicatorId: IdentifierSchema.optional(), notes: NonEmptyStringSchema.optional(),
  }).strict().superRefine((annotation, ctx) => {
    if (new Set(annotation.labels).size > 1 && !annotation.adjudicatorId) ctx.addIssue({ code: 'custom', path: ['adjudicatorId'], message: 'disagreements require adjudication' })
  }),
}).strict()

export const DetectorValidationManifestSchema = z.object({
  schemaVersion: z.literal(1), corpusId: IdentifierSchema, corpusVersion: NonEmptyStringSchema,
  provenanceStatement: NonEmptyStringSchema, generatedFrom: z.array(NonEmptyStringSchema).min(1),
  cases: z.array(z.object({ caseId: IdentifierSchema, detectorId: IdentifierSchema, inputManifestHash: Sha256Schema, metadata: DetectorValidationCaseMetadataSchema }).strict()).min(1),
  manifestHash: Sha256Schema,
}).strict().superRefine((manifest, ctx) => {
  const groups = new Map<string, string>()
  for (const [index, entry] of manifest.cases.entries()) {
    const previous = groups.get(entry.metadata.groupId)
    if (previous && previous !== entry.metadata.split) ctx.addIssue({ code: 'custom', path: ['cases', index, 'metadata', 'groupId'], message: 'group cannot cross train/holdout boundary' })
    groups.set(entry.metadata.groupId, entry.metadata.split)
  }
})

export const TraceAlignmentResultSchema = z.object({
  schemaVersion: z.literal(1), leftTrialId: IdentifierSchema, rightTrialId: IdentifierSchema,
  leftOutcome: z.enum(['success', 'failure']), rightOutcome: z.enum(['success', 'failure']),
  commonPrefixLength: z.number().int().nonnegative(), firstDivergence: z.object({
    leftSequence: z.number().int().nonnegative().optional(), rightSequence: z.number().int().nonnegative().optional(),
    leftKind: NonEmptyStringSchema.optional(), rightKind: NonEmptyStringSchema.optional(),
    leftSignature: Sha256Schema.optional(), rightSignature: Sha256Schema.optional(),
  }).strict().optional(), alignedPairs: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
  missingSuccessfulAction: z.object({
    successfulTrialId: IdentifierSchema, failedTrialId: IdentifierSchema, sequence: z.number().int().nonnegative(),
    kind: NonEmptyStringSchema, signature: Sha256Schema,
  }).strict().optional(),
  additionalLoopCost: z.number().int().nonnegative(),
  costAfterDivergence: z.object({
    leftEvents: z.number().int().nonnegative(), rightEvents: z.number().int().nonnegative(),
    leftWallMs: z.number().int().nonnegative(), rightWallMs: z.number().int().nonnegative(),
    leftCostUsd: z.number().nonnegative(), rightCostUsd: z.number().nonnegative(),
  }).strict(),
}).strict().superRefine((alignment, ctx) => {
  if (alignment.missingSuccessfulAction && alignment.leftOutcome === alignment.rightOutcome) {
    ctx.addIssue({ code: 'custom', path: ['missingSuccessfulAction'], message: 'a missing successful action requires different trial outcomes' })
  }
})

export const FailureClusterSchema = z.object({
  schemaVersion: z.literal(1), clusterId: IdentifierSchema, signature: Sha256Schema, memberFindingIds: z.array(IdentifierSchema).min(1),
  method: z.literal('deterministic-action-error-signature'), status: z.enum(['unknown', 'human_named']),
  humanName: NonEmptyStringSchema.optional(), promotedCategory: DefectCategorySchema.exclude(['unknown']).optional(),
}).strict().superRefine((cluster, ctx) => {
  if (cluster.status === 'human_named' && (!cluster.humanName || !cluster.promotedCategory)) ctx.addIssue({ code: 'custom', message: 'human-named clusters require a name and promoted category' })
  if (cluster.status === 'unknown' && (cluster.humanName || cluster.promotedCategory)) ctx.addIssue({ code: 'custom', message: 'unknown clusters cannot enter the canonical taxonomy before human promotion' })
})

export const FailureClusterPromotionSchema = z.object({
  schemaVersion: z.literal(1), promotionId: IdentifierSchema, sourceJobId: IdentifierSchema, runId: IdentifierSchema,
  cluster: FailureClusterSchema,
  promotedBy: z.object({ actorId: IdentifierSchema, authority: z.enum(['operator', 'reviewer']) }).strict(),
  promotedAt: z.string().datetime(),
}).strict().superRefine((promotion, ctx) => {
  if (promotion.cluster.status !== 'human_named') ctx.addIssue({ code: 'custom', path: ['cluster', 'status'], message: 'promotion records require a human-named cluster' })
})

export const CounterfactualInterventionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('corrected_action'), actionKind: z.enum(['tool_call', 'command']), replacement: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal('different_backend'), backendId: IdentifierSchema, agentVersion: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal('different_model'), modelId: NonEmptyStringSchema, configHash: Sha256Schema }).strict(),
  z.object({ kind: z.literal('corrected_tool_result'), toolCallSequence: z.number().int().nonnegative(), resultArtifactRef: NonEmptyStringSchema, resultSha256: Sha256Schema }).strict(),
  z.object({ kind: z.literal('fault_removed'), faultScenarioId: IdentifierSchema }).strict(),
])

export const CounterfactualContinuationRequestSchema = z.object({
  schemaVersion: z.literal(1), requestId: IdentifierSchema, sourceTrialId: IdentifierSchema,
  checkpointSequence: z.number().int().nonnegative(), sourceFailureFingerprint: Sha256Schema,
  interventions: z.array(CounterfactualInterventionSchema).min(1),
}).strict().superRefine((request, ctx) => {
  const kinds = request.interventions.map((intervention) => intervention.kind)
  if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: 'custom', path: ['interventions'], message: 'counterfactual intervention kinds must be unique' })
})

export const CounterfactualResultSchema = z.object({
  schemaVersion: z.literal(1), counterfactualId: IdentifierSchema, sourceTrialId: IdentifierSchema, checkpointSequence: z.number().int().nonnegative(),
  intervention: z.enum(['corrected_action', 'different_backend', 'different_model', 'corrected_tool_result', 'fault_removed']),
  checkpointHash: Sha256Schema, continuationHash: Sha256Schema,
  outcome: z.enum(['resolved', 'same_failure', 'different_failure', 'infrastructure_error']),
  observedFailureFingerprint: Sha256Schema.optional(), evidenceRefs: z.array(NonEmptyStringSchema).min(1),
  continuationEvents: z.array(NormalizedAgentEventSchema).min(1),
}).strict().superRefine((result, ctx) => {
  if ((result.outcome === 'same_failure' || result.outcome === 'different_failure') && !result.observedFailureFingerprint) {
    ctx.addIssue({ code: 'custom', path: ['observedFailureFingerprint'], message: 'failure outcomes require an observed failure fingerprint' })
  }
  if ((result.outcome === 'resolved' || result.outcome === 'infrastructure_error') && result.observedFailureFingerprint) {
    ctx.addIssue({ code: 'custom', path: ['observedFailureFingerprint'], message: 'non-failure outcomes cannot carry a failure fingerprint' })
  }
  for (const [index, event] of result.continuationEvents.entries()) {
    if (event.sequence !== result.checkpointSequence + index + 1) ctx.addIssue({ code: 'custom', path: ['continuationEvents', index, 'sequence'], message: 'counterfactual continuation events must resume contiguously after the checkpoint' })
  }
})

export type AnalyzerInput = z.infer<typeof AnalyzerInputSchema>
export type MemoryProbe = z.infer<typeof MemoryProbeSchema>
export type ToolAttempt = z.infer<typeof ToolAttemptSchema>
export type PlanStepEvidence = z.infer<typeof PlanStepEvidenceSchema>
export type DetectorValidationReport = z.infer<typeof DetectorValidationReportSchema>
export type DetectorValidationCaseMetadata = z.infer<typeof DetectorValidationCaseMetadataSchema>
export type DetectorValidationManifest = z.infer<typeof DetectorValidationManifestSchema>
export type TraceAlignmentResult = z.infer<typeof TraceAlignmentResultSchema>
export type FailureCluster = z.infer<typeof FailureClusterSchema>
export type FailureClusterPromotion = z.infer<typeof FailureClusterPromotionSchema>
export type CounterfactualIntervention = z.infer<typeof CounterfactualInterventionSchema>
export type CounterfactualContinuationRequest = z.infer<typeof CounterfactualContinuationRequestSchema>
export type CounterfactualResult = z.infer<typeof CounterfactualResultSchema>

export async function counterfactualFailureFingerprint(events: readonly z.infer<typeof NormalizedAgentEventSchema>[], checkpointSequence: number): Promise<string> {
  if (!Number.isSafeInteger(checkpointSequence) || checkpointSequence < 0 || checkpointSequence >= events.length - 1) throw new Error('counterfactual failure fingerprint requires a non-terminal checkpoint')
  return await sha256Hex(canonicalJson({ schemaVersion: 1, checkpointSequence, failureSuffix: events.slice(checkpointSequence + 1) }))
}

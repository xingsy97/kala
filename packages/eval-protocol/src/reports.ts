import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema, Sha256Schema, canonicalJson, sha256Hex } from './common.js'
import { DefectFindingSchema } from './defects.js'
import { ProductInsightSchema } from './insights.js'
import { CapabilityVectorSchema } from './methodology.js'
import { RegressionGateDecisionSchema } from './regression.js'
import { ReproductionBundleSchema } from './reproduction.js'

export const REPORT_FORMATS = ['json', 'csv', 'html', 'pdf', 'junit', 'sarif', 'markdown'] as const
export const ReportFormatSchema = z.enum(REPORT_FORMATS)
export type ReportFormat = z.infer<typeof ReportFormatSchema>

/** The canonical fields represented by each transport format. */
export const REPORT_FORMAT_FIELD_MAPPINGS = {
  json: ['report', 'runs', 'trials', 'capabilityVectors', 'defects', 'reproductions', 'regressionDecisions', 'insights'],
  csv: ['trials'],
  html: ['report', 'runs', 'trials', 'capabilityVectors', 'defectCounts', 'reproductionCounts', 'regressionCounts'],
  pdf: ['report', 'runs', 'trials', 'capabilityVectors', 'defectCounts', 'reproductionCounts', 'regressionCounts'],
  junit: ['report', 'trials'],
  sarif: ['report', 'defects'],
  markdown: ['report', 'runs', 'trials', 'capabilityVectors', 'defectCounts', 'reproductionCounts', 'regressionCounts'],
} as const satisfies Record<ReportFormat, readonly string[]>

export const CanonicalReportTrialSchema = z.object({
  runId: IdentifierSchema, trialId: IdentifierSchema, taskId: IdentifierSchema, repeatIndex: z.number().int().nonnegative(),
  agentVariantId: IdentifierSchema, backendId: IdentifierSchema, model: NonEmptyStringSchema, benchmarkId: IdentifierSchema,
  verifier: NonEmptyStringSchema, evidenceLevel: NonEmptyStringSchema, primaryMetric: IdentifierSchema,
  primaryValue: z.union([z.number(), z.string(), z.boolean()]), passed: z.boolean(), inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(), costUsd: z.number().nonnegative().nullable(), resultHash: Sha256Schema,
  artifactManifestHash: Sha256Schema,
})

export const CanonicalReportRunSchema = z.object({
  runId: IdentifierSchema, specHash: Sha256Schema, dataset: NonEmptyStringSchema, datasetVersion: NonEmptyStringSchema,
  sliceId: IdentifierSchema, sliceManifestHash: Sha256Schema, selectedItems: z.number().int().positive(), repeats: z.number().int().positive(),
  expectedTrials: z.number().int().positive(), completedTrials: z.number().int().positive(), agents: z.array(IdentifierSchema).min(1),
  sandboxProvider: NonEmptyStringSchema, imageDigest: NonEmptyStringSchema, verifier: NonEmptyStringSchema,
})

export const CanonicalReportModelSchema = z.object({
  schemaVersion: z.literal(1), reportId: IdentifierSchema, generatedAt: z.string().datetime(), methodologyVersion: NonEmptyStringSchema,
  inputEvidenceHash: Sha256Schema, semanticHash: Sha256Schema, runRefs: z.array(IdentifierSchema).min(1),
  sections: z.array(NonEmptyStringSchema).length(10), runs: z.array(CanonicalReportRunSchema).min(1),
  trials: z.array(CanonicalReportTrialSchema).min(1), capabilityVectors: z.array(CapabilityVectorSchema),
  defects: z.array(DefectFindingSchema), reproductions: z.array(ReproductionBundleSchema),
  regressionDecisions: z.array(RegressionGateDecisionSchema), insights: z.array(ProductInsightSchema),
  limitations: z.array(NonEmptyStringSchema),
}).superRefine((report, ctx) => {
  if (report.trials.length !== report.runs.reduce((sum, run) => sum + run.completedTrials, 0)) ctx.addIssue({ code: 'custom', path: ['trials'], message: 'trial count does not match run summaries' })
  if (report.runs.some((run) => run.expectedTrials !== run.completedTrials)) ctx.addIssue({ code: 'custom', path: ['runs'], message: 'canonical report requires complete runs' })
})

export type CanonicalReportModel = z.infer<typeof CanonicalReportModelSchema>
export type CanonicalReportTrial = z.infer<typeof CanonicalReportTrialSchema>
export type CanonicalReportRun = z.infer<typeof CanonicalReportRunSchema>

export async function reportSemanticHash(report: Omit<CanonicalReportModel, 'semanticHash'> | CanonicalReportModel): Promise<string> {
  const { generatedAt: _generatedAt, semanticHash: _semanticHash, ...semantic } = report as CanonicalReportModel
  return await sha256Hex(canonicalJson(semantic))
}

export async function verifyCanonicalReportModel(value: unknown): Promise<CanonicalReportModel> {
  const report = CanonicalReportModelSchema.parse(value)
  if (await reportSemanticHash(report) !== report.semanticHash) throw new Error('canonical report semantic hash mismatch')
  return report
}

export const ReportManifestSchema = z.object({
  schemaVersion: z.literal(1),
  reportId: IdentifierSchema,
  inputEvidenceHash: Sha256Schema,
  semanticHash: Sha256Schema,
  runRefs: z.array(IdentifierSchema).min(1),
  formats: z.array(z.object({
    format: ReportFormatSchema,
    path: RelativeArtifactPathSchema,
    sha256: Sha256Schema,
  })),
  methodologyVersion: NonEmptyStringSchema,
  includesAllConfiguredRepeats: z.literal(true),
  redactionPassed: z.literal(true),
  generatedAt: z.string().datetime(),
}).superRefine((report, ctx) => {
  const present = new Set(report.formats.map((entry) => entry.format))
  for (const format of REPORT_FORMATS) {
    if (!present.has(format)) ctx.addIssue({ code: 'custom', path: ['formats'], message: 'missing required report format: ' + format })
  }
})

export type ReportManifest = z.infer<typeof ReportManifestSchema>

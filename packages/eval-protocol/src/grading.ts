import { z } from 'zod'

import { EvidenceLevelSchema } from './agent-backend.js'
import { BenchmarkNativeResultSchema } from './benchmark.js'
import { IdentifierSchema, Sha256Schema } from './common.js'

export const GradingResultSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: IdentifierSchema,
  runId: IdentifierSchema,
  trialId: IdentifierSchema,
  taskId: IdentifierSchema,
  agentVariantId: IdentifierSchema,
  sourceResultHash: Sha256Schema,
  sourceArtifactManifestHash: Sha256Schema,
  rawArtifactSha256: Sha256Schema,
  evidenceLevel: EvidenceLevelSchema,
  officialRequired: z.boolean(),
  eligible: z.boolean(),
  benchmarkResult: BenchmarkNativeResultSchema,
  verifiedAt: z.string().datetime(),
}).strict().superRefine((result, ctx) => {
  const official = result.evidenceLevel === 'official' && result.benchmarkResult.officialEvidence
  if (result.officialRequired && !official) ctx.addIssue({ code: 'custom', path: ['eligible'], message: 'official-required grading needs official evidence' })
  if (result.eligible !== (!result.officialRequired || official)) ctx.addIssue({ code: 'custom', path: ['eligible'], message: 'grading eligibility does not match immutable official-evidence policy' })
})

export type GradingResult = z.infer<typeof GradingResultSchema>

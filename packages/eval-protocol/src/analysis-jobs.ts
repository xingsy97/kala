import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema, Sha256Schema } from './common.js'
import { CounterfactualContinuationRequestSchema } from './analyzer.js'

export const AnalysisJobStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
export const AnalysisJobKindSchema = z.enum(['grading', 'detectors', 'trace-alignment', 'clustering', 'counterfactual', 'minimization', 'report', 'regression-gate'])

export const AnalysisOutputManifestSchema = z.object({
  schemaVersion: z.literal(1), jobId: IdentifierSchema, runId: IdentifierSchema, inputManifestHash: Sha256Schema,
  generatedAt: z.string().datetime(), outputs: z.array(z.object({
    outputId: IdentifierSchema, kind: z.enum(['grading-result', 'finding', 'trace', 'trace-alignment', 'failure-cluster', 'counterfactual', 'reproduction', 'report', 'regression-decision']),
    artifactRef: RelativeArtifactPathSchema, mediaType: NonEmptyStringSchema, bytes: z.number().int().nonnegative(), sha256: Sha256Schema,
  }).strict()), manifestHash: Sha256Schema,
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.outputs.map((output) => output.outputId)).size !== manifest.outputs.length) ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'analysis output IDs must be unique' })
  if (new Set(manifest.outputs.map((output) => output.artifactRef)).size !== manifest.outputs.length) ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'analysis output artifact refs must be unique' })
})

export const AnalysisJobSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1).default(1), jobId: IdentifierSchema, runId: IdentifierSchema,
  kind: AnalysisJobKindSchema,
  inputRefs: z.array(NonEmptyStringSchema).min(1), inputManifestHash: Sha256Schema,
  implementationId: IdentifierSchema, implementationVersion: NonEmptyStringSchema, configHash: Sha256Schema,
  detectorIds: z.array(IdentifierSchema).min(1).optional(), attempt: z.number().int().nonnegative(), generation: z.number().int().nonnegative().optional(),
  counterfactualRequest: CounterfactualContinuationRequestSchema.optional(),
  state: AnalysisJobStateSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  executorId: IdentifierSchema.optional(), startedAt: z.string().datetime().optional(), finishedAt: z.string().datetime().optional(),
  heartbeatAt: z.string().datetime().optional(), leaseExpiresAt: z.string().datetime().optional(), leaseToken: NonEmptyStringSchema.optional(),
  outputManifestRef: RelativeArtifactPathSchema.optional(), outputManifestHash: Sha256Schema.optional(),
  failure: z.object({ code: IdentifierSchema, summary: NonEmptyStringSchema }).strict().optional(),
}).strict().superRefine((job, ctx) => {
  if (new Set(job.inputRefs).size !== job.inputRefs.length) ctx.addIssue({ code: 'custom', path: ['inputRefs'], message: 'analysis job input refs must be unique' })
  if (job.kind === 'detectors' && !job.detectorIds) ctx.addIssue({ code: 'custom', path: ['detectorIds'], message: 'detector jobs require immutable detector IDs' })
  if (job.kind !== 'detectors' && job.detectorIds) ctx.addIssue({ code: 'custom', path: ['detectorIds'], message: 'only detector jobs may carry detector IDs' })
  if (job.kind === 'counterfactual' && !job.counterfactualRequest) ctx.addIssue({ code: 'custom', path: ['counterfactualRequest'], message: 'counterfactual jobs require an immutable continuation request' })
  if (job.kind !== 'counterfactual' && job.counterfactualRequest) ctx.addIssue({ code: 'custom', path: ['counterfactualRequest'], message: 'only counterfactual jobs may carry a continuation request' })
  if (job.detectorIds && new Set(job.detectorIds).size !== job.detectorIds.length) ctx.addIssue({ code: 'custom', path: ['detectorIds'], message: 'detector IDs must be unique' })
  if (job.state === 'queued' && (job.executorId || job.startedAt || job.finishedAt || job.heartbeatAt || job.leaseExpiresAt || job.leaseToken || job.outputManifestRef || job.outputManifestHash || job.failure)) {
    ctx.addIssue({ code: 'custom', message: 'queued analysis jobs cannot carry execution or output state' })
  }
  if (['running', 'completed', 'failed'].includes(job.state) && !job.executorId) ctx.addIssue({ code: 'custom', path: ['executorId'], message: 'started analysis jobs require executor identity' })
  if (['running', 'completed', 'failed'].includes(job.state) && !job.startedAt) ctx.addIssue({ code: 'custom', path: ['startedAt'], message: 'started analysis jobs require startedAt' })
  if (job.state === 'running' && (!job.heartbeatAt || !job.leaseExpiresAt || !job.leaseToken)) ctx.addIssue({ code: 'custom', message: 'running analysis jobs require a renewable fenced lease' })
  if (job.state === 'completed' && (!job.finishedAt || !job.outputManifestRef || !job.outputManifestHash || job.failure)) {
    ctx.addIssue({ code: 'custom', message: 'completed analysis jobs require an output manifest and cannot carry a failure' })
  }
  if (job.state === 'failed' && (!job.finishedAt || !job.failure || job.outputManifestRef || job.outputManifestHash)) {
    ctx.addIssue({ code: 'custom', message: 'failed analysis jobs require a failure and cannot carry output authority' })
  }
  if (job.state === 'cancelled' && (!job.finishedAt || !job.failure || job.outputManifestRef || job.outputManifestHash)) {
    ctx.addIssue({ code: 'custom', message: 'cancelled analysis jobs require a reason and cannot carry output authority' })
  }
  if (job.state === 'cancelled' && Boolean(job.executorId) !== Boolean(job.startedAt)) ctx.addIssue({ code: 'custom', message: 'cancelled analysis jobs must carry both or neither executorId and startedAt' })
  if (job.state === 'running' && (job.finishedAt || job.outputManifestRef || job.outputManifestHash || job.failure)) {
    ctx.addIssue({ code: 'custom', message: 'running analysis jobs cannot carry terminal state' })
  }
})
export type AnalysisJob = z.infer<typeof AnalysisJobSchema>
export type AnalysisJobKind = z.infer<typeof AnalysisJobKindSchema>
export type AnalysisJobState = z.infer<typeof AnalysisJobStateSchema>
export type AnalysisOutputManifest = z.infer<typeof AnalysisOutputManifestSchema>

export function assertAnalysisJobTransition(current: AnalysisJobState, next: AnalysisJobState): void {
  const allowed: Readonly<Record<AnalysisJobState, readonly AnalysisJobState[]>> = {
    queued: ['running', 'cancelled'], running: ['running', 'queued', 'completed', 'failed', 'cancelled'], completed: [], failed: [], cancelled: [],
  }
  if (!allowed[current].includes(next)) throw new Error('invalid analysis job state transition: ' + current + ' -> ' + next)
}

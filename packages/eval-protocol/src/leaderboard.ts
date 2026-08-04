import { z } from 'zod'

import { EvidenceLevelSchema } from './agent-backend.js'
import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from './common.js'
import { EvaluatedSliceSchema, type EvaluatedSlice } from './datasets.js'

export const LeaderboardEntrySchema = z.object({
  schemaVersion: z.literal(1),
  entryId: IdentifierSchema,
  model: z.object({
    provider: NonEmptyStringSchema.optional(),
    modelId: NonEmptyStringSchema,
    modelVersion: NonEmptyStringSchema.optional(),
  }),
  agent: z.object({
    type: z.enum(['agent-runlab', 'claude-code', 'codex']),
    version: NonEmptyStringSchema,
    configHash: Sha256Schema,
  }),
  evaluatedSlice: EvaluatedSliceSchema,
  verifierVersion: NonEmptyStringSchema,
  repeatPolicyHash: Sha256Schema,
  repeats: z.number().int().positive(),
  completedTrials: z.number().int().nonnegative(),
  expectedTrials: z.number().int().positive(),
  primaryMetric: z.object({ name: NonEmptyStringSchema, value: z.number(), unit: NonEmptyStringSchema }),
  confidenceInterval: z.object({ level: z.number().min(0).max(1), lower: z.number(), upper: z.number() }).optional(),
  secondaryMetrics: z.record(z.string(), z.number()),
  evidenceLevel: EvidenceLevelSchema,
  runRefs: z.array(IdentifierSchema).min(1),
  publishedAt: z.string().datetime(),
  status: z.enum(['active', 'superseded', 'invalidated']),
}).superRefine((entry, ctx) => {
  if (entry.evidenceLevel === 'smoke') {
    ctx.addIssue({ code: 'custom', path: ['evidenceLevel'], message: 'smoke evidence cannot enter a Leaderboard' })
  }
  if (entry.completedTrials !== entry.expectedTrials) {
    ctx.addIssue({ code: 'custom', path: ['completedTrials'], message: 'incomplete entries are not rank eligible' })
  }
  if (entry.evaluatedSlice.dataset.officialBenchmark && entry.evidenceLevel !== 'official') {
    ctx.addIssue({ code: 'custom', path: ['evidenceLevel'], message: 'official benchmark ranking requires official evidence' })
  }
})

export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>

export function leaderboardComparabilityKey(input: {
  evaluatedSlice: EvaluatedSlice
  verifierVersion: string
  repeatPolicyHash: string
  evidenceLevel: string
}): string {
  const slice = input.evaluatedSlice
  return [
    slice.dataset.datasetId,
    slice.dataset.version,
    slice.dataset.split ?? '',
    slice.sliceManifestHash,
    input.verifierVersion,
    input.repeatPolicyHash,
    input.evidenceLevel,
  ].join('|')
}

export function areRankComparable(left: LeaderboardEntry, right: LeaderboardEntry): boolean {
  return leaderboardComparabilityKey(left) === leaderboardComparabilityKey(right)
}

export function leaderboardCompetitorKey(entry: LeaderboardEntry): string {
  return [
    leaderboardComparabilityKey(entry),
    entry.agent.type,
    entry.agent.version,
    entry.agent.configHash,
    entry.model.provider ?? '',
    entry.model.modelId,
    entry.model.modelVersion ?? '',
  ].join('|')
}

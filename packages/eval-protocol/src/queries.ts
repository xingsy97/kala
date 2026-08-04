import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from './common.js'
import { AnalysisJobKindSchema } from './analysis-jobs.js'

export const PageRequestSchema = z.object({ cursor: NonEmptyStringSchema.optional(), limit: z.number().int().min(1).max(500).default(50) })
export const PageInfoSchema = z.object({ nextCursor: NonEmptyStringSchema.optional(), hasMore: z.boolean(), total: z.number().int().nonnegative().optional() })
export const ControlPlaneCapabilitiesSchema = z.object({
  schemaVersion: z.literal(1), protocolVersions: z.array(z.number().int().positive()).min(1),
  controlPlaneVersion: NonEmptyStringSchema, commands: z.array(NonEmptyStringSchema), queryResources: z.array(NonEmptyStringSchema),
  liveEvents: z.enum(['sse', 'websocket', 'both']), standalone: z.literal(true), cleanCutover: z.literal(true),
  deprecatedCompatibilitySurfaces: z.tuple([]),
})
export const EvaluationQuerySchema = z.discriminatedUnion('resource', [
  z.object({ resource: z.literal('capabilities') }),
  z.object({ resource: z.literal('platform-metrics') }),
  z.object({ resource: z.literal('runs'), page: PageRequestSchema, state: NonEmptyStringSchema.optional(), search: NonEmptyStringSchema.optional() }),
  z.object({ resource: z.literal('run'), runId: IdentifierSchema }),
  z.object({ resource: z.literal('events'), runId: IdentifierSchema, afterSequence: z.number().int().min(-1), page: PageRequestSchema }),
  z.object({ resource: z.literal('trials'), runId: IdentifierSchema, page: PageRequestSchema, state: NonEmptyStringSchema.optional(), agentVariantId: IdentifierSchema.optional(), taskId: IdentifierSchema.optional() }),
  z.object({ resource: z.literal('trial'), trialId: IdentifierSchema }),
  z.object({ resource: z.literal('task'), taskId: IdentifierSchema }),
  z.object({ resource: z.literal('catalog'), catalog: z.enum(['agents', 'datasets', 'tasks', 'task-packs', 'sandboxes', 'verifiers', 'detectors']), page: PageRequestSchema, search: NonEmptyStringSchema.optional() }),
  z.object({ resource: z.literal('artifacts'), runId: IdentifierSchema, trialId: IdentifierSchema.optional(), mediaType: NonEmptyStringSchema.optional(), classification: NonEmptyStringSchema.optional(), page: PageRequestSchema }),
  z.object({
    resource: z.literal('leaderboard'),
    pivot: z.enum(['model', 'agent_type', 'test_dataset']),
    sliceManifestHash: Sha256Schema,
    view: z.enum(['active', 'audit']).optional(),
    agentType: z.enum(['agent-runlab', 'claude-code', 'codex']).optional(),
    modelId: NonEmptyStringSchema.optional(),
    sortBy: z.enum(['primary_metric', 'cost', 'p50_duration', 'p95_duration', 'published_at']).optional(),
    sortDirection: z.enum(['asc', 'desc']).optional(),
    page: PageRequestSchema,
  }),
  z.object({ resource: z.literal('defects'), runId: IdentifierSchema.optional(), category: NonEmptyStringSchema.optional(), status: NonEmptyStringSchema.optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('analysis-jobs'), runId: IdentifierSchema.optional(), state: NonEmptyStringSchema.optional(), kind: AnalysisJobKindSchema.optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('analysis-job'), jobId: IdentifierSchema }),
  z.object({ resource: z.literal('analysis-output'), jobId: IdentifierSchema }),
  z.object({ resource: z.literal('capability-vectors'), runId: IdentifierSchema.optional(), agentVariantId: IdentifierSchema.optional(), methodologyVersion: NonEmptyStringSchema.optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('failure-cluster-promotions'), runId: IdentifierSchema.optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('reproductions'), findingId: IdentifierSchema.optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('regressions'), page: PageRequestSchema }),
  z.object({ resource: z.literal('regression-decisions'), page: PageRequestSchema }),
  z.object({ resource: z.literal('insights'), page: PageRequestSchema }),
  z.object({ resource: z.literal('reports'), runId: IdentifierSchema.optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('audit'), actorId: IdentifierSchema.optional(), operation: NonEmptyStringSchema.optional(), resourceType: IdentifierSchema.optional(), trustedOnly: z.boolean().optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('retention'), page: PageRequestSchema }),
  z.object({ resource: z.literal('deletion-impact'), runId: IdentifierSchema }),
  z.object({ resource: z.literal('workers'), status: z.enum(['ready', 'degraded', 'stale']).optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('archive-summary') }),
  z.object({ resource: z.literal('archived-runs'), search: NonEmptyStringSchema.optional(), taskPackId: IdentifierSchema.optional(), state: NonEmptyStringSchema.optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('archived-run'), runId: IdentifierSchema }),
  z.object({ resource: z.literal('archive-documents'), runId: IdentifierSchema.optional(), kind: z.enum(['lifecycle', 'reproduction', 'closed-loop', 'acceptance', 'other']).optional(), search: NonEmptyStringSchema.optional(), page: PageRequestSchema }),
  z.object({ resource: z.literal('archive-document'), documentId: IdentifierSchema }),
  z.object({ resource: z.literal('run-templates'), page: PageRequestSchema }),
])
export type ControlPlaneCapabilities = z.infer<typeof ControlPlaneCapabilitiesSchema>
export type EvaluationQuery = z.infer<typeof EvaluationQuerySchema>

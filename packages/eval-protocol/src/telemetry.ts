import { z } from 'zod'

import { canonicalJson, IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema } from './common.js'

export const TRACE_SPAN_NAMES = [
  'evaluation.run', 'evaluation.trial', 'environment.prepare', 'agent.execute', 'model.call', 'tool.call',
  'subagent.run', 'compaction', 'memory.read', 'memory.write', 'workspace.snapshot', 'verifier.execute',
  'analyzer.detect', 'reproduction.verify',
] as const

export const TraceSpanSchema = z.object({
  schemaVersion: z.literal(1), traceId: IdentifierSchema, spanId: IdentifierSchema, parentSpanId: IdentifierSchema.optional(),
  name: z.enum(TRACE_SPAN_NAMES), startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  status: z.enum(['ok', 'error', 'cancelled']),
  refs: z.object({ runId: IdentifierSchema, trialId: IdentifierSchema, backendId: IdentifierSchema, taskId: IdentifierSchema }).strict(),
  eventSequence: z.number().int().nonnegative().optional(), artifactRefs: z.array(RelativeArtifactPathSchema).default([]),
  outcomeCategory: NonEmptyStringSchema.optional(),
}).strict().superRefine((span, ctx) => {
  if (Date.parse(span.completedAt) < Date.parse(span.startedAt)) ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'trace span cannot complete before it starts' })
})

export const TrialTraceSchema = z.object({
  schemaVersion: z.literal(1), traceId: IdentifierSchema, runId: IdentifierSchema, trialId: IdentifierSchema, spans: z.array(TraceSpanSchema).min(6),
}).strict().superRefine((trace, ctx) => {
  const ids = new Set(trace.spans.map((span) => span.spanId))
  if (ids.size !== trace.spans.length) ctx.addIssue({ code: 'custom', path: ['spans'], message: 'trace span IDs must be unique' })
  const roots = trace.spans.filter((span) => !span.parentSpanId)
  if (roots.length !== 1 || roots[0]?.name !== 'evaluation.run') ctx.addIssue({ code: 'custom', path: ['spans'], message: 'trial trace requires one evaluation.run root' })
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]))
  for (const [index, span] of trace.spans.entries()) {
    if (span.traceId !== trace.traceId || span.refs.runId !== trace.runId || span.refs.trialId !== trace.trialId) ctx.addIssue({ code: 'custom', path: ['spans', index, 'refs'], message: 'trace controlled references must match its envelope' })
    if (span.parentSpanId && !ids.has(span.parentSpanId)) ctx.addIssue({ code: 'custom', path: ['spans', index, 'parentSpanId'], message: 'trace parent span is absent' })
    const visited = new Set<string>(); let current: typeof span | undefined = span
    while (current?.parentSpanId) {
      if (visited.has(current.spanId)) { ctx.addIssue({ code: 'custom', path: ['spans', index, 'parentSpanId'], message: 'trace graph contains a cycle' }); break }
      visited.add(current.spanId); current = byId.get(current.parentSpanId)
    }
    if (current && current.spanId !== roots[0]?.spanId) ctx.addIssue({ code: 'custom', path: ['spans', index, 'parentSpanId'], message: 'trace span is not reachable from the evaluation.run root' })
  }
  for (const required of ['evaluation.trial', 'environment.prepare', 'agent.execute', 'workspace.snapshot', 'verifier.execute'] as const) {
    if (!trace.spans.some((span) => span.name === required)) ctx.addIssue({ code: 'custom', path: ['spans'], message: 'trial trace is missing required span: ' + required })
  }
})

export type TraceSpan = z.infer<typeof TraceSpanSchema>
export type TrialTrace = z.infer<typeof TrialTraceSchema>

export function parseTrialTraceJsonl(value: string): TrialTrace {
  const spans = value.split('\n').filter((line) => line.trim().length > 0).map((line, index) => {
    try { return TraceSpanSchema.parse(JSON.parse(line)) }
    catch (error) { throw new Error('invalid trial trace JSONL at line ' + String(index + 1) + ': ' + (error instanceof Error ? error.message : String(error))) }
  })
  const first = spans[0]
  if (!first) throw new Error('trial trace JSONL is empty')
  return TrialTraceSchema.parse({ schemaVersion: 1, traceId: first.traceId, runId: first.refs.runId, trialId: first.refs.trialId, spans })
}

export function serializeTrialTraceJsonl(input: unknown): string {
  return TrialTraceSchema.parse(input).spans.map((span) => canonicalJson(span)).join('\n') + '\n'
}

const DistributionSchema = z.object({ count: z.number().int().nonnegative(), p50Ms: z.number().nonnegative().nullable(), p95Ms: z.number().nonnegative().nullable(), maxMs: z.number().nonnegative().nullable() }).strict()
const SloStatusSchema = z.object({ id: z.enum(['restart-durability', 'duplicate-commit-prevention', 'bounded-cancellation', 'manifest-integrity', 'infrastructure-attribution', 'official-ingest-authority']), status: z.enum(['meeting', 'at_risk', 'unknown']), target: NonEmptyStringSchema, observed: NonEmptyStringSchema, evidenceRefs: z.array(NonEmptyStringSchema) }).strict()

export const PlatformMetricsSnapshotSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().datetime(), observationStartedAt: z.string().datetime(),
  queue: z.object({ queuedTrials: z.number().int().nonnegative(), oldestAgeMs: z.number().int().nonnegative() }).strict(),
  workers: z.object({ registered: z.number().int().nonnegative(), activeLeases: z.number().int().nonnegative(), trialCapacity: z.number().int().nonnegative(), utilization: z.number().min(0).max(1) }).strict(),
  environmentPreparation: DistributionSchema, firstModelCall: DistributionSchema, modelCalls: z.object({ ...DistributionSchema.shape, count: z.number().int().nonnegative() }).strict(),
  toolCalls: z.object({ ...DistributionSchema.shape, count: z.number().int().nonnegative(), failuresByCategory: z.record(IdentifierSchema, z.number().int().nonnegative()) }).strict(),
  artifacts: z.object({ uploadFailures: z.number().int().nonnegative(), manifestsVerified: z.number().int().nonnegative(), manifestFailures: z.number().int().nonnegative() }).strict(),
  grader: z.object({ completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), failureRate: z.number().min(0).max(1) }).strict(),
  orchestrator: z.object({ lastRecoveryMs: z.number().int().nonnegative(), journalTransactions: z.number().int().nonnegative() }).strict(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative(), tokensPerSecond: z.number().nonnegative(), costUsdPerHour: z.number().nonnegative() }).strict(),
  terminalOutcomes: z.record(NonEmptyStringSchema, z.number().int().nonnegative()),
  flakes: z.object({ taskRate: z.number().min(0).max(1), verifierRate: z.number().min(0).max(1), flakyTasks: z.number().int().nonnegative(), evaluatedTasks: z.number().int().nonnegative() }).strict(),
  traceCoverage: z.object({ trialsWithTrace: z.number().int().nonnegative(), completedTrials: z.number().int().nonnegative() }).strict(),
  slos: z.array(SloStatusSchema).length(6),
}).strict()

export type PlatformMetricsSnapshot = z.infer<typeof PlatformMetricsSnapshotSchema>

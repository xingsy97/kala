import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema } from './common.js'
import type { NormalizedFailure } from './failure.js'

export const REQUIRED_BENCHMARK_IDS = [
  'swe-bench',
  'terminal-bench',
  'program-bench',
  'swe-marathon',
  'sdlc-journey',
  'code-understanding',
  'memory-planning',
  'fault-scenarios',
  'custom-task-pack',
] as const
export const BenchmarkIdSchema = IdentifierSchema

export const BenchmarkDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersions: z.array(z.number().int().positive()).min(1).default([1]),
  id: BenchmarkIdSchema,
  label: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  official: z.boolean(),
  nativePrimaryMetric: IdentifierSchema,
  verifierId: IdentifierSchema,
  verifierVersion: NonEmptyStringSchema,
  capabilities: z.array(IdentifierSchema).min(1).default(['resolve-tasks', 'prepare-task', 'verify', 'explain', 'normalize-failure']),
}).strict()

export const BenchmarkNativeResultSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: BenchmarkIdSchema,
  verifierId: IdentifierSchema,
  verifierVersion: NonEmptyStringSchema,
  nativeMetrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  rawResultRef: NonEmptyStringSchema,
  officialEvidence: z.boolean(),
}).strict()

export type BenchmarkDescriptor = z.infer<typeof BenchmarkDescriptorSchema>
export type BenchmarkNativeResult = z.infer<typeof BenchmarkNativeResultSchema>

export interface BenchmarkAdapter<TaskPackInput, ResolvedTask, SandboxHandle, VerificationInput, ScoreExplanation> {
  readonly descriptor: BenchmarkDescriptor
  resolveTasks(input: TaskPackInput): Promise<ResolvedTask[]>
  prepareTask(task: ResolvedTask, sandbox: SandboxHandle): Promise<void>
  verify(input: VerificationInput): Promise<BenchmarkNativeResult>
  explain(result: BenchmarkNativeResult): ScoreExplanation
  normalizeFailure(result: BenchmarkNativeResult): NormalizedFailure | null
}

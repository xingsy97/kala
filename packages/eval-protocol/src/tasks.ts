import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema, Sha256Schema } from './common.js'
import { TaskConstraintSchema } from './defects.js'
import { PublicTaskPackPublicationSchema } from './governance.js'
import { CatalogUsagePolicySchema } from './catalog-policy.js'

export const TaskRepositorySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('git'),
    url: NonEmptyStringSchema.url(),
    revision: NonEmptyStringSchema,
    repositoryManifestHash: Sha256Schema,
  }),
  z.object({
    kind: z.literal('artifact'),
    archiveRef: RelativeArtifactPathSchema,
    archiveSha256: Sha256Schema,
    revision: NonEmptyStringSchema,
  }),
])

export const VerificationStepSchema = z.object({
  stepId: IdentifierSchema,
  argv: z.array(NonEmptyStringSchema).min(1),
  cwd: RelativeArtifactPathSchema.default('.'),
  timeoutMs: z.number().int().positive(),
  requiredExitCode: z.number().int().default(0),
  nativeMetric: IdentifierSchema.optional(),
})

export const SweBenchOfficialRecordSchema = z.object({
  instance_id: IdentifierSchema,
  repo: NonEmptyStringSchema,
  base_commit: NonEmptyStringSchema,
  problem_statement: NonEmptyStringSchema,
  hints_text: z.string().optional(),
  created_at: z.string().optional(),
  version: NonEmptyStringSchema,
  FAIL_TO_PASS: z.string(),
  PASS_TO_PASS: z.string(),
  test_patch: z.string(),
  environment_setup_commit: z.string().optional(),
}).catchall(z.unknown())

export const SweBenchTaskInputSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal('swe-bench'),
  datasetId: IdentifierSchema,
  datasetVersion: NonEmptyStringSchema,
  split: NonEmptyStringSchema,
  harnessRevision: NonEmptyStringSchema.regex(/^[a-f0-9]{40,64}$/u, 'expected an immutable Git or content revision'),
  officialInstanceImageDigest: NonEmptyStringSchema,
  trialSandboxImageDigest: NonEmptyStringSchema,
  officialRecord: SweBenchOfficialRecordSchema,
  testTimeoutSeconds: z.number().int().positive().default(1_800),
  namespace: NonEmptyStringSchema.nullable().default('swebench'),
  instanceImageTag: NonEmptyStringSchema.default('latest'),
  envImageTag: NonEmptyStringSchema.default('latest'),
})

export const BenchmarkTaskInputSchema = z.discriminatedUnion('benchmarkId', [SweBenchTaskInputSchema])

export const ResolvedTaskSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: IdentifierSchema,
  taskPackId: IdentifierSchema,
  taskPackVersion: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  repository: TaskRepositorySchema,
  requiredSandboxImageDigest: NonEmptyStringSchema.optional(),
  fixtureManifestHash: Sha256Schema,
  faultScenarioIds: z.array(IdentifierSchema),
  verification: z.array(VerificationStepSchema).min(1),
  analysis: z.object({
    constraints: z.array(TaskConstraintSchema),
    protectedPaths: z.array(RelativeArtifactPathSchema),
    hiddenVerifierPaths: z.array(RelativeArtifactPathSchema),
  }).strict(),
  lxdInitMode: z.literal('keepalive').optional(),
  benchmarkInput: BenchmarkTaskInputSchema.optional(),
  policy: CatalogUsagePolicySchema,
  publication: PublicTaskPackPublicationSchema.optional(),
}).strict()

export type TaskRepository = z.infer<typeof TaskRepositorySchema>
export type VerificationStep = z.infer<typeof VerificationStepSchema>
export type SweBenchOfficialRecord = z.infer<typeof SweBenchOfficialRecordSchema>
export type SweBenchTaskInput = z.infer<typeof SweBenchTaskInputSchema>
export type ResolvedTask = z.infer<typeof ResolvedTaskSchema>

export function assertTaskPublicationAllowed(input: unknown): ResolvedTask {
  const task = ResolvedTaskSchema.parse(input)
  if (task.publication?.sourceClassification === 'private_workspace' && task.publication.publicTaskPack && !task.publication.operatorReview) {
    throw new Error('private workspace task publication requires explicit operator review, redaction, and provenance approval')
  }
  return task
}

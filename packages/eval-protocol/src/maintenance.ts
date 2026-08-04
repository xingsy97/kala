import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema, Sha256Schema } from './common.js'
import { DeletionImpactSchema } from './governance.js'

export const BackupArtifactSchema = z.object({ path: RelativeArtifactPathSchema, bytes: z.number().int().nonnegative(), sha256: Sha256Schema }).strict()
export const RecoveryObjectiveSchema = z.object({
  rpoTargetSeconds: z.number().int().nonnegative(), rpoObservedSeconds: z.number().nonnegative(),
  rtoTargetSeconds: z.number().int().nonnegative(), rtoObservedSeconds: z.number().nonnegative().nullable(),
}).strict()
export const BackupManifestSchema = z.object({
  schemaVersion: z.literal(1), backupId: IdentifierSchema, createdAt: z.string().datetime(),
  journal: z.object({ path: z.literal('control-plane.jsonl'), bytes: z.number().int().nonnegative(), sha256: Sha256Schema, transactionCount: z.number().int().nonnegative(), tipHash: Sha256Schema.nullable() }).strict(),
  artifacts: z.array(BackupArtifactSchema), recovery: RecoveryObjectiveSchema, manifestHash: Sha256Schema,
}).strict()
export const RetentionSweepResultSchema = z.object({
  schemaVersion: z.literal(1), policyId: IdentifierSchema, dryRun: z.boolean(), evaluatedAt: z.string().datetime(),
  candidates: z.array(z.object({ runId: IdentifierSchema, ageDays: z.number().nonnegative(), impact: DeletionImpactSchema, disposition: z.enum(['eligible', 'protected', 'deleted']), reason: NonEmptyStringSchema.optional() }).strict()),
}).strict()

export type BackupManifest = z.infer<typeof BackupManifestSchema>
export type RetentionSweepResult = z.infer<typeof RetentionSweepResultSchema>

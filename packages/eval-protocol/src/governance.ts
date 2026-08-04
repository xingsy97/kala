import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from './common.js'

export const PublicTaskPackPublicationSchema = z.object({
  sourceClassification: z.enum(['public', 'synthetic', 'private_workspace']),
  publicTaskPack: z.boolean(),
  operatorReview: z.object({
    operatorId: IdentifierSchema, reviewedAt: z.string().datetime(), redactionPassed: z.literal(true),
    redactionEvidenceHash: Sha256Schema, provenanceApproved: z.literal(true), provenanceRefs: z.array(NonEmptyStringSchema).min(1),
  }).strict().optional(),
}).strict().superRefine((publication, ctx) => {
  if (publication.sourceClassification === 'private_workspace' && publication.publicTaskPack && !publication.operatorReview) {
    ctx.addIssue({ code: 'custom', path: ['operatorReview'], message: 'private workspace data requires explicit operator review, redaction evidence, and provenance approval before public task-pack publication' })
  }
})

export const AuditRecordSchema = z.object({
  schemaVersion: z.literal(1), sequence: z.number().int().nonnegative(), at: z.string().datetime(),
  actor: z.object({ kind: z.enum(['operator', 'worker', 'control-plane', 'ci']), id: IdentifierSchema }),
  operation: NonEmptyStringSchema, resourceType: IdentifierSchema, resourceId: IdentifierSchema,
  commandId: IdentifierSchema.optional(), committedSequence: z.number().int().nonnegative().optional(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
export const RetentionPolicySchema = z.object({
  schemaVersion: z.literal(1), policyId: IdentifierSchema, retainDays: z.number().int().nonnegative(),
  protectPublishedLeaderboardEvidence: z.boolean(), protectRegressionEvidence: z.boolean(),
  derivedArtifactDeletion: z.literal('transitive'), requireConfirmation: z.literal(true),
})
export const DeletionImpactSchema = z.object({
  schemaVersion: z.literal(1), resourceType: IdentifierSchema, resourceId: IdentifierSchema,
  artifactCount: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
  derivedResourceIds: z.array(IdentifierSchema), blockedByRefs: z.array(NonEmptyStringSchema), impactHash: Sha256Schema,
}).strict()
export type AuditRecord = z.infer<typeof AuditRecordSchema>
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>
export type DeletionImpact = z.infer<typeof DeletionImpactSchema>
export type PublicTaskPackPublication = z.infer<typeof PublicTaskPackPublicationSchema>

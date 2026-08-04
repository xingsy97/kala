import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema, Sha256Schema } from './common.js'

export const ReferencedSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  keyReference: IdentifierSchema,
  valueBase64: NonEmptyStringSchema,
}).strict()

export const ArtifactEntrySchema = z.object({
  artifactId: IdentifierSchema,
  path: RelativeArtifactPathSchema,
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  redaction: z.enum(['not_required', 'passed', 'failed']),
  classification: z.enum(['public', 'operator', 'sensitive']),
}).strict()

export const ArtifactManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: IdentifierSchema,
  trialId: IdentifierSchema,
  leaseId: IdentifierSchema,
  generatedAt: z.string().datetime(),
  entries: z.array(ArtifactEntrySchema),
  manifestHash: Sha256Schema,
  signature: ReferencedSignatureSchema.optional(),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const [index, entry] of manifest.entries.entries()) {
    if (ids.has(entry.artifactId)) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'artifactId'], message: 'duplicate artifactId' })
    }
    if (paths.has(entry.path)) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'path'], message: 'duplicate artifact path' })
    }
    ids.add(entry.artifactId)
    paths.add(entry.path)
  }
})

export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>
export type ReferencedSignature = z.infer<typeof ReferencedSignatureSchema>

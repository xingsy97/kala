import { z } from 'zod'

import { EvidenceLevelSchema, NormalizedAgentEventSchema } from './agent-backend.js'
import { ArtifactManifestSchema, ReferencedSignatureSchema, type ArtifactManifest } from './artifacts.js'
import { BenchmarkNativeResultSchema } from './benchmark.js'
import { canonicalJson, IdentifierSchema, NonEmptyStringSchema, sha256Hex, Sha256Schema } from './common.js'
import { EnvironmentLockSchema } from './sandbox.js'
import { hexBytes, verifyKeyReferencedSignature, type SigningKeyRegistry } from './trust.js'

export const UsageEvidenceSchema = z.discriminatedUnion('availability', [
  z.object({ availability: z.literal('available'), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative().optional() }),
  z.object({ availability: z.literal('unavailable'), reason: NonEmptyStringSchema }),
])

export const TrialEvidenceSchema = z.object({
  schemaVersion: z.literal(1), runId: IdentifierSchema, trialId: IdentifierSchema, agentVariantId: IdentifierSchema,
  taskId: IdentifierSchema, repeatIndex: z.number().int().nonnegative(), environmentLock: EnvironmentLockSchema,
  nativeEventsRef: NonEmptyStringSchema, normalizedEventsRef: NonEmptyStringSchema,
  traceRef: NonEmptyStringSchema.optional(),
  normalizedEventCount: z.number().int().nonnegative(), analyzerInputRef: NonEmptyStringSchema, finalDiffRef: NonEmptyStringSchema,
  stdoutRef: NonEmptyStringSchema, stderrRef: NonEmptyStringSchema, usage: UsageEvidenceSchema,
  benchmarkResult: BenchmarkNativeResultSchema, artifactManifest: ArtifactManifestSchema,
  evidenceLevel: EvidenceLevelSchema, resultHash: Sha256Schema, signature: ReferencedSignatureSchema.optional(),
}).strict().superRefine((evidence, ctx) => {
  if (evidence.evidenceLevel === 'official' && !evidence.benchmarkResult.officialEvidence) {
    ctx.addIssue({ code: 'custom', path: ['evidenceLevel'], message: 'official evidence requires official benchmark result ingest' })
  }
  if (evidence.evidenceLevel === 'smoke' && evidence.benchmarkResult.officialEvidence) {
    ctx.addIssue({ code: 'custom', path: ['evidenceLevel'], message: 'smoke evidence cannot carry official benchmark authority' })
  }
})

export const NormalizedTraceChunkSchema = z.object({
  schemaVersion: z.literal(1), runId: IdentifierSchema, trialId: IdentifierSchema,
  firstSequence: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative(),
  events: z.array(NormalizedAgentEventSchema),
}).superRefine((chunk, ctx) => {
  if (chunk.lastSequence < chunk.firstSequence) ctx.addIssue({ code: 'custom', path: ['lastSequence'], message: 'lastSequence must not precede firstSequence' })
  if (chunk.events.length > 0 && (chunk.events[0]!.sequence !== chunk.firstSequence || chunk.events.at(-1)!.sequence !== chunk.lastSequence)) {
    ctx.addIssue({ code: 'custom', path: ['events'], message: 'trace boundaries must match event sequences' })
  }
})

export type UsageEvidence = z.infer<typeof UsageEvidenceSchema>
export type TrialEvidence = z.infer<typeof TrialEvidenceSchema>
export type NormalizedTraceChunk = z.infer<typeof NormalizedTraceChunkSchema>

export async function verifyArtifactManifest(input: unknown): Promise<ArtifactManifest> {
  const manifest = ArtifactManifestSchema.parse(input)
  const { manifestHash, signature: _signature, ...unsigned } = manifest
  const actual = await sha256Hex(canonicalJson(unsigned))
  if (actual !== manifestHash) throw new Error('artifact manifest hash mismatch')
  return manifest
}

export async function verifyArtifactManifestSignature(input: unknown, registry: SigningKeyRegistry, verificationTime?: string | Date): Promise<ArtifactManifest> {
  const manifest = await verifyArtifactManifest(input)
  if (!manifest.signature) throw new Error('artifact manifest signature is required')
  await verifyKeyReferencedSignature({ ...manifest.signature, payload: hexBytes(manifest.manifestHash), scope: 'artifact_manifest', registry, verificationTime })
  return manifest
}

export async function verifyTrialEvidence(input: unknown): Promise<TrialEvidence> {
  const evidence = TrialEvidenceSchema.parse(input)
  await verifyArtifactManifest(evidence.artifactManifest)
  const manifestPaths = new Set(evidence.artifactManifest.entries.map((entry) => entry.path.split(String.fromCharCode(92)).join('/')))
  for (const reference of [evidence.nativeEventsRef, evidence.normalizedEventsRef, evidence.traceRef, evidence.analyzerInputRef, evidence.finalDiffRef, evidence.stdoutRef, evidence.stderrRef, evidence.benchmarkResult.rawResultRef].filter((value): value is string => value !== undefined)) {
    if (!manifestPaths.has(reference.split(String.fromCharCode(92)).join('/'))) throw new Error('trial evidence reference is absent from artifact manifest: ' + reference)
  }
  const { resultHash, signature: _signature, ...unsigned } = evidence
  const actual = await sha256Hex(canonicalJson(unsigned))
  if (actual !== resultHash) throw new Error('trial evidence hash mismatch')
  return evidence
}

export async function verifyTrialEvidenceSignature(input: unknown, registry: SigningKeyRegistry, verificationTime?: string | Date): Promise<TrialEvidence> {
  const evidence = await verifyTrialEvidence(input)
  if (!evidence.signature) throw new Error('trial result signature is required')
  await verifyKeyReferencedSignature({ ...evidence.signature, payload: hexBytes(evidence.resultHash), scope: 'trial_result', registry, verificationTime })
  return evidence
}

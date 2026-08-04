import { z } from 'zod'

import { ReferencedSignatureSchema } from './artifacts.js'
import { canonicalJson, IdentifierSchema, NonEmptyStringSchema, RelativeArtifactPathSchema, sha256Hex, Sha256Schema } from './common.js'
import { hexBytes, verifyKeyReferencedSignature, type SigningKeyRegistry } from './trust.js'

export const FreshEnvironmentEvidenceSchema = z.object({
  freshEnvironmentId: IdentifierSchema, providerAttestation: NonEmptyStringSchema, imageDigest: NonEmptyStringSchema,
  nonce: NonEmptyStringSchema, initialStateHash: Sha256Schema, networkPolicyHash: Sha256Schema, cleanupReceipt: NonEmptyStringSchema,
}).strict()

const ReproductionAttemptSchema = FreshEnvironmentEvidenceSchema.extend({
  attemptId: IdentifierSchema,
  environmentLockHash: Sha256Schema,
  observedFailureFingerprint: Sha256Schema,
  reproduced: z.boolean(),
  evidenceRefs: z.array(NonEmptyStringSchema).min(1),
}).strict()

export const ReproductionExecutionContractSchema = z.object({
  argv: z.array(NonEmptyStringSchema).min(1),
  expectedExitCode: z.number().int(),
  stderrIncludes: NonEmptyStringSchema,
  failureFingerprintSource: NonEmptyStringSchema,
}).strict()

export const ReproductionTaskContractSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: IdentifierSchema,
  faultScenarioId: IdentifierSchema.optional(),
  reproduction: ReproductionExecutionContractSchema,
}).strict()

export const ReproductionExpectedSchema = z.object({
  failureFingerprint: Sha256Schema,
  attempts: z.number().int().min(2),
  expectedSuccessControl: z.literal(true),
}).strict()

const REQUIRED_BUNDLE_FILES = [
  'defect.json', 'task.json', 'environment.lock.json', 'agent-config.json', 'tool-registry.json',
  'minimal-workspace.tar.zst', 'replay.jsonl', 'trace.jsonl', 'final.diff', 'verifier-result.json',
  'analysis.json', 'expected.json', 'reproduce.sh', 'SHA256SUMS',
] as const

export const ReproductionBundleSchema = z.object({
  schemaVersion: z.literal(1),
  bundleId: IdentifierSchema,
  findingId: IdentifierSchema,
  failureFingerprint: Sha256Schema,
  environmentLockHash: Sha256Schema,
  files: z.array(z.object({ path: RelativeArtifactPathSchema, sha256: Sha256Schema, bytes: z.number().int().nonnegative(), mediaType: NonEmptyStringSchema }).strict()),
  reproduction: z.object({
    attempts: z.array(ReproductionAttemptSchema).min(2),
    reproduced: z.number().int().min(2),
    expectedSuccessControl: FreshEnvironmentEvidenceSchema.extend({ environmentLockHash: Sha256Schema, passed: z.literal(true), evidenceRefs: z.array(NonEmptyStringSchema).min(1) }).strict(),
    minimization: z.object({ originalUnits: z.number().int().positive(), minimizedUnits: z.number().int().positive(), attempts: z.number().int().positive(), repetitions: z.number().int().positive(), requiredPreservations: z.number().int().positive(), oneMinimalVerified: z.literal(true) }).strict(),
  }).strict(),
  privacy: z.object({ redactionPassed: z.literal(true), secretScanPassed: z.literal(true), absolutePathScanPassed: z.literal(true) }).strict(),
  signedPayloadHash: Sha256Schema,
  signature: ReferencedSignatureSchema,
}).strict().superRefine((bundle, ctx) => {
  if (bundle.reproduction.reproduced !== bundle.reproduction.attempts.filter((attempt) => attempt.reproduced).length) ctx.addIssue({ code: 'custom', path: ['reproduction', 'reproduced'], message: 'reproduced count must match attempt evidence' })
  const environmentIds = [...bundle.reproduction.attempts.map((attempt) => attempt.freshEnvironmentId), bundle.reproduction.expectedSuccessControl.freshEnvironmentId]
  if (new Set(environmentIds).size !== environmentIds.length) ctx.addIssue({ code: 'custom', path: ['reproduction'], message: 'every reproduction and control attempt requires a distinct fresh environment' })
  const nonces = [...bundle.reproduction.attempts.map((attempt) => attempt.nonce), bundle.reproduction.expectedSuccessControl.nonce]
  if (new Set(nonces).size !== nonces.length) ctx.addIssue({ code: 'custom', path: ['reproduction'], message: 'fresh environment attestation nonces must be unique' })
  for (const [index, attempt] of bundle.reproduction.attempts.entries()) if (attempt.reproduced && attempt.observedFailureFingerprint !== bundle.failureFingerprint) ctx.addIssue({ code: 'custom', path: ['reproduction', 'attempts', index, 'observedFailureFingerprint'], message: 'reproduced attempt must match the canonical failure fingerprint' })
  for (const [index, attempt] of bundle.reproduction.attempts.entries()) if (attempt.environmentLockHash !== bundle.environmentLockHash) ctx.addIssue({ code: 'custom', path: ['reproduction', 'attempts', index, 'environmentLockHash'], message: 'fresh reproduction must use the locked environment' })
  if (bundle.reproduction.expectedSuccessControl.environmentLockHash !== bundle.environmentLockHash) ctx.addIssue({ code: 'custom', path: ['reproduction', 'expectedSuccessControl', 'environmentLockHash'], message: 'success control must use the locked environment' })
  for (const [index, attempt] of bundle.reproduction.attempts.entries()) {
    if (attempt.imageDigest !== bundle.reproduction.expectedSuccessControl.imageDigest) ctx.addIssue({ code: 'custom', path: ['reproduction', 'attempts', index, 'imageDigest'], message: 'fresh attempts and control must use the same image digest' })
    if (attempt.networkPolicyHash !== bundle.reproduction.expectedSuccessControl.networkPolicyHash) ctx.addIssue({ code: 'custom', path: ['reproduction', 'attempts', index, 'networkPolicyHash'], message: 'fresh attempts and control must use the same network policy' })
  }
  if (bundle.reproduction.minimization.requiredPreservations > bundle.reproduction.minimization.repetitions) ctx.addIssue({ code: 'custom', path: ['reproduction', 'minimization'], message: 'preservation threshold cannot exceed repetitions' })
  if (bundle.reproduction.minimization.minimizedUnits > bundle.reproduction.minimization.originalUnits) ctx.addIssue({ code: 'custom', path: ['reproduction', 'minimization'], message: 'minimized reproduction cannot exceed original size' })
  const names = bundle.files.map((file) => file.path.split('/').at(-1)!)
  const prefix = 'bundles/' + bundle.bundleId + '/'
  for (const [index, file] of bundle.files.entries()) if (!file.path.startsWith(prefix)) ctx.addIssue({ code: 'custom', path: ['files', index, 'path'], message: 'bundle file must be contained under its bundle ID' })
  for (const required of REQUIRED_BUNDLE_FILES) if (names.filter((name) => name === required).length !== 1) ctx.addIssue({ code: 'custom', path: ['files'], message: 'bundle requires exactly one ' + required })
  if (new Set(bundle.files.map((file) => file.path)).size !== bundle.files.length) ctx.addIssue({ code: 'custom', path: ['files'], message: 'bundle file paths must be unique' })
})

export function parseReproductionTaskContract(input: unknown): ReproductionTaskContract {
  return ReproductionTaskContractSchema.parse(input)
}

export type ReproductionBundle = z.infer<typeof ReproductionBundleSchema>
export type ReproductionAttempt = z.infer<typeof ReproductionAttemptSchema>
export type FreshEnvironmentEvidence = z.infer<typeof FreshEnvironmentEvidenceSchema>
export type ReproductionExecutionContract = z.infer<typeof ReproductionExecutionContractSchema>
export type ReproductionTaskContract = z.infer<typeof ReproductionTaskContractSchema>

export async function verifyReproductionBundleSignature(input: unknown, registry?: SigningKeyRegistry, verificationTime?: string | Date): Promise<ReproductionBundle> {
  const bundle = ReproductionBundleSchema.parse(input)
  const { signedPayloadHash, signature, ...unsigned } = bundle
  if (await sha256Hex(canonicalJson(unsigned)) !== signedPayloadHash) throw new Error('reproduction signed payload hash mismatch')
  if (!registry) throw new Error('external signing key registry is required')
  await verifyKeyReferencedSignature({ ...signature, payload: hexBytes(signedPayloadHash), scope: 'reproduction_bundle', registry, verificationTime })
  return bundle
}

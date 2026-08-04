import { z } from 'zod'

import { IdentifierSchema, Sha256Schema } from './common.js'
import { NormalizedFailureSchema } from './failure.js'
import { TrialEvidenceSchema } from './results.js'
import { TrialStateSchema } from './run-events.js'

const WorkerReadinessDiagnosticSchema = z.object({
  component: z.enum(['sandbox', 'agent', 'credentials']),
  code: IdentifierSchema,
  message: z.string().min(1),
}).strict()

export const WorkerReadinessSchema = z.object({
  checkedAt: z.string().datetime(),
  sandboxes: z.array(z.object({
    provider: IdentifierSchema,
    imageDigest: z.string().min(1),
    networkMode: z.enum(['denied', 'allowlist']),
    allowedDestinations: z.array(z.string().min(1)),
    ok: z.boolean(),
    errors: z.array(WorkerReadinessDiagnosticSchema),
    warnings: z.array(WorkerReadinessDiagnosticSchema),
  }).strict()),
  agents: z.array(z.object({
    backendId: IdentifierSchema,
    configHash: Sha256Schema,
    credentialReferenceIds: z.array(IdentifierSchema),
    ok: z.boolean(),
    errors: z.array(WorkerReadinessDiagnosticSchema),
    warnings: z.array(WorkerReadinessDiagnosticSchema),
  }).strict()),
}).strict()

export const WorkerRegistrationSchema = z.object({
  schemaVersion: z.literal(1),
  workerId: IdentifierSchema,
  signingKeyReference: IdentifierSchema,
  workerVersion: z.string().min(1),
  protocolVersions: z.array(z.number().int().positive()).min(1),
  sandboxProviders: z.array(IdentifierSchema),
  agentBackends: z.array(IdentifierSchema),
  benchmarkAdapters: z.array(IdentifierSchema),
  capacity: z.object({
    cpu: z.number().positive(),
    memoryMb: z.number().int().positive(),
    diskMb: z.number().int().positive(),
    gpu: z.number().int().nonnegative(),
    maxTrials: z.number().int().positive(),
  }),
  readiness: WorkerReadinessSchema.optional(),
}).strict()

export const TrialLeaseSchema = z.object({
  schemaVersion: z.literal(1),
  leaseId: IdentifierSchema,
  runId: IdentifierSchema,
  trialId: IdentifierSchema,
  attempt: z.number().int().positive(),
  workerId: IdentifierSchema,
  specHash: Sha256Schema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  commitToken: z.string().min(32),
}).superRefine((lease, ctx) => {
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'lease expiry must follow issue time' })
  }
}).strict()

export const LeaseHeartbeatSchema = z.object({
  schemaVersion: z.literal(1),
  leaseId: IdentifierSchema,
  workerId: IdentifierSchema,
  at: z.string().datetime(),
  lastEventSequence: z.number().int().nonnegative(),
}).strict()

export const TrialProgressUpdateSchema = z.object({
  schemaVersion: z.literal(1),
  leaseId: IdentifierSchema,
  workerId: IdentifierSchema,
  trialId: IdentifierSchema,
  state: TrialStateSchema.extract(['environment_preparing', 'agent_running', 'artifacts_collecting', 'verifying', 'analyzing']),
  at: z.string().datetime(),
})

export const TrialResultCommitSchema = z.object({
  schemaVersion: z.literal(1),
  leaseId: IdentifierSchema,
  trialId: IdentifierSchema,
  attempt: z.number().int().positive(),
  commitToken: z.string().min(32),
  resultHash: Sha256Schema,
  artifactManifestHash: Sha256Schema,
  evidence: TrialEvidenceSchema.optional(),
  failure: NormalizedFailureSchema.optional(),
  terminalState: z.enum(['completed', 'blocked', 'timeout', 'cancelled', 'agent_error', 'environment_error', 'verifier_error', 'indeterminate']),
  resourceUsage: z.object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0),
    wallMs: z.number().int().nonnegative(),
  }).optional(),
  committedAt: z.string().datetime(),
}).strict().superRefine((commit, ctx) => {
  if (commit.terminalState === 'completed' && !commit.evidence) ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'completed commits require canonical trial evidence' })
  if (commit.terminalState !== 'completed' && commit.evidence) ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'non-completed commits cannot claim successful canonical evidence' })
  if (commit.terminalState === 'completed' && commit.failure) ctx.addIssue({ code: 'custom', path: ['failure'], message: 'completed commits cannot carry a failure' })
  if (commit.terminalState !== 'completed' && !commit.failure) ctx.addIssue({ code: 'custom', path: ['failure'], message: 'non-completed commits require a normalized failure' })
  if (commit.terminalState === 'indeterminate' && commit.failure?.category !== 'indeterminate_side_effect') ctx.addIssue({ code: 'custom', path: ['failure', 'category'], message: 'indeterminate terminal state requires indeterminate-side-effect classification' })
  if (commit.failure?.category === 'indeterminate_side_effect' && commit.terminalState !== 'indeterminate') ctx.addIssue({ code: 'custom', path: ['terminalState'], message: 'indeterminate-side-effect classification requires indeterminate terminal state' })
  if (commit.evidence) {
    if (commit.evidence.trialId !== commit.trialId) ctx.addIssue({ code: 'custom', path: ['evidence', 'trialId'], message: 'commit evidence trialId mismatch' })
    if (commit.evidence.resultHash !== commit.resultHash) ctx.addIssue({ code: 'custom', path: ['evidence', 'resultHash'], message: 'commit evidence result hash mismatch' })
    if (commit.evidence.artifactManifest.manifestHash !== commit.artifactManifestHash) ctx.addIssue({ code: 'custom', path: ['evidence', 'artifactManifest', 'manifestHash'], message: 'commit evidence manifest hash mismatch' })
  }
})

export type WorkerRegistration = z.infer<typeof WorkerRegistrationSchema>
export type WorkerReadiness = z.infer<typeof WorkerReadinessSchema>
export type TrialLease = z.infer<typeof TrialLeaseSchema>
export type LeaseHeartbeat = z.infer<typeof LeaseHeartbeatSchema>
export type TrialProgressUpdate = z.infer<typeof TrialProgressUpdateSchema>
export type TrialResultCommit = z.infer<typeof TrialResultCommitSchema>

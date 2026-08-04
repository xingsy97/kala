import { z } from 'zod'

import { AgentVariantSpecSchema, OFFICIAL_AGENT_BACKEND_IDS } from './agent-backend.js'
import { canonicalJson, findPlaintextCredentialPaths, IdentifierSchema, sha256Hex, Sha256Schema } from './common.js'
import { CatalogUsagePolicySchema } from './catalog-policy.js'
import { EvaluatedSliceSchema } from './datasets.js'
import { FailureCategorySchema } from './failure.js'
import { SandboxPolicySchema } from './sandbox.js'

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  retryableCategories: z.array(FailureCategorySchema),
  backoffMs: z.number().int().nonnegative(),
}).strict()

export const EvaluationRunSpecSchema = z.object({
  schemaVersion: z.literal(1),
  runId: IdentifierSchema,
  taskPack: z.object({
    id: IdentifierSchema,
    version: z.string().min(1),
    evaluatedSlice: EvaluatedSliceSchema,
    policy: CatalogUsagePolicySchema,
  }).strict(),
  agents: z.array(AgentVariantSpecSchema).min(1),
  execution: z.object({
    repeats: z.number().int().positive(),
    priority: z.number().int(),
    maxConcurrency: z.number().int().positive(),
    maxConcurrencyPerBackend: z.number().int().positive(),
    maxConcurrencyPerProvider: z.number().int().positive(),
    leaseMs: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    inactivityTimeoutMs: z.number().int().positive(),
    retryPolicy: RetryPolicySchema,
    budget: z.object({
      maxUsd: z.number().nonnegative().optional(),
      maxTokens: z.number().int().nonnegative().optional(),
      maxWallMs: z.number().int().positive().optional(),
    }).strict().optional(),
  }).strict(),
  sandbox: SandboxPolicySchema,
  verification: z.object({
    verifierId: IdentifierSchema,
    verifierVersion: z.string().min(1),
    officialRequired: z.boolean(),
    timeoutMs: z.number().int().positive(),
    configHash: Sha256Schema,
  }).strict(),
  analysis: z.object({
    detectorIds: z.array(IdentifierSchema),
    repeatsRequired: z.number().int().positive(),
    configHash: Sha256Schema,
  }).strict(),
  createdAt: z.string().datetime(),
}).strict().superRefine((spec, ctx) => {
  const variants = new Set<string>()
  for (const agent of spec.agents) {
    if (variants.has(agent.variantId)) {
      ctx.addIssue({ code: 'custom', path: ['agents'], message: 'duplicate variantId: ' + agent.variantId })
    }
    variants.add(agent.variantId)
    if (spec.verification.officialRequired && !(OFFICIAL_AGENT_BACKEND_IDS as readonly string[]).includes(agent.backendId)) {
      ctx.addIssue({ code: 'custom', path: ['agents'], message: 'non-official backends cannot satisfy official-required verification: ' + agent.backendId })
    }
  }
  for (const path of findPlaintextCredentialPaths(spec)) {
    ctx.addIssue({ code: 'custom', path: [], message: 'plaintext credential-like field is forbidden: ' + path })
  }
  if (spec.execution.maxConcurrencyPerBackend > spec.execution.maxConcurrency) {
    ctx.addIssue({ code: 'custom', path: ['execution', 'maxConcurrencyPerBackend'], message: 'backend concurrency cannot exceed total run concurrency' })
  }
  if (spec.execution.maxConcurrencyPerProvider > spec.execution.maxConcurrency) {
    ctx.addIssue({ code: 'custom', path: ['execution', 'maxConcurrencyPerProvider'], message: 'provider concurrency cannot exceed total run concurrency' })
  }
})

export const AcceptedEvaluationRunSpecSchema = z.object({
  schemaVersion: z.literal(1),
  spec: EvaluationRunSpecSchema,
  specHash: Sha256Schema,
  acceptedAt: z.string().datetime(),
}).strict()

export type RetryPolicy = z.infer<typeof RetryPolicySchema>
export type EvaluationRunSpec = z.infer<typeof EvaluationRunSpecSchema>
export type AcceptedEvaluationRunSpec = z.infer<typeof AcceptedEvaluationRunSpecSchema>

export async function acceptEvaluationRunSpec(input: unknown, acceptedAt: string): Promise<AcceptedEvaluationRunSpec> {
  const spec = EvaluationRunSpecSchema.parse(input)
  const specHash = await sha256Hex(canonicalJson(spec))
  return AcceptedEvaluationRunSpecSchema.parse({ schemaVersion: 1, spec, specHash, acceptedAt })
}

export async function verifyAcceptedEvaluationRunSpec(input: unknown): Promise<AcceptedEvaluationRunSpec> {
  const accepted = AcceptedEvaluationRunSpecSchema.parse(input)
  const actual = await sha256Hex(canonicalJson(accepted.spec))
  if (actual !== accepted.specHash) throw new Error('accepted evaluation spec hash mismatch')
  return accepted
}

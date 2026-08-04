import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from './common.js'

export const SandboxProviderKindSchema = z.enum(['docker', 'lxd-container', 'lxd-vm'])
export const NetworkPolicySchema = z.object({
  mode: z.enum(['denied', 'allowlist']),
  allowedDestinations: z.array(NonEmptyStringSchema).default([]),
}).strict().superRefine((policy, ctx) => {
  if (policy.mode === 'denied' && policy.allowedDestinations.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'denied network cannot have destinations' })
  }
})

export const SandboxPolicySchema = z.object({
  provider: SandboxProviderKindSchema,
  imageDigest: NonEmptyStringSchema,
  readOnlyBase: z.literal(true),
  ephemeralOverlay: z.literal(true),
  resources: z.object({
    cpu: z.number().positive(),
    memoryMb: z.number().int().positive(),
    diskMb: z.number().int().positive(),
    pids: z.number().int().positive(),
    gpu: z.number().int().nonnegative().optional(),
  }).strict(),
  network: NetworkPolicySchema,
  artifactAllowlist: z.array(NonEmptyStringSchema),
}).strict()

export const EnvironmentLockSchema = z.object({
  schemaVersion: z.literal(1),
  provider: SandboxProviderKindSchema,
  imageDigest: NonEmptyStringSchema,
  repositoryRevision: NonEmptyStringSchema,
  dependencyLockHashes: z.record(z.string(), Sha256Schema),
  redactedEnvironment: z.record(z.string(), z.string()),
  resourcePolicyHash: Sha256Schema,
  networkPolicyHash: Sha256Schema,
  toolchainVersions: z.record(z.string(), NonEmptyStringSchema),
  fixtureVersions: z.record(z.string(), NonEmptyStringSchema),
  faultInjectorVersions: z.record(z.string(), NonEmptyStringSchema),
}).strict()

export const SandboxDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  providerId: IdentifierSchema,
  kind: SandboxProviderKindSchema,
  version: NonEmptyStringSchema,
  protocolVersions: z.array(z.number().int().positive()).min(1),
  capabilities: z.array(IdentifierSchema).min(1).default(['preflight', 'create', 'execute', 'snapshot', 'collect', 'destroy', 'verify-destroyed', 'reap-orphans']),
}).strict()

export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>
export type EnvironmentLock = z.infer<typeof EnvironmentLockSchema>
export type SandboxDescriptor = z.infer<typeof SandboxDescriptorSchema>

export interface TrialSandboxProvider<ResolvedTask, Handle, AgentSpec, AgentHandle, ExecRequest, ExecResult, Snapshot, Artifacts> {
  readonly descriptor: SandboxDescriptor
  create(task: ResolvedTask, policy: SandboxPolicy): Promise<Handle>
  startAgent(handle: Handle, backend: AgentSpec): Promise<AgentHandle>
  execute(handle: Handle, request: ExecRequest): Promise<ExecResult>
  snapshot(handle: Handle): Promise<Snapshot>
  collect(handle: Handle): Promise<Artifacts>
  destroy(handle: Handle): Promise<void>
}

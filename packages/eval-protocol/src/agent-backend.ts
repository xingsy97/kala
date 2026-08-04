import { z } from 'zod'

import { CredentialReferenceSchema, IdentifierSchema, NonEmptyStringSchema, Sha256Schema } from './common.js'

export const OFFICIAL_AGENT_BACKEND_IDS = ['agent-runlab', 'claude-code', 'codex'] as const
export const DEVELOPMENT_AGENT_BACKEND_IDS = ['custom-command', 'smoke'] as const
export const AgentBackendIdSchema = IdentifierSchema
export const EvidenceLevelSchema = z.enum(['official', 'native', 'predictions_only', 'smoke'])

export const AgentBackendCapabilitySchema = z.object({
  nonInteractive: z.boolean(),
  workspaceInjection: z.boolean(),
  isolatedConfig: z.boolean(),
  cancellation: z.boolean(),
  absoluteDeadline: z.boolean(),
  nativeEvents: z.boolean(),
  normalizedEvents: z.boolean(),
  toolEvents: z.boolean(),
  finalDiff: z.boolean(),
  usage: z.enum(['available', 'unavailable_explicit']),
})

export const AgentBackendDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersions: z.array(z.number().int().positive()).min(1).default([1]),
  id: AgentBackendIdSchema,
  label: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  configSchemaVersion: z.number().int().positive(),
  ranked: z.boolean(),
  evidenceLevel: EvidenceLevelSchema,
  capabilities: AgentBackendCapabilitySchema,
}).superRefine((descriptor, ctx) => {
  if (descriptor.id === 'smoke' && (descriptor.ranked || descriptor.evidenceLevel !== 'smoke')) {
    ctx.addIssue({ code: 'custom', message: 'smoke backends must be unranked smoke evidence' })
  }
  if (descriptor.id === 'custom-command' && descriptor.ranked) {
    ctx.addIssue({ code: 'custom', message: 'custom-command is a non-ranked development utility' })
  }
  if (!(OFFICIAL_AGENT_BACKEND_IDS as readonly string[]).includes(descriptor.id) && descriptor.ranked) {
    ctx.addIssue({ code: 'custom', path: ['ranked'], message: 'external Agent backends are unranked until certified as an official backend' })
  }
}).strict()

export const AgentVariantSpecSchema = z.object({
  variantId: IdentifierSchema,
  backendId: AgentBackendIdSchema,
  agentVersion: NonEmptyStringSchema,
  model: z.object({
    provider: NonEmptyStringSchema.optional(),
    modelId: NonEmptyStringSchema,
    modelVersion: NonEmptyStringSchema.optional(),
  }).strict(),
  configHash: Sha256Schema,
  config: z.record(z.string(), z.unknown()).default({}),
  credentialRefs: z.array(CredentialReferenceSchema).default([]),
}).strict()

export const PreflightResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({ code: IdentifierSchema, message: NonEmptyStringSchema })),
  warnings: z.array(z.object({ code: IdentifierSchema, message: NonEmptyStringSchema })),
  resolvedVersion: NonEmptyStringSchema.optional(),
  capabilities: AgentBackendCapabilitySchema.optional(),
}).strict()

export const NormalizedAgentEventSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime(),
  kind: z.enum(['message', 'model_call', 'tool_call', 'command', 'subagent', 'compaction', 'memory', 'usage', 'status', 'error']),
  nativeEventRef: NonEmptyStringSchema.optional(),
  data: z.record(z.string(), z.unknown()),
})

export type AgentBackendId = z.infer<typeof AgentBackendIdSchema>
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>
export type AgentBackendDescriptor = z.infer<typeof AgentBackendDescriptorSchema>
export type AgentVariantSpec = z.infer<typeof AgentVariantSpecSchema>
export type PreflightResult = z.infer<typeof PreflightResultSchema>
export type NormalizedAgentEvent = z.infer<typeof NormalizedAgentEventSchema>

export interface AgentBackend<RunInput, RunHandle, Artifacts> {
  readonly descriptor: AgentBackendDescriptor
  preflight(config: AgentVariantSpec): Promise<PreflightResult>
  start(input: RunInput, signal: AbortSignal): Promise<RunHandle>
  events(handle: RunHandle): AsyncIterable<NormalizedAgentEvent>
  cancel(handle: RunHandle): Promise<void>
  collect(handle: RunHandle): Promise<Artifacts>
}

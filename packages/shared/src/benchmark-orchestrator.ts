import { z } from 'zod'

export const BENCHMARK_KINDS = ['swebench', 'terminal-bench', 'program-bench', 'swe-marathon'] as const
export const AGENT_BACKEND_IDS = ['agent-runlab', 'claude-code', 'custom-command', 'smoke'] as const
export const BENCHMARK_EVIDENCE_LEVELS = ['official', 'native', 'predictions_only', 'smoke', 'legacy_official'] as const

export const BenchmarkKindSchema = z.enum(BENCHMARK_KINDS)
export const AgentBackendIdSchema = z.enum(AGENT_BACKEND_IDS)
export const BenchmarkEvidenceLevelSchema = z.enum(BENCHMARK_EVIDENCE_LEVELS)

export type BenchmarkKind = z.infer<typeof BenchmarkKindSchema>
export type AgentBackendId = z.infer<typeof AgentBackendIdSchema>
export type BenchmarkEvidenceLevel = z.infer<typeof BenchmarkEvidenceLevelSchema>

export const AgentBackendCapabilitySchema = z.object({
  realAgent: z.boolean(),
  sessionLog: z.boolean(),
  trace: z.boolean(),
  cancellation: z.boolean(),
  configurableModel: z.boolean(),
  configurableTools: z.boolean(),
  resume: z.boolean(),
})

export const AgentBackendDescriptorSchema = z.object({
  id: AgentBackendIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  evidenceLevel: BenchmarkEvidenceLevelSchema,
  production: z.boolean(),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
  capabilities: AgentBackendCapabilitySchema,
  configFields: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['string', 'number', 'boolean', 'secret-reference', 'enum']),
    required: z.boolean(),
    defaultValue: z.unknown().optional(),
    options: z.array(z.string()).optional(),
  })),
})

export type AgentBackendDescriptor = z.infer<typeof AgentBackendDescriptorSchema>

export const BenchmarkBackendConfigSchema = z.object({
  id: AgentBackendIdSchema,
  model: z.string(),
  label: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})

export const BenchmarkRunSpecSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  benchmark: BenchmarkKindSchema,
  dataset: z.object({
    source: z.string().min(1),
    instancesJsonl: z.string().min(1).optional(),
    split: z.string().optional(),
    instanceIds: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
  }),
  backends: z.array(BenchmarkBackendConfigSchema).min(1),
  execution: z.object({
    maxWorkers: z.number().int().positive(),
    maxTurns: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    inactivityTimeoutMs: z.number().int().positive().optional(),
    retryLimit: z.number().int().nonnegative(),
    skipCompleted: z.boolean(),
  }),
  grading: z.object({ mode: z.enum(['official', 'native', 'deferred']) }),
  createdAt: z.string().datetime(),
}).superRefine((spec, ctx) => {
  const identities = new Set<string>()
  for (const backend of spec.backends) {
    const identity = `${backend.id}:${backend.label ?? ''}:${backend.model}`
    if (identities.has(identity)) {
      ctx.addIssue({ code: 'custom', path: ['backends'], message: `duplicate backend configuration: ${identity}` })
    }
    identities.add(identity)
    if (backend.id !== 'smoke' && backend.model.trim().length === 0) {
      ctx.addIssue({ code: 'custom', path: ['backends'], message: `${backend.id} requires a model` })
    }
    if (backend.id === 'custom-command' && typeof backend.config.command !== 'string') {
      ctx.addIssue({ code: 'custom', path: ['backends'], message: 'custom-command requires config.command' })
    }
  }
})

export type BenchmarkRunSpec = z.infer<typeof BenchmarkRunSpecSchema>

export const BenchmarkRunStateSchema = z.enum([
  'draft',
  'preparing',
  'running',
  'predictions_ready',
  'grading',
  'ingesting',
  'analyzing',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export const BenchmarkInstanceStateSchema = z.enum([
  'queued',
  'preparing_workspace',
  'agent_running',
  'patch_captured',
  'grading',
  'resolved',
  'unresolved',
  'empty_patch',
  'timeout',
  'agent_error',
  'tool_error',
  'patch_apply_error',
  'grader_error',
  'cancelled',
])

export const BenchmarkRunEventSchema = z.object({
  schemaVersion: z.literal(1),
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
  runId: z.string().min(1),
  type: z.string().min(1),
  backendId: AgentBackendIdSchema.optional(),
  instanceId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
})

export type BenchmarkRunState = z.infer<typeof BenchmarkRunStateSchema>
export type BenchmarkInstanceState = z.infer<typeof BenchmarkInstanceStateSchema>
export type BenchmarkRunEvent = z.infer<typeof BenchmarkRunEventSchema>

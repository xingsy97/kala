import { z } from 'zod'

export const RolloutReadinessSchema = z.enum([
  'metadata-only',
  'task-validated',
  'live-rollout-complete',
  'token-captured',
  'reward-verified',
  'slime-sample-ready',
  'training-consumed',
  'blocked',
])

export type RolloutReadiness = z.infer<typeof RolloutReadinessSchema>

export const ArtifactRefSchema = z.object({
  kind: z.string(),
  uri: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  redaction: z.unknown().optional(),
})

export const AgentRlTaskSchema = z.object({
  schemaVersion: z.literal('agent.rl.task.v1'),
  taskId: z.string().min(1),
  source: z.object({
    kind: z.enum(['swebench', 'terminal-bench', 'local-fixture', 'manual-curated']),
    sourceId: z.string().optional(),
    sourceUrl: z.string().optional(),
  }),
  prompt: z.string().min(1),
  workspace: z.object({
    kind: z.enum(['git', 'archive', 'empty-tempdir']),
    repoUrl: z.string().optional(),
    baseCommit: z.string().optional(),
    archiveRef: z.string().optional(),
    workdir: z.string().optional(),
  }),
  verifier: z.object({
    kind: z.enum(['command', 'swebench', 'terminal-bench']),
    command: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive(),
    env: z.record(z.string(), z.string()).optional(),
    rewardParsePattern: z.string().optional(),
    writeScope: z.object({
      allowGlobs: z.array(z.string()).default([]),
      denyGlobs: z.array(z.string()).default([]),
    }).optional(),
  }),
  governance: z.object({
    trainingAllowed: z.boolean(),
    redactionStatus: z.enum(['not_required', 'redacted', 'blocked']),
    retentionClass: z.enum(['debug_only', 'curation_allowed', 'training_allowed']),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type AgentRlTask = z.infer<typeof AgentRlTaskSchema>

export const AgentRlTaskPoolSchema = z.object({
  schemaVersion: z.literal('agent.rl.task_pool.v1'),
  tasks: z.array(AgentRlTaskSchema),
  createdAt: z.string(),
})

export type AgentRlTaskPool = z.infer<typeof AgentRlTaskPoolSchema>

export const PolicyTokenCaptureSchema = z.object({
  schemaVersion: z.literal('agent.policy_token_capture.v1'),
  captureId: z.string().min(1),
  rolloutId: z.string().min(1),
  sessionId: z.string().min(1),
  callId: z.string().min(1),
  provider: z.literal('policy-gateway'),
  backend: z.literal('sglang'),
  model: z.string().min(1),
  tokenizer: z.object({
    nameOrPath: z.string().min(1),
    chatTemplateHash: z.string().min(1),
  }),
  routeKey: z.string().optional(),
  weightVersion: z.string().optional(),
  promptIds: z.array(z.number().int().nonnegative()),
  outputIds: z.array(z.number().int().nonnegative()),
  outputLogProbs: z.array(z.number()).optional(),
  responseMask: z.array(z.union([z.literal(0), z.literal(1)])),
  finishReason: z.string().optional(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  }).optional(),
  requestRef: ArtifactRefSchema.optional(),
  responseRef: ArtifactRefSchema.optional(),
})

export type PolicyTokenCapture = z.infer<typeof PolicyTokenCaptureSchema>

export const AgentTrainingTrajectorySchema = z.object({
  schemaVersion: z.literal('agent.training_trajectory.v1'),
  rolloutId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  turns: z.array(z.object({
    turnIndex: z.number().int().nonnegative(),
    callId: z.string().min(1),
    promptTokenCount: z.number().int().nonnegative(),
    responseTokenCount: z.number().int().nonnegative(),
    tokenCaptureRef: ArtifactRefSchema,
    lossMaskStart: z.number().int().nonnegative(),
    lossMaskEnd: z.number().int().nonnegative(),
    role: z.literal('assistant_policy_output'),
  })),
  rewardRef: ArtifactRefSchema.optional(),
  readiness: RolloutReadinessSchema,
})

export type AgentTrainingTrajectory = z.infer<typeof AgentTrainingTrajectorySchema>

export const AgentRewardArtifactSchema = z.object({
  schemaVersion: z.literal('agent.reward.v1'),
  rolloutId: z.string().min(1),
  taskId: z.string().min(1),
  verifierKind: z.enum(['command', 'swebench', 'terminal-bench']),
  reward: z.number(),
  label: z.enum(['resolved', 'unresolved', 'runtime_error', 'timeout', 'invalid_patch']),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().nonnegative(),
  command: z.array(z.string()).optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  stdoutRef: ArtifactRefSchema.optional(),
  stderrRef: ArtifactRefSchema.optional(),
  patchRef: ArtifactRefSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type AgentRewardArtifact = z.infer<typeof AgentRewardArtifactSchema>

export const AgentRlRolloutResultSchema = z.object({
  schemaVersion: z.literal('agent.rl.rollout_result.v1'),
  rolloutId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum(['completed', 'failed', 'timeout', 'blocked']),
  readiness: RolloutReadinessSchema,
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().nonnegative(),
  taskRef: ArtifactRefSchema.optional(),
  eventLogRef: ArtifactRefSchema.optional(),
  tokenCaptureRefs: z.array(ArtifactRefSchema),
  rewardRef: ArtifactRefSchema.optional(),
  trajectoryRef: ArtifactRefSchema.optional(),
  sampleValidationRef: ArtifactRefSchema.optional(),
  blockedReason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type AgentRlRolloutResult = z.infer<typeof AgentRlRolloutResultSchema>

export const SlimeSampleValidationSchema = z.object({
  schemaVersion: z.literal('agent.slime_sample_validation.v1'),
  rolloutId: z.string().min(1),
  taskId: z.string().min(1),
  status: z.enum(['ready', 'blocked']),
  readiness: RolloutReadinessSchema,
  checks: z.object({
    tokensNonEmpty: z.boolean(),
    responseLengthPositive: z.boolean(),
    lossMaskAligned: z.boolean(),
    logprobsAligned: z.boolean().optional(),
    rewardPresent: z.boolean(),
    trainableTokenPresent: z.boolean(),
  }),
  blockedReason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type SlimeSampleValidation = z.infer<typeof SlimeSampleValidationSchema>

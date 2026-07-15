/**
 * Zod schemas for Host→Dashboard push events + HTTP response bodies.
 *
 * types-first: `../protocol.ts` (+ `../log.ts` for LLMTrace) remains
 * authoritative; each schema is checked via `satisfies z.ZodType<T>`.
 *
 * Boundary usage: `.parse()` at HTTP response ingest / JSONL log ingest /
 * client-side event handlers when defense-in-depth is warranted. Never
 * inside internal reducers.
 */

import { z } from 'zod'

import type {
  AgentTypeSummary,
  AgentTypesResult,
  ApprovalRequiredEvent,
  AttachedExecutor,
  BgKillResult,
  BgListResult,
  BgOutputResult,
  ConsolidateMemoryResult,
  ControlUpdate,
  CopyOverflowSessionResult,
  DeleteOverflowSessionResult,
  DirListEntry,
  DirListResult,
  EventAppendedEvent,
  ExecutorChange,
  ExecutorIdentitySummary,
  ExecutorInviteSummary,
  FileContentsResult,
  FileListEntry,
  FileListResult,
  ManualModelInput,
  ModelInfo,
  ModelSource,
  OverflowContentsResult,
  QueuedMessagePreview,
  ServerBgTaskEvicted,
  ServerBgTaskUpdated,
  ServerExecutorChangedPayload,
  ServerExecutorIdentitiesPayload,
  ServerExecutorIdentityRevokedPayload,
  ServerExecutorInvitePayload,
  ServerExecutorInviteRevokedPayload,
  ServerExecutorInvitesPayload,
  ServerExecutorsPayload,
  ServerHistoryPayload,
  ServerLogArtifactPayload,
  ServerMessageQueueEvent,
  ServerModelsPayload,
  ServerSessionDeletedPayload,
  ServerSessionsPayload,
  ServerSettingsPayload,
  ServerSubAgentFinishedEvent,
  ServerSubAgentStartedEvent,
  ServerTokenDeltaEvent,
  SessionErrorEvent,
  SessionErrorScope,
  SessionForkedEvent,
  SessionMetaChanged,
  SessionModelChangedEvent,
  SessionPreferencesChangedEvent,
  SessionReadyEvent,
  SessionRenamedEvent,
  SessionSummary,
  SettingsHookSummary,
  SettingsProviderSummary,
  StateChangedEvent,
  SubAgentListResult,
  SubAgentSummary,
  ToolProgressPayload,
  WorkspaceMetaChanged,
  WorkspaceRenamedEvent,
} from '../protocol.js'
import { SESSION_ERROR_SCOPES } from '../protocol.js'
import type { EventEntry, HeaderEntry, LLMTrace, LogEntry, MetadataEntry, SnapshotEntry } from '../log.js'
import {
  AgentConfigSchema,
  AgentEventSchema,
  AgentStateSchema,
  AgentStatusSchema,
  EffectSchema,
  UsageTotalSchema,
} from './kernel.js'
import {
  BuildMetadataSchema,
  ExecutorAnnounceSchema,
  ServerBgTaskEvictedSchema,
  ServerBgTaskUpdatedSchema,
  ToolProgressPayloadSchema,
} from './executor.js'
import { ManualModelInputSchema, SessionPreferencesSchema } from './dashboard-inbound.js'

void ToolProgressPayloadSchema
void ServerBgTaskEvictedSchema

// ============================================================================
// LLM trace
// ============================================================================

export const LLMTraceSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'unknown']),
  model: z.string(),
  request: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
  response: z
    .object({
      status: z.number().int(),
      body: z.unknown().optional(),
      streamEventTypes: z.array(z.string()).optional(),
      metrics: z
        .object({
          durationMs: z.number().optional(),
          timeToFirstChunkMs: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  gatewayRequestId: z.string().optional(),
  weightVersion: z.string().optional(),
}) satisfies z.ZodType<LLMTrace>

// ============================================================================
// Session lifecycle events
// ============================================================================

export const SessionReadyEventSchema = z.object({
  sessionId: z.string(),
  cursor: z.number().int().nonnegative(),
  state: AgentStateSchema,
  config: AgentConfigSchema,
  reason: z.enum(['load', 'created', 'forked']).optional(),
  parentSessionId: z.string().optional(),
  parentCursor: z.number().int().nonnegative().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  selectedModel: z.string().optional(),
}) satisfies z.ZodType<SessionReadyEvent>

export const SessionForkedEventSchema: z.ZodType<SessionForkedEvent> = SessionReadyEventSchema

export const StateChangedEventSchema = z.object({
  sessionId: z.string(),
  cursor: z.number().int().nonnegative(),
  state: AgentStateSchema,
}) satisfies z.ZodType<StateChangedEvent>

export const EventAppendedEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  event: AgentEventSchema,
  effects: z.array(EffectSchema),
  hasEffectsArtifact: z.boolean().optional(),
  hasLlmTraceArtifact: z.boolean().optional(),
  llmTrace: LLMTraceSchema.optional(),
  model: z.string().optional(),
}) satisfies z.ZodType<EventAppendedEvent>

export const ServerLogArtifactPayloadSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  effects: z.array(EffectSchema).optional(),
  llmTrace: LLMTraceSchema.optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<ServerLogArtifactPayload>

const SessionErrorScopeSchema = z.enum(
  SESSION_ERROR_SCOPES as unknown as [SessionErrorScope, ...SessionErrorScope[]],
) satisfies z.ZodType<SessionErrorScope>

export const SessionErrorEventSchema = z.object({
  sessionId: z.string(),
  scope: SessionErrorScopeSchema,
  message: z.string(),
}) satisfies z.ZodType<SessionErrorEvent>

export const ApprovalRequiredEventSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<ApprovalRequiredEvent>

export const SessionModelChangedEventSchema = z.object({
  sessionId: z.string(),
  model: z.string(),
}) satisfies z.ZodType<SessionModelChangedEvent>

export const SessionPreferencesChangedEventSchema = z.object({
  sessionId: z.string(),
  preferences: SessionPreferencesSchema,
}) satisfies z.ZodType<SessionPreferencesChangedEvent>

export const ServerTokenDeltaEventSchema = z.object({
  sessionId: z.string(),
  text: z.string(),
}) satisfies z.ZodType<ServerTokenDeltaEvent>

export const SessionRenamedEventSchema = z.object({
  sessionId: z.string(),
  label: z.string(),
}) satisfies z.ZodType<SessionRenamedEvent>

export const WorkspaceRenamedEventSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
}) satisfies z.ZodType<WorkspaceRenamedEvent>

// ============================================================================
// Control-plane push
// ============================================================================

export const SessionMetaChangedSchema = z.object({
  sessionId: z.string(),
  label: z.string().optional(),
  preferences: SessionPreferencesSchema.optional(),
}) satisfies z.ZodType<SessionMetaChanged>

export const WorkspaceMetaChangedSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
}) satisfies z.ZodType<WorkspaceMetaChanged>

// ============================================================================
// Executor attach / detach
// ============================================================================

export const AttachedExecutorSchema = ExecutorAnnounceSchema.extend({
  attachedAt: z.string(),
  clientVersion: z.string().optional(),
}) satisfies z.ZodType<AttachedExecutor>

const _ExecutorChangeSchema = z.enum([
  'attached',
  'detached',
  'updated',
]) satisfies z.ZodType<ExecutorChange>
void _ExecutorChangeSchema

export const ServerExecutorChangedPayloadSchema = z.discriminatedUnion('change', [
  z.object({
    change: z.literal('detached'),
    executorId: z.string(),
  }),
  z.object({
    change: z.literal('attached'),
    executorId: z.string(),
    executor: AttachedExecutorSchema,
  }),
  z.object({
    change: z.literal('updated'),
    executorId: z.string(),
    executor: AttachedExecutorSchema,
  }),
]) satisfies z.ZodType<ServerExecutorChangedPayload>

export const ServerExecutorsPayloadSchema = z.object({
  executors: z.array(AttachedExecutorSchema),
}) satisfies z.ZodType<ServerExecutorsPayload>

// ============================================================================
// Sub-agent lifecycle
// ============================================================================

export const ServerSubAgentStartedEventSchema = z.object({
  parentSessionId: z.string(),
  parentCallId: z.string(),
  childSessionId: z.string(),
  agentType: z.string().optional(),
  prompt: z.string(),
  model: z.string().optional(),
  startedAt: z.string(),
}) satisfies z.ZodType<ServerSubAgentStartedEvent>

export const ServerSubAgentFinishedEventSchema = z.object({
  parentSessionId: z.string(),
  parentCallId: z.string(),
  childSessionId: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  turns: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  finishedAt: z.string(),
  error: z.string().optional(),
}) satisfies z.ZodType<ServerSubAgentFinishedEvent>

// ============================================================================
// Unified control update (discriminated union)
// ============================================================================

export const ControlUpdateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session_meta_changed') }).extend(SessionMetaChangedSchema.shape),
  z.object({ kind: z.literal('workspace_meta_changed') }).extend(WorkspaceMetaChangedSchema.shape),
  z.object({ kind: z.literal('executor_changed'), executorId: z.string(), change: z.literal('detached') }),
  z.object({ kind: z.literal('executor_changed'), executorId: z.string(), change: z.literal('attached'), executor: AttachedExecutorSchema }),
  z.object({ kind: z.literal('executor_changed'), executorId: z.string(), change: z.literal('updated'), executor: AttachedExecutorSchema }),
  z.object({ kind: z.literal('bg_task_updated') }).extend(ServerBgTaskUpdatedSchema.shape),
  z.object({ kind: z.literal('bg_task_evicted') }).extend(ServerBgTaskEvictedSchema.shape),
  z.object({ kind: z.literal('sub_agent_started') }).extend(ServerSubAgentStartedEventSchema.shape),
  z.object({ kind: z.literal('sub_agent_finished') }).extend(ServerSubAgentFinishedEventSchema.shape),
  z.object({ kind: z.literal('tool_progress') }).extend(ToolProgressPayloadSchema.shape),
]) as unknown as z.ZodType<ControlUpdate>

// ============================================================================
// Message queue
// ============================================================================

export const QueuedMessagePreviewSchema = z.object({
  id: z.string(),
  text: z.string(),
  mode: z.enum(['steer', 'queue']),
  createdAt: z.string(),
}) satisfies z.ZodType<QueuedMessagePreview>

export const ServerMessageQueueEventSchema = z.object({
  sessionId: z.string(),
  pending: z.number().int().nonnegative(),
  items: z.array(QueuedMessagePreviewSchema),
}) satisfies z.ZodType<ServerMessageQueueEvent>

// ============================================================================
// Sessions & history
// ============================================================================

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  createdAt: z.string(),
  lastEventAt: z.string().optional(),
  eventCount: z.number().int().nonnegative(),
  parentSessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  executorId: z.string().optional(),
  status: AgentStatusSchema.optional(),
  currentCwd: z.string().optional(),
  firstUserMessage: z.string().optional(),
  label: z.string().optional(),
}) satisfies z.ZodType<SessionSummary>

export const ServerSessionsPayloadSchema = z.object({
  sessions: z.array(SessionSummarySchema),
}) satisfies z.ZodType<ServerSessionsPayload>

export const ServerHistoryPayloadSchema = z.object({
  sessionId: z.string(),
  entries: z.array(EventAppendedEventSchema),
}) satisfies z.ZodType<ServerHistoryPayload>

export const ServerSessionDeletedPayloadSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<ServerSessionDeletedPayload>

// ============================================================================
// Filesystem responses
// ============================================================================

export const DirListEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
}) satisfies z.ZodType<DirListEntry>

export const DirListResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  roots: z.array(z.string()),
  entries: z.array(DirListEntrySchema),
  error: z.string().optional(),
}) satisfies z.ZodType<DirListResult>

export const FileListEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
}) satisfies z.ZodType<FileListEntry>

export const FileListResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  files: z.array(FileListEntrySchema),
  truncated: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<FileListResult>

export const FileContentsResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  content: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<FileContentsResult>

export const OverflowContentsResultSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  callId: z.string(),
  content: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<OverflowContentsResult>

export const DeleteOverflowSessionResultSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  deleted: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<DeleteOverflowSessionResult>

export const CopyOverflowSessionResultSchema = z.object({
  requestId: z.string(),
  sourceSessionId: z.string(),
  targetSessionId: z.string(),
  copied: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<CopyOverflowSessionResult>

// ============================================================================
// Background task results
// ============================================================================

const _BackgroundTaskSummaryFromExec = ServerBgTaskUpdatedSchema.shape.task

export const BgListResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  tasks: z.array(_BackgroundTaskSummaryFromExec),
  error: z.string().optional(),
}) satisfies z.ZodType<BgListResult>

export const BgOutputResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
  content: z.string(),
  nextOffset: z.number().int().nonnegative(),
  done: z.boolean(),
  status: z.enum(['running', 'exited', 'killed', 'signaled']),
  bytesTruncated: z.number().int().nonnegative(),
  error: z.string().optional(),
}) satisfies z.ZodType<BgOutputResult>

export const BgKillResultSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
  killed: z.boolean(),
  error: z.string().optional(),
}) satisfies z.ZodType<BgKillResult>

// Re-export executor push shapes for outbound consumers
export type { ServerBgTaskUpdated, ServerBgTaskEvicted }

// ============================================================================
// Sub-agent + agent types responses
// ============================================================================

export const SubAgentSummarySchema = z.object({
  childSessionId: z.string(),
  parentCallId: z.string().optional(),
  agentType: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
}) satisfies z.ZodType<SubAgentSummary>

export const SubAgentListResultSchema = z.object({
  requestId: z.string(),
  parentSessionId: z.string(),
  children: z.array(SubAgentSummarySchema),
  error: z.string().optional(),
}) satisfies z.ZodType<SubAgentListResult>

export const AgentTypeSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  systemPromptPreview: z.string().optional(),
}) satisfies z.ZodType<AgentTypeSummary>

export const AgentTypesResultSchema = z.object({
  requestId: z.string(),
  types: z.array(AgentTypeSummarySchema),
  error: z.string().optional(),
}) satisfies z.ZodType<AgentTypesResult>

export const ConsolidateMemoryResultSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  saved: z.array(z.string()),
  skipped: z.number().int().nonnegative(),
  reason: z.string().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<ConsolidateMemoryResult>

// ============================================================================
// Models / settings
// ============================================================================

const ModelSourceSchema = z.enum([
  'claude-settings',
  'codex-config',
  'env',
  'manual',
]) satisfies z.ZodType<ModelSource>

export const ModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  providerId: z.string().optional(),
  source: ModelSourceSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
}) satisfies z.ZodType<ModelInfo>

export const ServerModelsPayloadSchema = z.object({
  models: z.array(ModelInfoSchema),
  defaultModel: z.string(),
}) satisfies z.ZodType<ServerModelsPayload>

export const SettingsProviderSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  wire: z.enum(['anthropic', 'openai']),
  source: ModelSourceSchema.optional(),
  baseUrl: z.string().optional(),
  models: z.array(ModelInfoSchema),
}) satisfies z.ZodType<SettingsProviderSummary>

export const SettingsHookSummarySchema = z.object({
  event: z.enum(['pre_tool_use', 'post_tool_use', 'session_start', 'session_end']),
  command: z.string(),
  match: z.string().optional(),
}) satisfies z.ZodType<SettingsHookSummary>

const SettingsSkillDiagnosticSchema = z.object({
  level: z.literal('warning'),
  path: z.string(),
  message: z.string(),
})

const SettingsSkillSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  roots: z.array(z.string()),
  diagnostics: z.array(SettingsSkillDiagnosticSchema),
})

export const ServerSettingsPayloadSchema = z.object({
  providers: z.array(SettingsProviderSummarySchema),
  defaultModel: z.string(),
  hooks: z.array(SettingsHookSummarySchema),
  versions: z
    .object({
      host: z.string(),
      protocol: z.string(),
      build: BuildMetadataSchema.optional(),
    })
    .optional(),
  auth: z
    .object({
      dashboardAuthRequired: z.boolean(),
      githubOAuth: z.object({
        required: z.boolean(),
        configured: z.boolean(),
        usernameWhitelistEnabled: z.boolean(),
        usernameWhitelist: z.array(z.string()),
      }),
      executorIdentity: z.object({
        tokenScoped: z.boolean(),
        tokenCount: z.number().int().nonnegative(),
        inviteCount: z.number().int().nonnegative().optional(),
      }),
    })
    .optional(),
  paths: z.object({
    claudeSettings: z.string(),
    codexConfig: z.string(),
    manualModels: z.string(),
    hooksConfig: z.string(),
    sessionsDir: z.string(),
  }),
  mcp: z.object({
    supported: z.literal(false),
    note: z.string(),
  }),
  skills: SettingsSkillSummarySchema.optional(),
  release: z
    .object({
      bootstrapBaseUrl: z.string(),
      source: z.enum(['local', 'github']),
    })
    .optional(),
}) satisfies z.ZodType<ServerSettingsPayload>

// ============================================================================
// Executor identity admin surface
// ============================================================================

export const ExecutorIdentitySummarySchema = z.object({
  workspaceId: z.string(),
  label: z.string().optional(),
  createdAt: z.string(),
  lastSeenAt: z.string().optional(),
}) satisfies z.ZodType<ExecutorIdentitySummary>

export const ServerExecutorIdentitiesPayloadSchema = z.object({
  identities: z.array(ExecutorIdentitySummarySchema),
}) satisfies z.ZodType<ServerExecutorIdentitiesPayload>

export const ServerExecutorIdentityRevokedPayloadSchema = z.object({
  ok: z.literal(true),
  workspaceId: z.string(),
  revoked: z.boolean(),
}) satisfies z.ZodType<ServerExecutorIdentityRevokedPayload>

export const ExecutorInviteSummarySchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  revoked: z.boolean(),
}) satisfies z.ZodType<ExecutorInviteSummary>

export const ServerExecutorInvitesPayloadSchema = z.object({
  invites: z.array(ExecutorInviteSummarySchema),
}) satisfies z.ZodType<ServerExecutorInvitesPayload>

export const ServerExecutorInvitePayloadSchema = z.object({
  id: z.string(),
  inviteToken: z.string(),
  label: z.string().optional(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  revoked: z.boolean().optional(),
}) satisfies z.ZodType<ServerExecutorInvitePayload>

export const ServerExecutorInviteRevokedPayloadSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  revoked: z.boolean(),
}) satisfies z.ZodType<ServerExecutorInviteRevokedPayload>

// Silence unused import warnings for types that are only used as annotations.
export type { ManualModelInput }
void ManualModelInputSchema

// ============================================================================
// JSONL log entries (used by the log ingester)
// ============================================================================

export const HeaderEntrySchema = z.object({
  kind: z.literal('header'),
  seq: z.literal(0),
  ts: z.string(),
  sessionId: z.string(),
  parentSessionId: z.string().optional(),
  parentCursor: z.number().int().nonnegative().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  initialCwd: z.string().optional(),
  formatVersion: z.literal(2),
  kernelVersion: z.string(),
  config: AgentConfigSchema,
  initialState: AgentStateSchema,
}) satisfies z.ZodType<HeaderEntry>

export const EventEntrySchema = z.object({
  kind: z.literal('event'),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  event: AgentEventSchema,
  effects: z.array(EffectSchema),
  usage: UsageTotalSchema.optional(),
  effectsArtifact: z.object({ path: z.string(), bytes: z.number(), sha256: z.string() }).optional(),
  llmTrace: LLMTraceSchema.optional(),
  llmTraceArtifact: z.object({ path: z.string(), bytes: z.number(), sha256: z.string() }).optional(),
  model: z.string().optional(),
}) satisfies z.ZodType<EventEntry>

export const SnapshotEntrySchema = z.object({
  kind: z.literal('snapshot'),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  state: AgentStateSchema,
}) satisfies z.ZodType<SnapshotEntry>

export const MetadataEntrySchema = z.object({
  kind: z.literal('metadata'),
  ts: z.string(),
  label: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
}) satisfies z.ZodType<MetadataEntry>

export const LogEntrySchema = z.discriminatedUnion('kind', [
  HeaderEntrySchema,
  EventEntrySchema,
  SnapshotEntrySchema,
  MetadataEntrySchema,
]) satisfies z.ZodType<LogEntry>

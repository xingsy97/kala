/**
 * Zod schemas for Dashboard - Host RPC inputs (socket 'client:*' + 'bg:*'
 * + 'sub_agent:*' + 'agent_types:*' payloads, plus HTTP request bodies).
 *
 * types-first: `../protocol.ts` remains authoritative. Each schema is checked
 * against its TS counterpart via `satisfies z.ZodType<T>`.
 *
 * Boundary usage: `.parse()` these in socket + HTTP handlers only.
 */

import { z } from 'zod'

import type {
  ClientCancel,
  ClientCancelStream,
  ClientClear,
  ClientCompact,
  ClientConsolidateMemory,
  ClientCreateSession,
  ClientDeleteQueuedMessage,
  ClientDeleteSession,
  ClientFork,
  ClientInterruptSubAgent,
  ClientKillBgTask,
  ClientListAgentTypes,
  ClientListBgTasks,
  ClientListDirs,
  ClientListExecutors,
  ClientListFiles,
  ClientListSessions,
  ClientListSubAgents,
  ClientLoadHistory,
  ClientReadBgOutput,
  ClientReadFile,
  ClientReadOverflow,
  ClientRenameSession,
  ClientRenameWorkspace,
  ClientReorderQueuedMessage,
  ClientSetApprovalMode,
  ClientSetCwd,
  ClientSetModel,
  ClientSubscribe,
  ClientUpdatePreferences,
  ClientUpdateQueuedMessage,
  ClientUserApprove,
  ClientUserMessage,
  ClientUserReject,
  ClientAddManualModel,
  ClientDeleteManualModel,
  CopyOverflowSession,
  DeleteOverflowSession,
  ManualModelInput,
  SessionPreferences,
} from '../protocol.js'
import { ApprovalModeSchema, MessageContentSchema } from './kernel.js'

// ============================================================================
// Per-session preferences
// ============================================================================

export const SessionPreferencesSchema = z.object({
  selectedModel: z.string().optional(),
}) satisfies z.ZodType<SessionPreferences>

// ============================================================================
// Composer / turn-loop
// ============================================================================

export const ClientUserMessageSchema = z.object({
  sessionId: z.string(),
  text: z.string(),
  mode: z.enum(['steer', 'queue']).optional(),
  content: z.array(MessageContentSchema).optional(),
}) satisfies z.ZodType<ClientUserMessage>

export const ClientUserApproveSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
}) satisfies z.ZodType<ClientUserApprove>

export const ClientUserRejectSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
  reason: z.string().optional(),
}) satisfies z.ZodType<ClientUserReject>

export const ClientCancelSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<ClientCancel>

export const ClientClearSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<ClientClear>

export const ClientCompactSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<ClientCompact>

export const ClientCancelStreamSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<ClientCancelStream>

export const ClientInterruptSubAgentSchema = z.object({
  parentSessionId: z.string(),
  parentCallId: z.string(),
  childSessionId: z.string().optional(),
}) satisfies z.ZodType<ClientInterruptSubAgent>

export const ClientSetApprovalModeSchema = z.object({
  sessionId: z.string(),
  mode: ApprovalModeSchema,
}) satisfies z.ZodType<ClientSetApprovalMode>

// ============================================================================
// Session lifecycle
// ============================================================================

export const ClientForkSchema = z.object({
  sourceSessionId: z.string(),
  cursor: z.number().int().nonnegative(),
  newSessionId: z.string().optional(),
  seedMessage: z.string().optional(),
}) satisfies z.ZodType<ClientFork>

export const ClientCreateSessionSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string().optional(),
  cwd: z.string().optional(),
}) satisfies z.ZodType<ClientCreateSession>

export const ClientSubscribeSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<ClientSubscribe>

export const ClientLoadHistorySchema = z.object({
  sessionId: z.string(),
  sinceCursor: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<ClientLoadHistory>

export const ClientDeleteSessionSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<ClientDeleteSession>

export const ClientListSessionsSchema = z.record(z.string(), z.never()) as unknown as z.ZodType<ClientListSessions>

export const ClientListExecutorsSchema = z.record(z.string(), z.never()) as unknown as z.ZodType<ClientListExecutors>

// ============================================================================
// Model / preferences / cwd
// ============================================================================

export const ClientSetModelSchema = z.object({
  sessionId: z.string(),
  model: z.string(),
}) satisfies z.ZodType<ClientSetModel>

export const ClientUpdatePreferencesSchema = z.object({
  sessionId: z.string(),
  preferences: SessionPreferencesSchema,
}) satisfies z.ZodType<ClientUpdatePreferences>

export const ClientSetCwdSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
}) satisfies z.ZodType<ClientSetCwd>

// ============================================================================
// Queued messages
// ============================================================================

export const ClientReorderQueuedMessageSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
  beforeId: z.string().nullable().optional(),
}) satisfies z.ZodType<ClientReorderQueuedMessage>

export const ClientUpdateQueuedMessageSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
  text: z.string(),
}) satisfies z.ZodType<ClientUpdateQueuedMessage>

export const ClientDeleteQueuedMessageSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
}) satisfies z.ZodType<ClientDeleteQueuedMessage>

// ============================================================================
// Rename
// ============================================================================

export const ClientRenameSessionSchema = z.object({
  sessionId: z.string(),
  label: z.string(),
}) satisfies z.ZodType<ClientRenameSession>

export const ClientRenameWorkspaceSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
}) satisfies z.ZodType<ClientRenameWorkspace>

// ============================================================================
// Filesystem RPCs
// ============================================================================

export const ClientListDirsSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  path: z.string().optional(),
}) satisfies z.ZodType<ClientListDirs>

export const ClientListFilesSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
}) satisfies z.ZodType<ClientListFiles>

export const ClientReadFileSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  maxBytes: z.number().int().positive().optional(),
}) satisfies z.ZodType<ClientReadFile>

export const ClientReadOverflowSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  callId: z.string(),
}) satisfies z.ZodType<ClientReadOverflow>

export const DeleteOverflowSessionSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
}) satisfies z.ZodType<DeleteOverflowSession>

export const CopyOverflowSessionSchema = z.object({
  requestId: z.string(),
  sourceSessionId: z.string(),
  targetSessionId: z.string(),
}) satisfies z.ZodType<CopyOverflowSession>

// ============================================================================
// Background tasks
// ============================================================================

export const ClientListBgTasksSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
}) satisfies z.ZodType<ClientListBgTasks>

export const ClientReadBgOutputSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  taskId: z.string(),
  offset: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
}) satisfies z.ZodType<ClientReadBgOutput>

export const ClientKillBgTaskSchema = z.object({
  requestId: z.string(),
  workspaceId: z.string(),
  taskId: z.string(),
}) satisfies z.ZodType<ClientKillBgTask>

// ============================================================================
// Sub-agents
// ============================================================================

export const ClientListSubAgentsSchema = z.object({
  requestId: z.string(),
  parentSessionId: z.string(),
}) satisfies z.ZodType<ClientListSubAgents>

export const ClientListAgentTypesSchema = z.object({
  requestId: z.string(),
}) satisfies z.ZodType<ClientListAgentTypes>

// ============================================================================
// Misc
// ============================================================================

export const ClientConsolidateMemorySchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
}) satisfies z.ZodType<ClientConsolidateMemory>

// ============================================================================
// HTTP body: manual model add/delete
// ============================================================================

export const ManualModelInputSchema = z.object({
  providerId: z.string(),
  id: z.string(),
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
}) satisfies z.ZodType<ManualModelInput>

export const ClientAddManualModelSchema = ManualModelInputSchema satisfies z.ZodType<ClientAddManualModel>

export const ClientDeleteManualModelSchema = z.object({
  providerId: z.string(),
  id: z.string(),
}) satisfies z.ZodType<ClientDeleteManualModel>

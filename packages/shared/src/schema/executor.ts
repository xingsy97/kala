/**
 * Zod schemas for the executor↔host wire surface.
 *
 * types-first: TypeScript definitions in `../protocol.ts` remain authoritative.
 * Each exported schema is checked against its TS counterpart via
 * `satisfies z.ZodType<T>` so drift surfaces at compile time.
 *
 * Boundary usage: `.parse()` these at socket-handler edges only
 * (see `packages/host/src/executor-socket.ts`). Never inside pure internal
 * functions.
 */

import { z } from 'zod'

import type {
  ExecutorAnnounce,
  ExecutorOs,
  ExecutorRuntime,
  ServerBgTaskEvicted,
  ServerBgTaskUpdated,
  ToolCallMessage,
  ToolCancelMessage,
  ToolProgressPayload,
  ToolResultAck,
  BackgroundTaskStatus,
  BackgroundTaskSummary,
  HandshakeAuth,
  ClientRole,
} from '../protocol.js'

// ============================================================================
// Handshake
// ============================================================================

export const ClientRoleSchema = z.enum(['dashboard', 'executor']) satisfies z.ZodType<ClientRole>

export const HandshakeAuthSchema = z.object({
  role: ClientRoleSchema,
  sessionId: z.string().optional(),
  token: z.string().optional(),
  invite: z.string().optional(),
  clientVersion: z.string(),
}) satisfies z.ZodType<HandshakeAuth>

// ============================================================================
// Executor → Host
// ============================================================================

const ExecutorRuntimeSchema = z.enum([
  'node',
  'browser-webcontainer',
  'other',
]) satisfies z.ZodType<ExecutorRuntime>

const ExecutorOsSchema = z.enum([
  'linux',
  'darwin',
  'win32',
  'other',
]) satisfies z.ZodType<ExecutorOs>

export const ExecutorAnnounceSchema = z.object({
  executorId: z.string(),
  executorVersion: z.string().optional(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  tools: z.array(z.string()),
  sandboxRoots: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  runtime: ExecutorRuntimeSchema,
  runtimeVersion: z.string(),
  hostname: z.string().optional(),
  os: ExecutorOsSchema.optional(),
  ipAddresses: z.array(z.string()).optional(),
  pid: z.number().int().optional(),
  startedAt: z.string().optional(),
}) satisfies z.ZodType<ExecutorAnnounce>

export const ToolProgressPayloadSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
  chunk: z.string(),
}) satisfies z.ZodType<ToolProgressPayload>

const BackgroundTaskStatusSchema = z.enum([
  'running',
  'exited',
  'killed',
  'signaled',
]) satisfies z.ZodType<BackgroundTaskStatus>

export const BackgroundTaskSummarySchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  command: z.string(),
  cwd: z.string(),
  pid: z.number().int().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: BackgroundTaskStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  bytesLogged: z.number().int().nonnegative(),
  bytesTruncated: z.number().int().nonnegative(),
}) satisfies z.ZodType<BackgroundTaskSummary>

export const ServerBgTaskUpdatedSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  task: BackgroundTaskSummarySchema,
  delta: z
    .object({
      fromOffset: z.number().int().nonnegative(),
      content: z.string(),
    })
    .optional(),
}) satisfies z.ZodType<ServerBgTaskUpdated>

export const ServerBgTaskEvictedSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
}) satisfies z.ZodType<ServerBgTaskEvicted>

// ============================================================================
// Host → Executor
// ============================================================================

export const ToolCallMessageSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<ToolCallMessage>

export const ToolCancelMessageSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
}) satisfies z.ZodType<ToolCancelMessage>

export const ToolResultAckSchema = z.object({
  callId: z.string(),
  ok: z.boolean(),
  content: z.string(),
}) satisfies z.ZodType<ToolResultAck>

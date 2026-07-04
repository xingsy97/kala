/**
 * Wire protocol types. Shared verbatim between host, executor, and dashboard.
 *
 * Every message that crosses process boundaries is typed here. If a client
 * matches this file, it interoperates with the host. Any change here MUST
 * also update `docs/protocol/wire-protocol.md` in the same PR.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'

// ============================================================================
// Handshake
// ============================================================================

export type ClientRole = 'dashboard' | 'executor'

export type HandshakeAuth = {
  sessionId: string
  role: ClientRole
  token?: string
  clientVersion: string
}

// ============================================================================
// Common events  -  Host broadcasts to all clients in a session room
// ============================================================================

export type SessionReadyEvent = {
  sessionId: string
  cursor: number
  state: AgentState
  config: AgentConfig
  parentSessionId?: string
  parentCursor?: number
}

export type StateChangedEvent = {
  sessionId: string
  cursor: number
  state: AgentState
}

export type EventAppendedEvent = {
  sessionId: string
  seq: number
  ts: string
  event: AgentEvent
  effects: readonly Effect[]
}

export const SESSION_ERROR_SCOPES = ['kernel', 'llm', 'executor', 'host'] as const
export type SessionErrorScope = (typeof SESSION_ERROR_SCOPES)[number]

export type SessionErrorEvent = {
  sessionId: string
  scope: SessionErrorScope
  message: string
}

export type SessionForkedEvent = {
  sessionId: string
  parentSessionId: string
  parentCursor: number
  cursor: number
  state: AgentState
  config: AgentConfig
}

// ============================================================================
// Dashboard  -  Host
// ============================================================================

export type ClientUserMessage = {
  sessionId: string
  text: string
}

export type ClientUserApprove = {
  sessionId: string
  callId: string
}

export type ClientUserReject = {
  sessionId: string
  callId: string
  reason?: string
}

export type ClientCancel = {
  sessionId: string
}

export type ClientFork = {
  sourceSessionId: string
  cursor: number
  newSessionId?: string
}

export type ClientSubscribe = {
  sessionId: string
}

// ============================================================================
// Host  -  Dashboard only
// ============================================================================

export type ApprovalRequiredEvent = {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
}

export type UsageUpdatedEvent = {
  sessionId: string
  usage: UsageTotal
}

// ============================================================================
// Executor  -  Host
// ============================================================================

export type ExecutorRuntime = 'node' | 'browser-webcontainer' | 'other'

export type ExecutorAnnounce = {
  sessionId: string
  executorId: string
  tools: string[]
  workingDir?: string
  runtime: ExecutorRuntime
  runtimeVersion: string
}

export type ExecutorToolResult = {
  sessionId: string
  callId: string
  ok: boolean
  content: string
}

// ============================================================================
// Host  -  Executor
// ============================================================================

export type ToolCallMessage = {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  timeoutMs?: number
}

export type ToolCancelMessage = {
  sessionId: string
  callId: string
}

export type ToolResultAck = {
  callId: string
  ok: boolean
  content: string
}

// ============================================================================
// Socket.IO event maps
// ============================================================================

export type DashboardClientToServerEvents = {
  'client:user_message': (payload: ClientUserMessage) => void
  'client:user_approve': (payload: ClientUserApprove) => void
  'client:user_reject': (payload: ClientUserReject) => void
  'client:cancel': (payload: ClientCancel) => void
  'client:fork': (payload: ClientFork) => void
  subscribe: (payload: ClientSubscribe) => void
}

export type DashboardServerToClientEvents = {
  'session:ready': (payload: SessionReadyEvent) => void
  'session:forked': (payload: SessionForkedEvent) => void
  'state:changed': (payload: StateChangedEvent) => void
  'event:appended': (payload: EventAppendedEvent) => void
  'session:error': (payload: SessionErrorEvent) => void
  'approval:required': (payload: ApprovalRequiredEvent) => void
  'usage:updated': (payload: UsageUpdatedEvent) => void
}

export type ExecutorClientToServerEvents = {
  'executor:announce': (payload: ExecutorAnnounce) => void
  'executor:tool_result': (payload: ExecutorToolResult) => void
}

export type ExecutorServerToClientEvents = {
  'session:ready': (payload: SessionReadyEvent) => void
  'state:changed': (payload: StateChangedEvent) => void
  'event:appended': (payload: EventAppendedEvent) => void
  'session:error': (payload: SessionErrorEvent) => void
  'tool:call': (
    payload: ToolCallMessage,
    ack: (result: ToolResultAck) => void,
  ) => void
  'tool:cancel': (payload: ToolCancelMessage) => void
}

export const PROTOCOL_VERSION = '0.1.0' as const

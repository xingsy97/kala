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
  ApprovalMode,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'

// ============================================================================
// Handshake
// ============================================================================

export type ClientRole = 'dashboard' | 'executor'

/**
 * Dashboard connections carry a `sessionId` (the session they subscribe to).
 * Executor connections do NOT — an executor daemon serves all sessions the
 * host routes to it. `sessionId` on individual `tool:call` / `tool:cancel`
 * messages is the per-call routing key.
 */
export type HandshakeAuth = {
  role: ClientRole
  sessionId?: string
  token?: string
  clientVersion: string
}

// ============================================================================
// Common events — Host broadcasts to all clients in a session room
// ============================================================================

export type SessionReadyEvent = {
  sessionId: string
  cursor: number
  state: AgentState
  config: AgentConfig
  parentSessionId?: string
  parentCursor?: number
  /**
   * Routing key: the workspaceId this session is bound to. Undefined for
   * legacy sessions predating the field.
   */
  workspaceId?: string
  /** Display label captured at session-create time. */
  workspaceName?: string
  selectedModel?: string
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
  workspaceId?: string
  workspaceName?: string
}

// ============================================================================
// Dashboard → Host
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

export type ClientCompact = {
  sessionId: string
}

/**
 * Abort the in-flight LLM call for a session. The host tears down the
 * network request (via AbortController) and lets the loop synthesize a
 * normal `llm_response` from whatever partial text was already streamed —
 * append `[cancelled]` so operators can spot it. Idempotent: emitting it
 * for a session that isn't streaming is a no-op.
 */
export type ClientCancelStream = {
  sessionId: string
}

export type ServerTokenDeltaEvent = {
  sessionId: string
  /** UTF-8 text delta appended to the current assistant message. */
  text: string
}

export type ClientSetApprovalMode = {
  sessionId: string
  mode: ApprovalMode
}

export type SessionApprovalModeEvent = {
  sessionId: string
  mode: ApprovalMode
}

export type ClientFork = {
  sourceSessionId: string
  cursor: number
  newSessionId?: string
}

/**
 * Ask the host to materialise a session on disk with a workspace binding.
 * Dashboard emits this when the user clicks "New" so the Explorer row shows
 * up immediately (instead of waiting until the first user_message triggers
 * lazy-create) and the session's workspaceId is set from the start.
 * Idempotent — a second emit for the same id is a no-op on the store side.
 */
export type ClientCreateSession = {
  sessionId: string
  workspaceId: string
  workspaceName?: string
}

export type ClientSubscribe = {
  sessionId: string
}

export type ClientSetModel = {
  sessionId: string
  model: string
}

export type ClientSetCwd = {
  sessionId: string
  cwd: string
}

// ============================================================================
// Host → Dashboard only
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

export type SessionModelChangedEvent = {
  sessionId: string
  model: string
}

// ============================================================================
// Executor → Host
// ============================================================================

export type ExecutorRuntime = 'node' | 'browser-webcontainer' | 'other'

export type ExecutorOs = 'linux' | 'darwin' | 'win32' | 'other'

export type McpServerConfig = {
  name: string
  command: string
  args?: readonly string[]
  env?: Record<string, string>
}

export type ExecutorAnnounce = {
  executorId: string
  /**
   * Stable machine identity. A ULID minted on the executor's first launch
   * and persisted (see packages/executor/src/workspace-id.ts). Sessions
   * bind to this in their JSONL header; Host routes tool calls by matching
   * `session.workspaceId` against a live executor. Never renamed — a lost
   * or regenerated id detaches the machine's existing sessions, which is
   * why the executor refuses to boot with a corrupted id file.
   */
  workspaceId: string
  /**
   * Human-readable workspace label. Display only — the operator can
   * change it freely via `--name` without affecting routing. Falls back
   * to `os.hostname()` when the operator doesn't pass a name.
   */
  workspaceName: string
  tools: string[]
  /** Optional filesystem jail. Empty/missing = executor trusts whole machine. */
  sandboxRoots?: string[]
  workingDir?: string
  runtime: ExecutorRuntime
  runtimeVersion: string
  hostname?: string
  os?: ExecutorOs
  ipAddresses?: string[]
  pid?: number
  startedAt?: string
}

export type ExecutorToolResult = {
  sessionId: string
  callId: string
  ok: boolean
  content: string
}

// ============================================================================
// Host → Executor
// ============================================================================

export type ToolCallMessage = {
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string
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

// ============================================================================
// Control-plane events (Dashboard ⇄ Host)
// ============================================================================

export type AttachedExecutor = ExecutorAnnounce & {
  attachedAt: string
  /**
   * The `clientVersion` from the executor's handshake auth. Recorded so the
   * dashboard can distinguish "os field is undefined because this executor
   * predates the field" from "executor connected but never got announced".
   */
  clientVersion?: string
}

export type ClientListExecutors = Record<string, never>

export type ServerExecutorsPayload = {
  executors: readonly AttachedExecutor[]
}

export type ExecutorChange = 'attached' | 'detached' | 'updated'

export type ServerExecutorChangedPayload =
  | { change: 'detached'; executorId: string }
  | {
      change: 'attached' | 'updated'
      executorId: string
      executor: AttachedExecutor
    }

export type ClientListSessions = Record<string, never>

export type SessionSummary = {
  sessionId: string
  createdAt: string
  lastEventAt?: string
  eventCount: number
  parentSessionId?: string
  /**
   * The workspace this session is bound to (see ADR 0014). Routing key —
   * matches an executor's announced `workspaceId`. Written to the JSONL
   * header at create time; never rewritten. Sessions predating the field
   * have this undefined and render under a synthetic "unassigned" root
   * in the dashboard tree.
   */
  workspaceId?: string
  /**
   * Display label for the workspace, captured at session-create time.
   * Not authoritative — the current display name comes from the live
   * executor's announce when one is attached. Held here so the dashboard
   * can render offline workspaces without needing every executor online.
   */
  workspaceName?: string
  executorId?: string
  status?: AgentState['status']
  currentCwd?: string
  firstUserMessage?: string
}

export type ServerSessionsPayload = {
  sessions: readonly SessionSummary[]
}

export type ClientLoadHistory = {
  sessionId: string
  sinceCursor?: number
}

export type ClientDeleteSession = {
  sessionId: string
}

export type ServerSessionDeletedPayload = {
  sessionId: string
}

export type ServerHistoryPayload = {
  sessionId: string
  entries: readonly EventAppendedEvent[]
}

/**
 * Advertised model. Returned by `GET /models` on the host. The dashboard uses
 * this to populate the model picker instead of hardcoding a list.
 */
export type ModelInfo = {
  id: string
  label: string
  provider: string
}

export type ServerModelsPayload = {
  models: readonly ModelInfo[]
  defaultModel: string
}

// ============================================================================
// Socket.IO event maps
// ============================================================================

export type DashboardClientToServerEvents = {
  'client:user_message': (payload: ClientUserMessage) => void
  'client:user_approve': (payload: ClientUserApprove) => void
  'client:user_reject': (payload: ClientUserReject) => void
  'client:cancel': (payload: ClientCancel) => void
  'client:compact': (payload: ClientCompact) => void
  'client:cancel_stream': (payload: ClientCancelStream) => void
  'client:set_approval_mode': (payload: ClientSetApprovalMode) => void
  'client:fork': (payload: ClientFork) => void
  'client:create_session': (payload: ClientCreateSession) => void
  'client:list_executors': (payload: ClientListExecutors) => void
  'client:list_sessions': (payload: ClientListSessions) => void
  'client:load_history': (payload: ClientLoadHistory) => void
  'client:delete_session': (payload: ClientDeleteSession) => void
  'client:set_model': (payload: ClientSetModel) => void
  'client:set_cwd': (payload: ClientSetCwd) => void
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
  'session:model_changed': (payload: SessionModelChangedEvent) => void
  'session:token_delta': (payload: ServerTokenDeltaEvent) => void
  'session:approval_mode': (payload: SessionApprovalModeEvent) => void
  'server:executors': (payload: ServerExecutorsPayload) => void
  'server:executor_changed': (payload: ServerExecutorChangedPayload) => void
  'server:sessions': (payload: ServerSessionsPayload) => void
  'server:history': (payload: ServerHistoryPayload) => void
  'server:session_deleted': (payload: ServerSessionDeletedPayload) => void
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

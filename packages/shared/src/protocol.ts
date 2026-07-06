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
  MessageContent,
  UsageTotal,
} from '@agent-kernel/kernel'
import type { LLMTrace } from './log.js'

// ============================================================================
// Handshake
// ============================================================================

export type ClientRole = 'dashboard' | 'executor'

/**
 * Dashboard connections carry a `sessionId` (the session they subscribe to).
 * Executor connections do NOT  -  an executor daemon serves all sessions the
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
// Common events  -  Host broadcasts to all clients in a session room
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
  llmTrace?: LLMTrace
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
// Dashboard  -  Host
// ============================================================================

export type ClientUserMessage = {
  sessionId: string
  text: string
  mode?: 'steer' | 'queue'
  /**
   * Structured content blocks. When present, kernel uses these verbatim
   * (mixing text + image blocks from pasted screenshots); `text` is kept as
   * a plain-text mirror for logs and non-image adapters.
   */
  content?: readonly MessageContent[]
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
 * normal `llm_response` from whatever partial text was already streamed  - 
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
  /**
   * Optional first user message to dispatch on the freshly-forked session in
   * the same operation. Used by "edit and rerun"  -  dashboard forks at the
   * cursor *before* the message the user edited, then seeds the edited text
   * so the child session runs to completion without a second roundtrip.
   */
  seedMessage?: string
}

/**
 * Ask the host to materialise a session on disk with a workspace binding.
 * Dashboard emits this when the user clicks "New" so the Explorer row shows
 * up immediately (instead of waiting until the first user_message triggers
 * lazy-create) and the session's workspaceId is set from the start.
 * Idempotent  -  a second emit for the same id is a no-op on the store side.
 */
export type ClientCreateSession = {
  sessionId: string
  workspaceId: string
  workspaceName?: string
  /** Initial tool cwd for the session. Validated against the workspace sandbox. */
  cwd?: string
}

export type ClientListDirs = {
  requestId: string
  workspaceId: string
  path?: string
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

/**
 * Rename a session. Empty/whitespace label clears the override, causing the
 * dashboard to fall back to `firstUserMessage`. Host writes a metadata log
 * entry so summaries survive host restarts.
 */
export type ClientRenameSession = {
  sessionId: string
  label: string
}

export type SessionRenamedEvent = {
  sessionId: string
  label: string
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

export type SessionModelChangedEvent = {
  sessionId: string
  model: string
}

// ============================================================================
// Executor  -  Host
// ============================================================================

export type ExecutorRuntime = 'node' | 'browser-webcontainer' | 'other'

export type ExecutorOs = 'linux' | 'darwin' | 'win32' | 'other'

export type ExecutorAnnounce = {
  executorId: string
  /**
   * Stable machine identity. A ULID minted on the executor's first launch
   * and persisted (see packages/executor/src/workspace-id.ts). Sessions
   * bind to this in their JSONL header; Host routes tool calls by matching
   * `session.workspaceId` against a live executor. Never renamed  -  a lost
   * or regenerated id detaches the machine's existing sessions, which is
   * why the executor refuses to boot with a corrupted id file.
   */
  workspaceId: string
  /**
   * Human-readable workspace label. Display only  -  the operator can
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

export type DirListEntry = {
  name: string
  path: string
}

export type DirListResult = {
  requestId: string
  workspaceId: string
  path: string
  roots: readonly string[]
  entries: readonly DirListEntry[]
  error?: string
}

/**
 * Dashboard-driven fuzzy file search for the composer's `@file` mention picker.
 * Executor walks the workspace root(s), skipping node_modules/.git/dist, and
 * returns up to `limit` file paths (workspace-relative) that match `query`.
 */
export type ClientListFiles = {
  requestId: string
  workspaceId: string
  query?: string
  limit?: number
}

export type FileListEntry = {
  path: string
  size: number
}

export type FileListResult = {
  requestId: string
  workspaceId: string
  files: readonly FileListEntry[]
  truncated: boolean
  error?: string
}

/**
 * Dashboard-driven read of a single workspace file for `@file` inline expansion.
 * Executor refuses paths outside the workspace or files above `maxBytes`
 * (default 64 KiB) so the composer can render an inline toast.
 */
export type ClientReadFile = {
  requestId: string
  workspaceId: string
  path: string
  maxBytes?: number
}

export type FileContentsResult = {
  requestId: string
  workspaceId: string
  path: string
  content?: string
  size?: number
  error?: string
}

// ============================================================================
// Host  -  Executor
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
// Control-plane events (Dashboard  -  Host)
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
   * The workspace this session is bound to (see ADR 0014). Routing key  - 
   * matches an executor's announced `workspaceId`. Written to the JSONL
   * header at create time; never rewritten. Sessions predating the field
   * have this undefined and render under a synthetic "unassigned" root
   * in the dashboard tree.
   */
  workspaceId?: string
  /**
   * Display label for the workspace, captured at session-create time.
   * Not authoritative  -  the current display name comes from the live
   * executor's announce when one is attached. Held here so the dashboard
   * can render offline workspaces without needing every executor online.
   */
  workspaceName?: string
  executorId?: string
  status?: AgentState['status']
  currentCwd?: string
  firstUserMessage?: string
  /**
   * Operator-provided display label from the most recent `client:rename_session`.
   * When unset the dashboard uses `firstUserMessage` as before.
   */
  label?: string
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
  /** Model context window in tokens, when known by the host. */
  contextWindow?: number
}

export type ServerModelsPayload = {
  models: readonly ModelInfo[]
  defaultModel: string
}

/**
 * Host's advertised settings snapshot. Returned by `GET /settings`.
 *
 * Read-only: the host reads its config from local files owned by the
 * operator, and we don't (yet) let the dashboard write those files. The
 * Settings UI shows what's active, points at where to edit it, and provides
 * copy-paste config snippets for the current state.
 *
 * Never contains API keys, hook payloads, or command args that could leak
 * env  -  the endpoint is served over the same socket the dashboard uses and
 * anyone with dashboard access could already fetch these, but we still
 * scrub secrets before serializing.
 */
export type SettingsProviderSummary = {
  id: string
  label: string
  wire: 'anthropic' | 'openai'
  baseUrl?: string
  models: readonly string[]
}

export type SettingsHookSummary = {
  event: 'pre_tool_use' | 'post_tool_use' | 'session_start' | 'session_end'
  command: string
  match?: string
}

export type ServerSettingsPayload = {
  providers: readonly SettingsProviderSummary[]
  defaultModel: string
  hooks: readonly SettingsHookSummary[]
  paths: {
    claudeSettings: string
    codexConfig: string
    hooksConfig: string
    sessionsDir: string
  }
  mcp: {
    supported: false
    note: string
  }
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
  'client:list_dirs': (payload: ClientListDirs) => void
  'client:list_files': (payload: ClientListFiles) => void
  'client:read_file': (payload: ClientReadFile) => void
  'client:list_executors': (payload: ClientListExecutors) => void
  'client:list_sessions': (payload: ClientListSessions) => void
  'client:load_history': (payload: ClientLoadHistory) => void
  'client:delete_session': (payload: ClientDeleteSession) => void
  'client:set_model': (payload: ClientSetModel) => void
  'client:set_cwd': (payload: ClientSetCwd) => void
  'client:rename_session': (payload: ClientRenameSession) => void
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
  'session:renamed': (payload: SessionRenamedEvent) => void
  'server:message_queue': (payload: ServerMessageQueueEvent) => void
  'server:executors': (payload: ServerExecutorsPayload) => void
  'server:executor_changed': (payload: ServerExecutorChangedPayload) => void
  'server:sessions': (payload: ServerSessionsPayload) => void
  'server:dir_list': (payload: DirListResult) => void
  'server:file_list': (payload: FileListResult) => void
  'server:file_contents': (payload: FileContentsResult) => void
  'server:history': (payload: ServerHistoryPayload) => void
  'server:session_deleted': (payload: ServerSessionDeletedPayload) => void
}

export type ServerMessageQueueEvent = {
  sessionId: string
  pending: number
  items: readonly QueuedMessagePreview[]
}

export type QueuedMessagePreview = {
  id: string
  text: string
  mode: 'steer' | 'queue'
  createdAt: string
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
  'fs:list_dirs': (
    payload: ClientListDirs,
    ack: (result: DirListResult) => void,
  ) => void
  'fs:list_files': (
    payload: ClientListFiles,
    ack: (result: FileListResult) => void,
  ) => void
  'fs:read_file': (
    payload: ClientReadFile,
    ack: (result: FileContentsResult) => void,
  ) => void
}

export const PROTOCOL_VERSION = '0.1.0' as const

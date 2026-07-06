/**
 * Core type definitions for @agent-kernel/kernel.
 *
 * Everything is plain data. No classes, no methods, no IO.
 * The kernel is a pure function `step(state, event) -> (nextState, effects)`.
 * All types are structurally shared across core / executor / dashboard.
 */

// ============================================================================
// Messages (LLM-facing conversation)
// ============================================================================

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type TextContent = {
  type: 'text'
  text: string
}

export type ToolCallContent = {
  type: 'tool_call'
  callId: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultContent = {
  type: 'tool_result'
  callId: string
  ok: boolean
  content: string
}

/**
 * Image attached to a message. Two shapes are permitted so the JSONL log
 * can stay readable when large images flow through: `file_ref` records a
 * path (resolved at send time by the host), `base64` inlines the bytes
 * (used when there is no filesystem context, e.g. pasted screenshots).
 */
export type ImageSource =
  | {
      kind: 'base64'
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      data: string
    }
  | {
      kind: 'file_ref'
      path: string
      mediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    }

export type ImageContent = {
  type: 'image'
  source: ImageSource
}

/**
 * Extended-thinking block (Anthropic-specific). The model's private
 * reasoning that produced the visible answer. Preserved in the message log
 * because the API requires echoing it back on the next turn for tool-use
 * flows; UI displays it collapsed by default.
 *
 * `signature` is a provider-generated opaque token proving the block came
 * from the API, required on the next turn per Anthropic's spec.
 */
export type ThinkingContent = {
  type: 'thinking'
  text: string
  signature?: string
}

export type MessageContent =
  | TextContent
  | ToolCallContent
  | ToolResultContent
  | ImageContent
  | ThinkingContent

export type Message = {
  role: Role
  content: MessageContent[]
}

// ============================================================================
// Tool schema (provider-agnostic; adapter maps to Anthropic/OpenAI/... form)
// ============================================================================

export type ToolSchema = {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema draft-07 (opaque to kernel)
  requiresApproval: boolean
}

// ============================================================================
// Config (static, session-lifetime; separate from mutable state)
// ============================================================================

export type AgentConfig = {
  readonly tools: readonly ToolSchema[]
  readonly systemPrompt?: string
  /**
   * Model's total context window in tokens. When set, the reducer derives
   * `state.contextPressureLevel` from `usage.inputTokens / contextLimit`.
   * Undefined = pressure never trips.
   */
  readonly contextLimit?: number
  /** Soft threshold ratio (default 0.75). UI banner appears at/above this. */
  readonly softThreshold?: number
  /** Hard threshold ratio (default 0.92). Host auto-fires compact at/above. */
  readonly hardThreshold?: number
  /** Maximum nested `agent` tool depth. Host default is 3. */
  readonly maxAgentDepth?: number
  /**
   * Extended-thinking budget in tokens (Anthropic-only). When set to a
   * positive integer, the adapter requests the model's private reasoning
   * blocks up to this many tokens. Undefined = extended thinking off.
   * Ignored by non-Anthropic adapters.
   */
  readonly thinkingBudget?: number
}

export const DEFAULT_SOFT_THRESHOLD = 0.75
export const DEFAULT_HARD_THRESHOLD = 0.92

// ============================================================================
// State
// ============================================================================

export type AgentStatus =
  | 'idle'              // waiting for user input
  | 'thinking'          // LLM call in flight
  | 'awaiting_approval' // one or more tool calls need user approval
  | 'executing_tools'   // tool calls dispatched, waiting for results
  | 'done'              // agent finished this turn
  | 'error'

export type PendingToolCall = {
  callId: string
  name: string
  input: Record<string, unknown>
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'dispatched'
}

export type UsageTotal = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TodoPriority = 'high' | 'medium' | 'low'

export type TodoItem = {
  readonly content: string
  readonly status: TodoStatus
  readonly priority?: TodoPriority
}

export const TODOWRITE_TOOL_NAME = 'todowrite'
export const MEMORY_WRITE_TOOL_NAME = 'memory_write'
export const MEMORY_DELETE_TOOL_NAME = 'memory_delete'

/**
 * Session-scoped notepad the agent maintains for itself across turns of the
 * current conversation. Written via the `memory_write` executor tool with
 * `scope: 'session'`; the reducer intercepts the tool_result and lifts the
 * (key, content) into this map so future turns see it inlined in state
 * without re-hitting IO. Workspace- and global-scope memory live on disk
 * (executor writes them, dashboard fetches them lazily) and never touch
 * kernel state.
 */
export type MemoryEntry = {
  readonly key: string
  readonly content: string
  readonly updatedAt: string  // ISO-8601, provider-supplied via tool input
}

export type ContextPressureLevel = 'none' | 'soft' | 'hard'

/**
 * Session-wide approval policy. Mid-turn changes take effect on the NEXT
 * tool call the LLM emits  -  pending calls that already went through the
 * approval branch keep their prior status until the user resolves them.
 *
 *   - 'auto' (default): honour `tool.requiresApproval`; safe tools dispatch,
 *     unsafe tools ask.
 *   - 'ask': every call needs approval, even `requiresApproval:false`.
 *   - 'deny': every approval-requiring call is auto-rejected; safe tools
 *     still dispatch. Useful for headless replays / demos.
 *   - 'allow_all': bypass approval for every call, even `requiresApproval:
 *     true`. Guard-railed at the host: config path only, never network.
 */
export type ApprovalMode = 'auto' | 'ask' | 'deny' | 'allow_all'

export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'auto'

export type AgentState = {
  readonly sessionId: string
  readonly messages: readonly Message[]
  readonly pendingCalls: readonly PendingToolCall[]
  readonly status: AgentStatus
  readonly usage: UsageTotal
  readonly cursor: number // monotonic event counter, for replay positioning
  readonly todos: readonly TodoItem[]
  readonly memory: readonly MemoryEntry[]
  readonly cwd?: string
  /**
   * Derived on every step from `usage.inputTokens / config.contextLimit`.
   * `'none'` when contextLimit is unset or well below soft threshold. The
   * host uses `'hard'` as the trigger for auto-compact.
   */
  readonly contextPressureLevel: ContextPressureLevel
  /**
   * Current approval policy. Defaults to `'auto'`; updated in place by
   * the `approval_mode_changed` event.
   */
  readonly approvalMode: ApprovalMode
  readonly error?: string
}

// ============================================================================
// Events (inputs to the reducer)
// ============================================================================

export type UserMessageEvent = {
  kind: 'user_message'
  text?: string
  content?: readonly MessageContent[]
}

export type UsageDelta = {
  inputTokens: number
  outputTokens: number
  costUsd?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

export type LlmResponseEvent = {
  kind: 'llm_response'
  message: Message // must have role === 'assistant'
  usage?: UsageDelta
}

export type LlmErrorEvent = {
  kind: 'llm_error'
  error: string
}

export type UserApproveEvent = {
  kind: 'user_approve'
  callId: string
}

export type UserRejectEvent = {
  kind: 'user_reject'
  callId: string
  reason?: string
}

export type ToolResultEvent = {
  kind: 'tool_result'
  callId: string
  ok: boolean
  content: string
}

export type CancelEvent = {
  kind: 'cancel'
}

/**
 * Replace state.messages with a single summary. Emitted either by the user
 * (manual `/compact`) or by the host when `contextPressureLevel === 'hard'`.
 * The reducer keeps the initial system prompt (index 0 if role === 'system')
 * and replaces the rest with one `system` message carrying the summary.
 * `usage.inputTokens` is reset to `tokensAfter`; `outputTokens`/`costUsd` are
 * unchanged so cumulative spend stays accurate.
 */
export type CompactReplacedEvent = {
  kind: 'compact_replaced'
  trigger?: 'manual' | 'auto'
  request?: {
    model?: string
    systemPrompt: string
    messages: readonly Message[]
    tools: readonly ToolSchema[]
  }
  responseUsage?: UsageDelta
  summary: string
  replacedCount: number
  tokensBefore: number
  tokensAfter: number
}

/**
 * Mid-session approval policy change. State-only; produces no effects.
 * Applies to any tool call emitted after this event.
 */
export type ApprovalModeChangedEvent = {
  kind: 'approval_mode_changed'
  mode: ApprovalMode
}

export type CwdChangedEvent = {
  kind: 'cwd_changed'
  cwd: string
}

export type AgentEvent =
  | UserMessageEvent
  | LlmResponseEvent
  | LlmErrorEvent
  | UserApproveEvent
  | UserRejectEvent
  | ToolResultEvent
  | CancelEvent
  | CompactReplacedEvent
  | ApprovalModeChangedEvent
  | CwdChangedEvent

// ============================================================================
// Effects (outputs from the reducer; host performs the actual IO)
// ============================================================================

export type CallLlmEffect = {
  kind: 'call_llm'
  messages: readonly Message[]
  tools: readonly ToolSchema[]
}

export type CallToolEffect = {
  kind: 'call_tool'
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string
}

export type RequestApprovalEffect = {
  kind: 'request_approval'
  callId: string
  name: string
  input: Record<string, unknown>
}

export type FinishEffect = {
  kind: 'finish'
}

export type EmitErrorEffect = {
  kind: 'emit_error'
  error: string
}

export type Effect =
  | CallLlmEffect
  | CallToolEffect
  | RequestApprovalEffect
  | FinishEffect
  | EmitErrorEffect

// ============================================================================
// StepResult
// ============================================================================

export type StepResult = {
  next: AgentState
  effects: readonly Effect[]
}

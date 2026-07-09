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
 * Model reasoning block — the model's private chain-of-thought that
 * produced the visible answer. Every major provider now surfaces some
 * variant of this: Anthropic's extended thinking, OpenAI's o1 reasoning
 * traces, Gemini's thoughts. Adapters normalize their provider-specific
 * shape into this envelope so the kernel and dashboard stay agnostic.
 *
 * Preserved in the message log because some provider APIs (notably
 * Anthropic) require echoing it back on the next turn for tool-use flows;
 * the kernel treats it as opaque and simply round-trips whatever the
 * adapter attached.
 *
 * `signature` is a provider-generated opaque token some APIs demand on
 * the next turn to prove the block came from them. `provider` is a soft
 * hint for the dashboard's rendering (e.g. show an Anthropic badge); it
 * MUST NOT be interpreted by the kernel.
 *
 * The wire discriminator stays `type: 'thinking'` for JSONL-log backward
 * compatibility — every existing log line already carries that literal.
 */
export type ReasoningContent = {
  type: 'thinking'
  text: string
  signature?: string
  provider?: string
}

/**
 * @deprecated Use {@link ReasoningContent}. Kept as an alias so existing
 * imports keep working through the rename.
 */
export type ThinkingContent = ReasoningContent

export type MessageContent =
  | TextContent
  | ToolCallContent
  | ToolResultContent
  | ImageContent
  | ReasoningContent

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
   * Maximum concurrent sibling sub-agents under a single parent. Host default
   * is 4. The host loop dispatches effects serially per session, so this cap
   * is a safety net for future schedulers or for cross-parent chained
   * delegation.
   */
  readonly maxAgentFanOut?: number
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
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
}

export const MEMORY_TOOL_NAME = 'memory'

/**
 * @deprecated Kernel no longer lifts memory entries into state. Kept for
 * consumers that still import the name; will be removed in a follow-up.
 * The `memory` tool executes entirely inside the executor; a session-scope
 * write echoes its (key, content) back through the normal tool_result and
 * dashboards derive their view from the timeline via a shadow-state
 * consumer on the host side.
 */
export type MemoryEntry = {
  readonly key: string
  readonly content: string
  readonly updatedAt: string
}

export type ContextPressureLevel = 'none' | 'soft' | 'hard'

/**
 * Session-wide approval policy. Mid-turn changes take effect on the NEXT
 * tool call the LLM emits — pending calls that already went through the
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

export type ClearEvent = {
  kind: 'clear'
}

/**
 * Replace an old prefix of state.messages with a single summary. Emitted either
 * by the user (manual `/compact`), by the host after a turn reaches the hard
 * tier, or by the host immediately before an oversized provider request.
 * `preserveFrom` is a message index chosen by the host; messages at or after
 * that index are kept verbatim so the most recent user turn and tool-call chain
 * survive compaction. Use `messages.length` when no tail should be preserved.
 */
export type CompactTrigger = 'manual' | 'auto' | 'preflight' | 'tool_result'

export type CompactReplacedEvent = {
  kind: 'compact_replaced'
  trigger?: CompactTrigger
  /**
   * Host-generated correlation id so `compact_skipped` / `compact_rejected`
   * for the same attempt can be linked back to the request that produced them.
   */
  attemptId?: string
  preserveFrom: number
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
 * A compaction attempt the host declined to make or that failed at the
 * summarizer boundary before any `compact_replaced` could be dispatched.
 * Never mutates messages. See `docs/host/context-compaction.md` for
 * the reason-code taxonomy.
 */
export type CompactSkippedEvent = {
  kind: 'compact_skipped'
  trigger: CompactTrigger
  attemptId: string
  reason:
    | 'circuit_breaker_open'
    | 'back_off_same_batch'
    | 'summarizer_failed'
    | 'empty_summary'
    | 'no_compactable_content'
    | 'session_busy'
  errorMessage?: string
}

/**
 * Reducer refused to apply a `compact_replaced` because the proposed pivot
 * violated protocol invariants (would orphan a pending tool_result, or the
 * preserveFrom is outside the legal range). Emitted by the host after it
 * observes the reducer noop, so the failure is visible in the ledger.
 */
export type CompactRejectedEvent = {
  kind: 'compact_rejected'
  attemptId: string
  reason: 'pending_call_orphaned' | 'invalid_preserve_from'
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
  | ClearEvent
  | CompactReplacedEvent
  | CompactSkippedEvent
  | CompactRejectedEvent
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

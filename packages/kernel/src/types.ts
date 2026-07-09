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

export type MessageContent = TextContent | ToolCallContent | ToolResultContent

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
}

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
}

export type AgentState = {
  readonly sessionId: string
  readonly messages: readonly Message[]
  readonly pendingCalls: readonly PendingToolCall[]
  readonly status: AgentStatus
  readonly usage: UsageTotal
  readonly cursor: number // monotonic event counter, for replay positioning
  readonly error?: string
}

// ============================================================================
// Events (inputs to the reducer)
// ============================================================================

export type UserMessageEvent = {
  kind: 'user_message'
  text: string
}

export type UsageDelta = {
  inputTokens: number
  outputTokens: number
  costUsd?: number
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

export type AgentEvent =
  | UserMessageEvent
  | LlmResponseEvent
  | LlmErrorEvent
  | UserApproveEvent
  | UserRejectEvent
  | ToolResultEvent
  | CancelEvent

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

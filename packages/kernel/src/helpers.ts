/**
 * Small pure helpers shared by the FSM handlers.
 *
 * These are the primitives that show up in more than one handler cell:
 *   - `noop`                 —— no-state-change result
 *   - `extractToolCalls`     —— filter tool_call content blocks
 *   - `addUsage`             —— accumulate token counts
 *   - `afterPendingSettled`  —— decide next status after a call finishes
 *
 * Everything is pure: no IO, no time source. Keeping them together makes the
 * `step()` / handler files scan smaller.
 */

import type {
  AgentConfig,
  AgentState,
  Message,
  MessageContent,
  PendingToolCall,
  HandlerResult,
  ToolCallContent,
  UsageDelta,
  UsageTotal,
} from './types.js'
import { transitionAgentState } from './state.js'

export function noop(state: AgentState): HandlerResult {
  return { next: state, effects: [] }
}

export function rejectInvalidEvent(state: AgentState): HandlerResult {
  return { next: state, effects: [], rejectionReason: 'invalid_event_payload' }
}

export function extractToolCalls(
  content: readonly MessageContent[],
): ToolCallContent[] {
  return content.filter((c): c is ToolCallContent => c.type === 'tool_call')
}

export function addUsage(total: UsageTotal, delta: UsageDelta): UsageTotal {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    cacheCreationTokens:
      (total.cacheCreationTokens ?? 0) + (delta.cacheCreationTokens ?? 0),
    cacheReadTokens:
      (total.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
  }
}

export function afterPendingSettled(
  state: AgentState,
  messages: readonly Message[],
  pendingCalls: readonly PendingToolCall[],
  config: AgentConfig,
): HandlerResult {
  if (pendingCalls.length > 0) {
    const stillAwaiting = pendingCalls.some((c) => c.status === 'awaiting_approval')
    return {
      next: transitionAgentState(
        state,
        { status: stillAwaiting ? 'awaiting_approval' : 'executing_tools', pendingCalls },
        { messages },
      ),
      effects: [],
    }
  }
  const next = transitionAgentState(
    state,
    { status: 'thinking', pendingCalls: [] },
    { messages },
  )
  return {
    next,
    effects: [{ kind: 'call_llm', messages: next.messages, tools: config.tools }],
  }
}

export function estimateMessageTokens(messages: readonly Message[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.role.length + 8
    for (const content of message.content) {
      if (content.type === 'text' || content.type === 'thinking') {
        chars += content.text.length
      } else if (content.type === 'tool_call') {
        const legacy = content as typeof content & { id?: unknown; arguments?: unknown }
        const callId = typeof content.callId === 'string'
          ? content.callId
          : typeof legacy.id === 'string'
            ? legacy.id
            : ''
        const input = content.input ?? legacy.arguments ?? {}
        chars += content.name.length + callId.length + JSON.stringify(input).length
      } else if (content.type === 'tool_result') {
        chars += (content.callId ?? '').length + content.content.length + 16
      } else if (content.type === 'file') {
        chars += content.name.length + content.mediaType.length + Math.round(content.data.length / 4)
      } else {
        chars += content.source.kind === 'file_ref'
          ? content.source.path.length + 64
          : Math.round(content.source.data.length / 4)
      }
    }
  }
  return Math.ceil(chars / 4)
}

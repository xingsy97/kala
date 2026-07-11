/**
 * Small pure helpers shared by the FSM handlers.
 *
 * These are the primitives that show up in more than one handler cell:
 *   - `noop`                 —— no-state-change result
 *   - `extractToolCalls`     —— filter tool_call content blocks
 *   - `addUsage`             —— accumulate token counts
 *   - `afterPendingSettled`  —— decide next status after a call finishes
 *   - `withPressure`         —— attach the derived context-pressure level
 *
 * Everything is pure: no IO, no time source. Keeping them together makes the
 * `step()` / handler files scan smaller.
 */

import type {
  AgentConfig,
  AgentState,
  ContextPressureLevel,
  Message,
  MessageContent,
  PendingToolCall,
  StepResult,
  ToolCallContent,
  UsageDelta,
  UsageTotal,
} from './types.js'
import { DEFAULT_HARD_THRESHOLD, DEFAULT_SOFT_THRESHOLD } from './types.js'

export function noop(state: AgentState): StepResult {
  return { next: state, effects: [] }
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
): StepResult {
  if (pendingCalls.length > 0) {
    const stillAwaiting = pendingCalls.some((c) => c.status === 'awaiting_approval')
    return {
      next: {
        ...state,
        messages,
        pendingCalls,
        status: stillAwaiting ? 'awaiting_approval' : 'executing_tools',
      },
      effects: [],
    }
  }
  const next: AgentState = {
    ...state,
    messages,
    pendingCalls: [],
    status: 'thinking',
  }
  return {
    next,
    effects: [{ kind: 'call_llm', messages: next.messages, tools: config.tools }],
  }
}

export function withPressure(state: AgentState, config: AgentConfig): AgentState {
  const contextTokens = estimateMessageTokens(state.messages)
  const level = derivePressure(contextTokens, config)
  if (level === state.contextPressureLevel && contextTokens === state.contextTokens) return state
  return { ...state, contextTokens, contextPressureLevel: level }
}

function derivePressure(
  inputTokens: number,
  config: AgentConfig,
): ContextPressureLevel {
  if (!config.contextLimit || config.contextLimit <= 0) return 'none'
  const ratio = inputTokens / config.contextLimit
  const hard = config.hardThreshold ?? DEFAULT_HARD_THRESHOLD
  const soft = config.softThreshold ?? DEFAULT_SOFT_THRESHOLD
  if (ratio >= hard) return 'hard'
  if (ratio >= soft) return 'soft'
  return 'none'
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
      } else {
        chars += content.source.kind === 'file_ref'
          ? content.source.path.length + 64
          : Math.round(content.source.data.length / 4)
      }
    }
  }
  return Math.ceil(chars / 4)
}

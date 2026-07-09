import type { AgentConfig, AgentState, Message, ToolSchema } from './types.js'
import { DEFAULT_APPROVAL_MODE } from './types.js'

export function createInitialState(params: {
  sessionId: string
  systemPrompt?: string
}): AgentState {
  const messages: Message[] = params.systemPrompt
    ? [{ role: 'system', content: [{ type: 'text', text: params.systemPrompt }] }]
    : []
  return {
    sessionId: params.sessionId,
    messages,
    pendingCalls: [],
    status: 'idle',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    cursor: 0,
    todos: [],
    memory: [],
    contextPressureLevel: 'none',
    approvalMode: DEFAULT_APPROVAL_MODE,
  }
}

export function createConfig(params: {
  tools: readonly ToolSchema[]
  systemPrompt?: string
  contextLimit?: number
  softThreshold?: number
  hardThreshold?: number
  maxAgentDepth?: number
}): AgentConfig {
  return {
    tools: params.tools,
    systemPrompt: params.systemPrompt,
    ...(params.contextLimit !== undefined
      ? { contextLimit: params.contextLimit }
      : {}),
    ...(params.softThreshold !== undefined
      ? { softThreshold: params.softThreshold }
      : {}),
    ...(params.hardThreshold !== undefined
      ? { hardThreshold: params.hardThreshold }
      : {}),
    ...(params.maxAgentDepth !== undefined
      ? { maxAgentDepth: params.maxAgentDepth }
      : {}),
  }
}

export function isTerminal(state: AgentState): boolean {
  return state.status === 'done' || state.status === 'error'
}

export function hasPendingApproval(state: AgentState): boolean {
  return state.pendingCalls.some((c) => c.status === 'awaiting_approval')
}

export function hasPendingExecution(state: AgentState): boolean {
  return state.pendingCalls.some(
    (c) => c.status === 'approved' || c.status === 'dispatched',
  )
}

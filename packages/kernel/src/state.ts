import type { AgentConfig, AgentModuleMetadata, AgentState, AgentStateCommon, AgentStatePhase, Message, ToolSchema } from './types.js'
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
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    cursor: 0,
    approvalMode: DEFAULT_APPROVAL_MODE,
  }
}

export function transitionAgentState(
  state: AgentState,
  phase: AgentStatePhase,
  patch: Partial<AgentStateCommon> = {},
): AgentState {
  const { status: _status, pendingCalls: _pendingCalls, error: _error, ...common } = state
  return { ...common, ...patch, ...phase }
}

export function createConfig(params: {
  tools: readonly ToolSchema[]
  systemPrompt?: string
  agentModule?: AgentModuleMetadata
  contextLimit?: number
  softThreshold?: number
  hardThreshold?: number
  maxAgentDepth?: number
  maxAgentFanOut?: number
}): AgentConfig {
  return {
    tools: params.tools,
    systemPrompt: params.systemPrompt,
    ...(params.agentModule !== undefined
      ? { agentModule: params.agentModule }
      : {}),
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
    ...(params.maxAgentFanOut !== undefined
      ? { maxAgentFanOut: params.maxAgentFanOut }
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

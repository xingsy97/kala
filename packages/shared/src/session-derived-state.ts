import type { AgentState, PendingToolCall } from '@agent-kernel/kernel'

export type SessionActivity = 'idle' | 'thinking' | 'tooling' | 'waiting_user' | 'done' | 'failed'

export type SessionDerivedState = {
  activity: SessionActivity
  isRunning: boolean
  isWaitingForUser: boolean
  canAcceptUserMessage: boolean
  canResumeTurn: boolean
  shouldShowThinkingIndicator: boolean
  shouldShowToolIndicator: boolean
  restartResumeAction: 'none' | 'continue_turn' | 'wait_for_approval'
}

export type DeriveSessionStateInput = {
  status?: AgentState['status'] | 'loading'
  pendingCalls?: readonly Pick<PendingToolCall, 'status'>[]
  streamingActive?: boolean
  awaitingAck?: boolean
  compactRunning?: boolean
  lastError?: string | null
}

export function deriveSessionState(input: DeriveSessionStateInput): SessionDerivedState {
  if (input.lastError || input.status === 'error') return failedState
  if (input.awaitingAck || input.streamingActive || input.compactRunning || input.status === 'loading') return loadingState
  const pendingCalls = input.pendingCalls ?? []
  const awaitingApproval = pendingCalls.some((call) => call.status === 'awaiting_approval')
  if (input.status === 'awaiting_approval' || awaitingApproval) return waitingUserState
  if (input.status === 'executing_tools') return toolingState
  if (input.status === 'thinking') return thinkingState
  if (input.status === 'done') return doneState
  return idleState
}

export function isSessionRunning(input: DeriveSessionStateInput): boolean {
  return deriveSessionState(input).isRunning
}

export function isSessionResting(input: DeriveSessionStateInput): boolean {
  const derived = deriveSessionState(input)
  return !derived.isRunning && !derived.isWaitingForUser
}

const idleState: SessionDerivedState = {
  activity: 'idle',
  isRunning: false,
  isWaitingForUser: false,
  canAcceptUserMessage: true,
  canResumeTurn: false,
  shouldShowThinkingIndicator: false,
  shouldShowToolIndicator: false,
  restartResumeAction: 'none',
}

const loadingState: SessionDerivedState = {
  activity: 'thinking',
  isRunning: true,
  isWaitingForUser: false,
  canAcceptUserMessage: false,
  canResumeTurn: true,
  shouldShowThinkingIndicator: true,
  shouldShowToolIndicator: false,
  restartResumeAction: 'continue_turn',
}

const thinkingState: SessionDerivedState = loadingState

const toolingState: SessionDerivedState = {
  activity: 'tooling',
  isRunning: true,
  isWaitingForUser: false,
  canAcceptUserMessage: false,
  canResumeTurn: true,
  shouldShowThinkingIndicator: false,
  shouldShowToolIndicator: true,
  restartResumeAction: 'continue_turn',
}

const waitingUserState: SessionDerivedState = {
  activity: 'waiting_user',
  isRunning: false,
  isWaitingForUser: true,
  canAcceptUserMessage: false,
  canResumeTurn: false,
  shouldShowThinkingIndicator: false,
  shouldShowToolIndicator: false,
  restartResumeAction: 'wait_for_approval',
}

const doneState: SessionDerivedState = {
  activity: 'done',
  isRunning: false,
  isWaitingForUser: false,
  canAcceptUserMessage: true,
  canResumeTurn: false,
  shouldShowThinkingIndicator: false,
  shouldShowToolIndicator: false,
  restartResumeAction: 'none',
}

const failedState: SessionDerivedState = {
  activity: 'failed',
  isRunning: false,
  isWaitingForUser: false,
  canAcceptUserMessage: true,
  canResumeTurn: false,
  shouldShowThinkingIndicator: false,
  shouldShowToolIndicator: false,
  restartResumeAction: 'none',
}

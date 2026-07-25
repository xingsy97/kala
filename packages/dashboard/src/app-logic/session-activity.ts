import type { AgentState } from '@agent-kernel/kernel'
import { deriveSessionState, isSessionRunning } from '@agent-kernel/shared'

import type { SessionActivityStatus } from '../features/explorer/Explorer.js'

/**
 * Pure derivations of a session's coarse activity status for the status
 * indicators + composer gating. Extracted from app.tsx for unit testing.
 */

export function sessionActivityStatus({
  status,
  streamingActive,
  awaitingAck,
  compactRunning,
}: {
  status: AgentState['status'] | undefined
  streamingActive: boolean
  awaitingAck: boolean
  compactRunning: boolean
}): SessionActivityStatus | undefined {
  if (awaitingAck || streamingActive || compactRunning) return 'loading'
  if (!status) return undefined
  return status
}

export function isRunningSessionActivity(status: SessionActivityStatus | undefined): boolean {
  return isSessionRunning({ status })
}

export function coarseStatusForIndicator(status: SessionActivityStatus | undefined): SessionActivityStatus | undefined {
  if (status === undefined) return undefined
  return isRunningSessionActivity(status) ? 'loading' : status
}

export function isWaitingForUserInput({
  status,
  streamingActive,
  awaitingAck,
  pendingApprovalsCount,
}: {
  status: AgentState['status'] | undefined
  streamingActive: boolean
  awaitingAck: boolean
  pendingApprovalsCount: number
}): boolean {
  if (awaitingAck || streamingActive || pendingApprovalsCount > 0) return false
  return deriveSessionState({ status }).canAcceptUserMessage
}

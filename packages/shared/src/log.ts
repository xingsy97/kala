/**
 * JSONL event log entry types. See `docs/protocol/event-log.md`.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'

export type LogEntryKind = 'header' | 'event' | 'snapshot'

export type HeaderEntry = {
  kind: 'header'
  seq: 0
  ts: string
  sessionId: string
  parentSessionId?: string
  parentCursor?: number
  /**
   * Workspace this session is bound to — stable ULID minted by the
   * executor on first launch. Written once at create time and never
   * rewritten. Host routes tool calls to any executor announcing a
   * matching workspaceId. Legacy logs predating this field have it
   * undefined and are treated as unassigned.
   */
  workspaceId?: string
  /**
   * Display label captured at create time. Not authoritative — the live
   * executor's `workspaceName` in its announce is what the dashboard
   * shows when an executor is online. Persisted here so offline
   * workspaces still render with something more useful than a bare ULID.
   */
  workspaceName?: string
  formatVersion: 1
  kernelVersion: string
  config: AgentConfig
  initialState: AgentState
}

export type EventEntry = {
  kind: 'event'
  seq: number
  ts: string
  event: AgentEvent
  effects: readonly Effect[]
  usage?: UsageTotal
}

export type SnapshotEntry = {
  kind: 'snapshot'
  seq: number
  ts: string
  state: AgentState
}

export type LogEntry = HeaderEntry | EventEntry | SnapshotEntry

export const LOG_FORMAT_VERSION = 1 as const

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

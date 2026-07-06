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

export type LogEntryKind = 'header' | 'event' | 'snapshot' | 'metadata'

export type HeaderEntry = {
  kind: 'header'
  seq: 0
  ts: string
  sessionId: string
  parentSessionId?: string
  parentCursor?: number
  /**
   * Workspace this session is bound to  -  stable ULID minted by the
   * executor on first launch. Written once at create time and never
   * rewritten. Host routes tool calls to any executor announcing a
   * matching workspaceId. Legacy logs predating this field have it
   * undefined and are treated as unassigned.
   */
  workspaceId?: string
  /**
   * Display label captured at create time. Not authoritative  -  the live
   * executor's `workspaceName` in its announce is what the dashboard
   * shows when an executor is online. Persisted here so offline
   * workspaces still render with something more useful than a bare ULID.
   */
  workspaceName?: string
  initialCwd?: string
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
  llmTrace?: LLMTrace
}

export type LLMTrace = {
  provider: 'anthropic' | 'openai' | 'unknown'
  model: string
  request: {
    url: string
    headers: Record<string, string>
    body: unknown
  }
  response?: {
    status: number
    body?: unknown
    streamEventTypes?: readonly string[]
  }
}

export type SnapshotEntry = {
  kind: 'snapshot'
  seq: number
  ts: string
  state: AgentState
}

/**
 * Out-of-band metadata mutation. Currently only session label. Kept out of
 * the kernel event stream because label has no effect on state transitions  - 
 * folding it in would force every reducer test to reason about a field that
 * exists only for display. Append-only: reading picks the most recent entry.
 */
export type MetadataEntry = {
  kind: 'metadata'
  ts: string
  label?: string
}

export type LogEntry = HeaderEntry | EventEntry | SnapshotEntry | MetadataEntry

export const LOG_FORMAT_VERSION = 1 as const

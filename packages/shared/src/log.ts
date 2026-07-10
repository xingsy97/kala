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
  /**
   * Model that answered this event, when the event was produced by an LLM
   * call (`llm_response` / `llm_error`). Recorded independently of `llmTrace`
   * so the Inspector can display the model even when the provider trace body
   * was suppressed or an older adapter didn't capture one.
   */
  model?: string
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
    metrics?: {
      durationMs?: number
      timeToFirstChunkMs?: number
    }
  }
  /**
   * Provider- or gateway-issued request id, when the response carried one.
   * Anthropic returns `request-id`; OpenAI returns `x-request-id`; local
   * gateways may inject their own id. Recording it lets us cross-link a
   * session event with provider-side traces, and lets RL rollout capture
   * artifacts reference the exact generation call.
   */
  gatewayRequestId?: string
  /**
   * Serving-side model weight version. Hosted providers rarely expose this;
   * a local SGLang/vLLM gateway or an adapter with policy metadata may set
   * it. Written when known so RL rollouts and A/B evals can pin generations
   * to a specific policy checkpoint.
   */
  weightVersion?: string
}

export type SnapshotEntry = {
  kind: 'snapshot'
  seq: number
  ts: string
  state: AgentState
}

/**
 * Out-of-band metadata mutation. Kept out of the kernel event stream because
 * these fields do not affect reducer transitions. Append-only: reading picks
 * the most recent entry for each field.
 */
export type MetadataEntry = {
  kind: 'metadata'
  ts: string
  label?: string
  workspaceId?: string
  workspaceName?: string
}

export type LogEntry = HeaderEntry | EventEntry | SnapshotEntry | MetadataEntry

export const LOG_FORMAT_VERSION = 1 as const

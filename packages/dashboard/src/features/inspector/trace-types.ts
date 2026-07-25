/** Shared inspector value types (kept separate to avoid component-module cycles). */
import type { AgentEvent, CallLlmEffect } from '@agent-kernel/kernel'
import type { LlmCall } from '../chat/context-composition.js'
import type { TimelineEntry } from '../../session.js'
import type { StateFlowStep } from '../../state-flow.js'

export type TraceCategory = 'user' | 'llm' | 'tool' | 'approval' | 'system'

export type StatusTopologyNode = {
  id: string
  label: string
  value: string
  status: 'ok' | 'warn' | 'error' | 'unknown'
}


export const TRACE_CATEGORY_ORDER = ['user', 'llm', 'tool', 'approval', 'system'] as const

export type ToolCallLifecycle = {
  callId: string
  name: string
  input: Record<string, unknown>
  requestedSeq?: number
  approvedSeq?: number
  rejectedSeq?: number
  dispatchedSeq?: number
  resultSeq?: number
  result?: Extract<AgentEvent, { kind: 'tool_result' }>
}


export type PriorCallLlm = { seq: number; effect: CallLlmEffect }

export type DetailSelection =
  | { kind: 'event'; entry: TimelineEntry; priorCallLlm: PriorCallLlm | null; flow?: StateFlowStep }
  | { kind: 'llm'; call: LlmCall }
  | { kind: 'tool'; call: ToolCallLifecycle }
  | null

export type SubAgentRelationSummary = {
  parentSessionId: string | null
  parentCursor: number | null
  total: number
  completed: number
  failed: number
  running: number
}


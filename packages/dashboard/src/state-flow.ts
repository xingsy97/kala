import type { AgentStatus, Effect } from '@agent-kernel/kernel'

import type { TimelineEntry } from './session.js'

export type StateFlowStep = {
  seq: number
  eventKind: string
  from: AgentStatus
  to: AgentStatus
  effects: readonly Effect[]
}

export function stateFlow(timeline: readonly TimelineEntry[]): readonly StateFlowStep[] {
  let status: AgentStatus = 'idle'
  return timeline.map((entry) => {
    const from = status
    const to = nextStatus(from, entry)
    status = to
    return {
      seq: entry.seq,
      eventKind: entry.event.kind,
      from,
      to,
      effects: entry.effects,
    }
  })
}

function nextStatus(from: AgentStatus, entry: TimelineEntry): AgentStatus {
  const event = entry.event
  if (event.kind === 'llm_error') return 'error'
  if (event.kind === 'clear') return 'idle'
  if (event.kind === 'cancel') return 'done'
  if (event.kind === 'messages_replaced') return from === 'error' ? 'error' : 'done'
  if (entry.effects.some((e) => e.kind === 'request_approval')) return 'awaiting_approval'
  if (entry.effects.some((e) => e.kind === 'call_tool')) return 'executing_tools'
  if (entry.effects.some((e) => e.kind === 'call_llm')) return 'thinking'
  if (entry.effects.some((e) => e.kind === 'emit_error')) return 'error'
  if (entry.effects.some((e) => e.kind === 'finish')) return 'done'
  if (event.kind === 'approval_mode_changed' || event.kind === 'cwd_changed') return from
  return from
}

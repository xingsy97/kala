import type { Message } from '@agent-kernel/kernel'
import type { TimelineEntry } from '../../session.js'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TaskPriority = 'high' | 'medium' | 'low'

export type TaskItem = {
  readonly content: string
  readonly status: TaskStatus
  readonly priority?: TaskPriority
}

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']
const PRIORITIES: readonly TaskPriority[] = ['high', 'medium', 'low']

/** Legacy/history compatibility for sessions that recorded todowrite before its retirement. */
export function tasksFromTimeline(timeline: readonly TimelineEntry[]): readonly TaskItem[] {
  const inputsByCallId = new Map<string, Record<string, unknown>>()
  let current: readonly TaskItem[] = []

  for (const entry of timeline) {
    for (const effect of entry.effects) {
      if (effect.kind === 'call_tool' && effect.name === 'todowrite') {
        inputsByCallId.set(effect.callId, effect.input)
      }
    }
    const event = entry.event
    if (event.kind !== 'tool_result' || !event.ok) continue
    const input = inputsByCallId.get(event.callId)
    if (!input) continue
    current = parseTasksFromInput(input, current)
  }

  return current
}

export function tasksFromMessages(
  messages: readonly Message[],
  fallback: readonly TaskItem[] = [],
): readonly TaskItem[] {
  const inputsByCallId = new Map<string, Record<string, unknown>>()
  let current = fallback
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call' && content.name === 'todowrite') {
        inputsByCallId.set(content.callId, content.input)
      }
      if (content.type !== 'tool_result' || !content.ok) continue
      const input = inputsByCallId.get(content.callId)
      if (input) current = parseTasksFromInput(input, current)
    }
  }
  return current
}

export function parseTasksFromInput(
  input: Record<string, unknown>,
  fallback: readonly TaskItem[] = [],
): readonly TaskItem[] {
  const raw = (input as { todos?: unknown }).todos
  if (!Array.isArray(raw)) return fallback
  const out: TaskItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const content = typeof rec.content === 'string' && rec.content.length > 0 ? rec.content : null
    const status = typeof rec.status === 'string' && (STATUSES as readonly string[]).includes(rec.status)
      ? rec.status as TaskStatus
      : null
    if (!content || !status) continue
    const priority = typeof rec.priority === 'string' && (PRIORITIES as readonly string[]).includes(rec.priority)
      ? rec.priority as TaskPriority
      : undefined
    out.push(priority ? { content, status, priority } : { content, status })
  }
  return out
}

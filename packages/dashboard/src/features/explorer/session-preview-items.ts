import type { AgentState, Message } from '@agent-kernel/kernel'
import type { TimelineEntry } from '../../session.js'

const GOAL_LIMIT = 220
const RESPONSE_LIMIT = 280
const ACTIVITY_LIMIT = 220
const TIMELINE_LIMIT = 48

export type SessionPreviewSummary = {
  activity: {
    label: 'Needs attention' | 'Working' | 'Completed' | 'Idle' | 'Stopped'
    text: string
    tone: 'attention' | 'active' | 'success' | 'muted' | 'danger'
  }
  goal: string | null
  response: string | null
  stats: {
    toolCalls: number
    failedTools: number
    omittedContent: number
    queuedMessages: number
  }
}

export function projectSessionPreviewSummary({
  messages,
  timeline,
  state,
  queuedMessages = 0,
}: {
  messages: readonly Message[]
  timeline: readonly TimelineEntry[]
  state: AgentState
  queuedMessages?: number
}): SessionPreviewSummary {
  const source = previewMessages(messages, timeline)
  let goal: string | null = null
  let response: string | null = null
  let omittedContent = 0
  let toolCalls = 0
  let failedTools = 0
  let latestIntent: string | null = null

  for (const message of source) {
    if (message.role === 'system') continue
    const readable: string[] = []
    for (const content of message.content) {
      if (content.type === 'tool_call') {
        toolCalls += 1
        const intent = cleanText(content.intent ?? '')
        if (intent) latestIntent = clip(intent, ACTIVITY_LIMIT)
        continue
      }
      if (content.type === 'tool_result') {
        if (!content.ok) failedTools += 1
        continue
      }
      if (content.type === 'thinking') continue
      if (content.type === 'image') {
        omittedContent += 1
        continue
      }
      if (content.type === 'text') {
        const extracted = extractReadableText(content.text)
        omittedContent += extracted.omitted
        if (extracted.text) readable.push(extracted.text)
      }
    }
    const text = cleanText(readable.join(' '))
    if (!text) continue
    if (message.role === 'user') goal = clip(text, GOAL_LIMIT)
    if (message.role === 'assistant') response = clip(text, RESPONSE_LIMIT)
  }

  const pendingIntents = state.pendingCalls
    .map((call) => cleanText(call.intent ?? ''))
    .filter(Boolean)
  const currentIntent = pendingIntents.at(-1) ?? latestIntent

  return {
    activity: activitySummary(state, currentIntent, queuedMessages, failedTools),
    goal,
    response,
    stats: { toolCalls, failedTools, omittedContent, queuedMessages },
  }
}

function previewMessages(stateMessages: readonly Message[], timeline: readonly TimelineEntry[]): readonly Message[] {
  if (timeline.length === 0) return stateMessages.slice(-24)
  const messages: Message[] = []
  for (const entry of timeline.slice(-TIMELINE_LIMIT)) {
    if (entry.event.kind === 'user_message') {
      messages.push({ role: 'user', content: [{ type: 'text', text: entry.event.text ?? '' }] })
    } else if (entry.event.kind === 'llm_response') {
      messages.push(entry.event.message)
    } else if (entry.event.kind === 'tool_result') {
      messages.push({ role: 'tool', content: [{ type: 'tool_result', callId: entry.event.callId, ok: entry.event.ok, content: '' }] })
    }
  }
  return messages.length > 0 ? messages : stateMessages.slice(-24)
}

function activitySummary(state: AgentState, intent: string | null, queued: number, failedTools: number): SessionPreviewSummary['activity'] {
  if (state.status === 'awaiting_approval' || state.pendingCalls.some((call) => call.status === 'awaiting_approval')) {
    return { label: 'Needs attention', text: intent ?? 'A tool request is waiting for approval.', tone: 'attention' }
  }
  if (state.status === 'executing_tools') {
    const count = state.pendingCalls.length
    return { label: 'Working', text: intent ?? `Running ${count || 1} tool ${count === 1 ? 'call' : 'calls'}.`, tone: 'active' }
  }
  if (state.status === 'thinking') {
    return { label: 'Working', text: 'Preparing the next response.', tone: 'active' }
  }
  if (state.status === 'error') {
    return { label: 'Stopped', text: 'The Session stopped with an error and may need attention.', tone: 'danger' }
  }
  if (queued > 0) {
    return { label: 'Working', text: `${queued} queued ${queued === 1 ? 'message' : 'messages'} waiting to run.`, tone: 'active' }
  }
  if (state.status === 'done') {
    return { label: failedTools > 0 ? 'Needs attention' : 'Completed', text: failedTools > 0 ? `${failedTools} tool ${failedTools === 1 ? 'call failed' : 'calls failed'} in the recent activity.` : 'The latest turn is complete.', tone: failedTools > 0 ? 'attention' : 'success' }
  }
  return { label: 'Idle', text: 'Ready for the next message.', tone: 'muted' }
}

function extractReadableText(source: string): { text: string; omitted: number } {
  let omitted = 0
  const withoutFences = source.replace(/```([^\n`]*)\n?[\s\S]*?```/g, () => {
    omitted += 1
    return ' '
  })
  const withoutImages = withoutFences.replace(/!\[[^\]]*\]\([^)]*\)/g, () => {
    omitted += 1
    return ' '
  })
  return { text: cleanText(withoutImages), omitted }
}

function cleanText(source: string): string {
  return source
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value
}

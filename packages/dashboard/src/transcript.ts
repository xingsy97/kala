import type { Message } from '@agent-kernel/kernel'

import type { TimelineEntry } from './session.js'

export function visibleMessages(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
): readonly Message[] {
  const out: Message[] = []
  const first = stateMessages[0]
  if (first?.role === 'system') out.push(first)

  for (const entry of timeline) {
    const event = entry.event
    if (event.kind === 'user_message') {
      out.push({
        role: 'user',
        content: event.content
          ? [...event.content]
          : [{ type: 'text', text: event.text ?? '' }],
      })
    } else if (event.kind === 'llm_response') {
      out.push(event.message)
    } else if (event.kind === 'tool_result') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            callId: event.callId,
            ok: event.ok,
            content: event.content,
          },
        ],
      })
    }
  }

  if (streamingText.length > 0) {
    out.push({
      role: 'assistant',
      content: [{ type: 'text', text: streamingText }],
    })
  }

  return timeline.length > 0 || streamingText.length > 0 ? out : stateMessages
}

import type { Message } from '@agent-kernel/kernel'

import type { TimelineEntry } from './session.js'

export type CompactBoundary = {
  kind: 'compact_boundary'
  seq: number
  trigger: 'manual' | 'auto' | 'unknown'
  replacedCount: number
  tokensBefore: number
  tokensAfter: number
  summary: string
}

export type TranscriptItem =
  | { kind: 'message'; message: Message }
  | CompactBoundary

export function visibleTranscript(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
): readonly TranscriptItem[] {
  const out: TranscriptItem[] = []
  const first = stateMessages[0]
  if (first?.role === 'system') out.push({ kind: 'message', message: first })

  for (const entry of timeline) {
    const event = entry.event
    if (event.kind === 'user_message') {
      out.push({
        kind: 'message',
        message: {
          role: 'user',
          content: event.content
            ? [...event.content]
            : [{ type: 'text', text: event.text ?? '' }],
        },
      })
    } else if (event.kind === 'llm_response') {
      out.push({ kind: 'message', message: event.message })
    } else if (event.kind === 'tool_result') {
      out.push({
        kind: 'message',
        message: {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              callId: event.callId,
              ok: event.ok,
              content: event.content,
            },
          ],
        },
      })
    } else if (event.kind === 'compact_replaced') {
      out.push({
        kind: 'compact_boundary',
        seq: entry.seq,
        trigger: event.trigger ?? 'unknown',
        replacedCount: event.replacedCount,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
        summary: event.summary,
      })
    }
  }

  if (streamingText.length > 0) {
    out.push({
      kind: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: streamingText }],
      },
    })
  }

  return timeline.length > 0 || streamingText.length > 0
    ? out
    : stateMessages.map((message) => ({ kind: 'message', message }))
}

export function visibleMessages(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
): readonly Message[] {
  return visibleTranscript(stateMessages, timeline, streamingText)
    .filter((item): item is { kind: 'message'; message: Message } => item.kind === 'message')
    .map((item) => item.message)
}

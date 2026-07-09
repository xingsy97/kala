import type { AgentStatus, Message, MessageContent } from '@agent-kernel/kernel'
import type { QueuedMessagePreview } from '@agent-kernel/shared'

import type { TimelineEntry } from './session.js'

export type CompactBoundary = {
  kind: 'compact_boundary'
  seq: number
  trigger: 'manual' | 'auto' | 'preflight' | 'tool_result' | 'unknown'
  replacedCount: number
  tokensBefore: number
  tokensAfter: number
  summary: string
}

export type TranscriptItem =
  | { kind: 'message'; message: Message; seq?: number }
  | {
      kind: 'pending_user_message'
      id: string
      text: string
      mode: 'steer' | 'queue'
      status: 'sending' | 'queued'
      content?: readonly MessageContent[]
      createdAt: string
      position?: number
    }
  | CompactBoundary

export type PendingUserTranscriptMessage = {
  id: string
  text: string
  mode: 'steer' | 'queue'
  content?: readonly MessageContent[]
  createdAt: string
  afterSeq?: number
}

export function reconcilePendingUserMessages(
  pendingUserMessages: readonly PendingUserTranscriptMessage[],
  timeline: readonly TimelineEntry[],
  queuedMessages: readonly QueuedMessagePreview[],
  status: AgentStatus | undefined,
  streamingText: string,
): readonly PendingUserTranscriptMessage[] {
  if (pendingUserMessages.length === 0) return pendingUserMessages
  const acked = new Map<string, number>()
  for (const entry of timeline) {
    if (entry.event.kind !== 'user_message') continue
    incrementPendingAck(acked, pendingMessageKey(entry.event.text ?? '', 'steer'))
  }
  for (const queued of queuedMessages) {
    incrementPendingAck(acked, pendingMessageKey(queued.text, queued.mode))
  }

  const canDropCompleted = isRestingStatus(status) && streamingText.length === 0
  let changed = false
  const next = pendingUserMessages.filter((pending) => {
    const key = pendingMessageKey(pending.text, pending.mode)
    const count = acked.get(key) ?? 0
    if (count > 0) {
      acked.set(key, count - 1)
      changed = true
      return false
    }
    if (canDropCompleted && pending.mode === 'steer' && hasCompletedTurnAfterPending(timeline, pending)) {
      changed = true
      return false
    }
    return true
  })
  return changed ? next : pendingUserMessages
}

function incrementPendingAck(acked: Map<string, number>, key: string): void {
  acked.set(key, (acked.get(key) ?? 0) + 1)
}

function pendingMessageKey(text: string, mode: 'steer' | 'queue'): string {
  return `${mode}\u0000${text}`
}

function isRestingStatus(status: AgentStatus | undefined): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

function hasCompletedTurnAfterPending(timeline: readonly TimelineEntry[], pending: PendingUserTranscriptMessage): boolean {
  const afterSeq = pending.afterSeq
  if (afterSeq !== undefined) {
    return timeline.some((entry) => entry.seq > afterSeq && isTurnCompletionEvent(entry))
  }
  const createdAtMs = Date.parse(pending.createdAt)
  if (!Number.isFinite(createdAtMs)) return false
  return timeline.some((entry) => {
    if (!isTurnCompletionEvent(entry)) return false
    const entryMs = Date.parse(entry.ts)
    return Number.isFinite(entryMs) && entryMs >= createdAtMs
  })
}

function isTurnCompletionEvent(entry: TimelineEntry): boolean {
  return entry.event.kind === 'llm_response' || entry.event.kind === 'llm_error'
}

export function visibleTranscript(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
  pendingUserMessages: readonly PendingUserTranscriptMessage[] = [],
  queuedMessages: readonly QueuedMessagePreview[] = [],
): readonly TranscriptItem[] {
  const out: TranscriptItem[] = []

  for (const entry of timeline) {
    const event = entry.event
    if (event.kind === 'user_message') {
      out.push({
        kind: 'message',
        seq: entry.seq,
        message: {
          role: 'user',
          content: event.content
            ? [...event.content]
            : [{ type: 'text', text: event.text ?? '' }],
        },
      })
    } else if (event.kind === 'llm_response') {
      out.push({ kind: 'message', seq: entry.seq, message: event.message })
    } else if (event.kind === 'tool_result') {
      out.push({
        kind: 'message',
        seq: entry.seq,
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

  for (const pending of pendingUserMessages) {
    out.push({
      kind: 'pending_user_message',
      id: pending.id,
      text: pending.text,
      mode: pending.mode,
      status: 'sending',
      ...(pending.content ? { content: pending.content } : {}),
      createdAt: pending.createdAt,
    })
  }

  queuedMessages.forEach((queued, index) => {
    out.push({
      kind: 'pending_user_message',
      id: queued.id,
      text: queued.text,
      mode: queued.mode,
      status: 'queued',
      createdAt: queued.createdAt,
      position: index + 1,
    })
  })

  if (timeline.length > 0 || streamingText.length > 0 || pendingUserMessages.length > 0 || queuedMessages.length > 0) return out
  return stateMessages
    .filter((m) => m.role !== 'system')
    .map((message) => ({ kind: 'message', message }))
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

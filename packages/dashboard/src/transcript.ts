import type { AgentStatus, Message, MessageContent } from '@agent-kernel/kernel'
import type { QueuedMessagePreview } from '@agent-kernel/shared'

import type { TimelineEntry } from './session.js'

export type CompactBoundary = {
  kind: 'compact_boundary'
  seq: number
  trigger: 'manual' | 'auto' | 'preflight' | 'tool_result' | 'unknown'
  replacedCount: number
  /**
   * Tokens before/after the compaction. `null` means the metadata was not
   * available to us (e.g. sessions logged before compaction metadata was
   * plumbed onto the wire, or a runtime that dropped the record). The UI
   * must not fall back to `0` in that case — display "—" instead so we
   * don't imply a nonsense "0 → 0 tokens" result.
   */
  tokensBefore: number | null
  tokensAfter: number | null
  summary: string
}

export type TranscriptItem =
  | { kind: 'message'; message: Message; seq?: number; ts?: string; streaming?: boolean }
  | {
      kind: 'pending_user_message'
      id: string
      text: string
      mode: 'steer' | 'queue'
      status: 'sending'
      content?: readonly MessageContent[]
      createdAt: string
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
  options: { includeStatePrefix?: boolean } = {},
): readonly TranscriptItem[] {
  const base = transcriptBaseItems(stateMessages, timeline, options)
  return appendLiveTranscriptItems(base, stateMessages, timeline, streamingText, pendingUserMessages, queuedMessages)
}

/**
 * The stable, timeline-derived portion of the transcript — everything that
 * does *not* change while the agent is streaming a response or while the user
 * has optimistic pending/queued messages in flight. Splitting this out lets
 * callers memoize the expensive full-timeline iteration on stable inputs and
 * only re-run the cheap live-tail append (streaming text, pending) on every
 * ~15fps streaming commit. Rebuilding the whole array each frame was a primary
 * cause of main-thread jank on long sessions (dropped clicks / stuck cursor
 * while the agent runs).
 */
export function transcriptBaseItems(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  options: { includeStatePrefix?: boolean } = {},
): readonly TranscriptItem[] {
  const out: TranscriptItem[] = options.includeStatePrefix
    ? inheritedStatePrefix(stateMessages, timeline).map((message) => ({ kind: 'message' as const, message }))
    : []

  for (const entry of timeline) {
    const event = entry.event
    if (event.kind === 'user_message') {
      out.push({
        kind: 'message',
        seq: entry.seq,
        ts: entry.ts,
        message: {
          role: 'user',
          content: event.content
            ? [...event.content]
            : [{ type: 'text', text: event.text ?? '' }],
        },
      })
    } else if (event.kind === 'llm_response') {
      out.push({ kind: 'message', seq: entry.seq, ts: entry.ts, message: event.message })
    } else if (event.kind === 'tool_result') {
      out.push({
        kind: 'message',
        seq: entry.seq,
        ts: entry.ts,
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
    } else if (event.kind === 'messages_replaced' && event.reason === 'compaction') {
      const meta = entry.compactionMetadata
      out.push({
        kind: 'compact_boundary',
        seq: entry.seq,
        trigger: meta?.trigger ?? 'unknown',
        replacedCount: meta?.replacedCount ?? Math.max(0, event.replaceRange.end - event.replaceRange.start),
        tokensBefore: meta?.tokensBefore ?? null,
        tokensAfter: meta?.tokensAfter ?? null,
        summary: event.replacementMessages.map((message) => message.content.map((content) => content.type === 'text' ? content.text : '').join('')).join('\n'),
      })
    }
  }
  return out
}

/** Append-only fast path. Returns null when history was replaced or reordered. */
export function appendTranscriptBaseItems(
  previousItems: readonly TranscriptItem[],
  previousTimeline: readonly TimelineEntry[],
  timeline: readonly TimelineEntry[],
): readonly TranscriptItem[] | null {
  if (timeline.length < previousTimeline.length) return null
  for (let index = 0; index < previousTimeline.length; index++) {
    const previous = previousTimeline[index]
    const current = timeline[index]
    if (!previous || !current || previous.seq !== current.seq || previous.event !== current.event) return null
  }
  if (timeline.length === previousTimeline.length) return previousItems
  const tail = transcriptBaseItems([], timeline.slice(previousTimeline.length))
  return tail.length === 0 ? previousItems : [...previousItems, ...tail]
}

/**
 * Append the cheap "live tail" (streaming assistant text + optimistic pending
 * user messages) to a memoized {@link transcriptBaseItems} result. Preserves
 * the historical ordering (streaming before pending) and the empty-timeline
 * fallback to raw state messages.
 */
export function appendLiveTranscriptItems(
  base: readonly TranscriptItem[],
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
  pendingUserMessages: readonly PendingUserTranscriptMessage[] = [],
  queuedMessages: readonly QueuedMessagePreview[] = [],
): readonly TranscriptItem[] {
  const hasLiveTail = streamingText.length > 0 || pendingUserMessages.length > 0
  const out: TranscriptItem[] = hasLiveTail ? [...base] : (base as TranscriptItem[])

  if (streamingText.length > 0) {
    out.push({
      kind: 'message',
      streaming: true,
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

  if (timeline.length > 0 || streamingText.length > 0 || pendingUserMessages.length > 0 || queuedMessages.length > 0) return out
  return stateMessages
    .filter((m) => m.role !== 'system')
    .map((message) => ({ kind: 'message', message }))
}

export function visibleMessages(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
  options: { includeStatePrefix?: boolean } = {},
): readonly Message[] {
  return visibleTranscript(stateMessages, timeline, streamingText, [], [], options)
    .filter((item): item is { kind: 'message'; message: Message } => item.kind === 'message')
    .map((item) => item.message)
}

function inheritedStatePrefix(
  stateMessages: readonly Message[],
  timeline: readonly TimelineEntry[],
): readonly Message[] {
  const stateVisible = stateMessages.filter((m) => m.role !== 'system')
  if (stateVisible.length === 0 || timeline.length === 0) return stateVisible
  const timelineMessages = timeline.flatMap((entry) => timelineEntryMessages(entry))
  if (timelineMessages.length === 0) return stateVisible
  let stateIndex = stateVisible.length - 1
  let timelineIndex = timelineMessages.length - 1
  while (stateIndex >= 0 && timelineIndex >= 0 && sameMessage(stateVisible[stateIndex]!, timelineMessages[timelineIndex]!)) {
    stateIndex -= 1
    timelineIndex -= 1
  }
  if (timelineIndex >= 0) return []
  return stateVisible.slice(0, stateIndex + 1)
}

function timelineEntryMessages(entry: TimelineEntry): readonly Message[] {
  const event = entry.event
  if (event.kind === 'user_message') {
    return [{
      role: 'user',
      content: event.content
        ? [...event.content]
        : [{ type: 'text', text: event.text ?? '' }],
    }]
  }
  if (event.kind === 'llm_response') return [event.message]
  if (event.kind === 'tool_result') {
    return [{
      role: 'tool',
      content: [{
        type: 'tool_result',
        callId: event.callId,
        ok: event.ok,
        content: event.content,
      }],
    }]
  }
  return []
}

function sameMessage(a: Message, b: Message): boolean {
  return a.role === b.role && JSON.stringify(a.content) === JSON.stringify(b.content)
}

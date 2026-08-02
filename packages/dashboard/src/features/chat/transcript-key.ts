import type { TranscriptItem } from '../../transcript.js'

export function transcriptItemKey(item: TranscriptItem, itemIndex: number): string {
  if (item.kind === 'compact_boundary') return `compact-${item.seq}`
  if (item.kind === 'pending_user_message') return `pending-${item.id}`
  // A live streaming row is replaced by its persisted llm_response at the same
  // transcript position. Position identity keeps that row mounted across the
  // handoff; seq/streaming-based keys remounted completed Markdown and flashed.
  return `message-position-${itemIndex}`
}

import type { CachedSessionView } from './session-view-cache.js'

export type SessionHydrationDecision =
  | { kind: 'load_full_history'; resetTimeline: boolean; reason: 'empty_cache' | 'cursor_rollback' }
  | { kind: 'load_incremental_history'; sinceCursor: number; reason: 'cached_tail' }

export function decideSessionHydration(input: {
  cached: Pick<CachedSessionView, 'timeline'> | null
  hostCursor: number
}): SessionHydrationDecision {
  const cachedLastSeq = input.cached?.timeline.at(-1)?.seq ?? 0
  if (cachedLastSeq <= 0) {
    return { kind: 'load_full_history', resetTimeline: false, reason: 'empty_cache' }
  }
  if (cachedLastSeq > input.hostCursor) {
    return { kind: 'load_full_history', resetTimeline: true, reason: 'cursor_rollback' }
  }
  return { kind: 'load_incremental_history', sinceCursor: cachedLastSeq, reason: 'cached_tail' }
}

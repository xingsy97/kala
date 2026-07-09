import { describe, expect, it } from 'vitest'

import { decideSessionHydration } from './session-hydration-policy.js'
import type { CachedSessionView } from './session-view-cache.js'

function cached(seqs: readonly number[]): Pick<CachedSessionView, 'timeline'> {
  return {
    timeline: seqs.map((seq) => ({
      seq,
      ts: `t-${seq}`,
      event: { kind: 'user_message', text: `m-${seq}` },
      effects: [],
    })),
  }
}

describe('decideSessionHydration', () => {
  it('loads full history without resetting when there is no usable cache', () => {
    expect(decideSessionHydration({ cached: null, hostCursor: 4 })).toEqual({
      kind: 'load_full_history',
      resetTimeline: false,
      reason: 'empty_cache',
    })
    expect(decideSessionHydration({ cached: cached([]), hostCursor: 4 })).toEqual({
      kind: 'load_full_history',
      resetTimeline: false,
      reason: 'empty_cache',
    })
  })

  it('loads only the missing tail when cached history is not ahead of the host', () => {
    expect(decideSessionHydration({ cached: cached([1, 3]), hostCursor: 5 })).toEqual({
      kind: 'load_incremental_history',
      sinceCursor: 3,
      reason: 'cached_tail',
    })
  })

  it('forces a full reset when the cached tail is ahead of the host cursor', () => {
    expect(decideSessionHydration({ cached: cached([4]), hostCursor: 2 })).toEqual({
      kind: 'load_full_history',
      resetTimeline: true,
      reason: 'cursor_rollback',
    })
  })
})

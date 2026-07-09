import { describe, expect, it } from 'vitest'

import { createSessionViewCache, sessionViewCacheMaxBytesFromMb, type CachedSessionViewInput } from './session-view-cache.js'

function cached(sessionId: string, seqs: readonly number[] = []): CachedSessionViewInput {
  return {
    sessionId,
    status: 'ready',
    state: null,
    config: null,
    contextSnapshot: null,
    timeline: seqs.map((seq) => ({
      seq,
      ts: `t-${seq}`,
      event: { kind: 'user_message', text: `m-${seq}` },
      effects: [],
    })),
    queuedMessages: [],
    lastError: null,
    parentSessionId: null,
    parentCursor: null,
    selectedModel: null,
    hydratedSessionId: sessionId,
  }
}

describe('session view cache', () => {
  it('stores, patches, and deletes session views', () => {
    let now = 100
    const cache = createSessionViewCache({ maxBytes: sessionViewCacheMaxBytesFromMb(1), now: () => now++ })

    cache.set('s1', cached('s1', [1]))
    expect(cache.get('s1')?.timeline.map((entry) => entry.seq)).toEqual([1])

    cache.patch('s1', { timeline: cached('s1', [1, 2]).timeline })
    expect(cache.get('s1')?.timeline.map((entry) => entry.seq)).toEqual([1, 2])

    cache.delete('s1')
    expect(cache.get('s1')).toBeNull()
  })

  it('evicts least-recently-used sessions when over the memory limit', () => {
    let now = 1
    const first = cached('old', [1])
    const firstBytes = createSessionViewCache({ maxBytes: sessionViewCacheMaxBytesFromMb(1) }).set('probe', first)?.estimatedBytes ?? 0
    const cache = createSessionViewCache({ maxBytes: firstBytes + 16, now: () => now++ })

    cache.set('old', first)
    cache.set('new', cached('new', [1]))

    expect(cache.get('old')).toBeNull()
    expect(cache.get('new')).not.toBeNull()
    expect(cache.stats().sessions).toBe(1)
  })

  it('applies updated max bytes immediately', () => {
    const cache = createSessionViewCache({ maxBytes: sessionViewCacheMaxBytesFromMb(1) })
    const first = cache.set('s1', cached('s1', [1]))!
    cache.set('s2', cached('s2', [1]))

    cache.setMaxBytes(first.estimatedBytes + 16)

    expect(cache.stats().sessions).toBe(1)
  })

  it('does not keep a single session that exceeds the memory limit', () => {
    const cache = createSessionViewCache({ maxBytes: 10 })

    expect(cache.set('huge', cached('huge', [1, 2, 3]))).toBeNull()
    expect(cache.get('huge')).toBeNull()
    expect(cache.stats().estimatedBytes).toBe(0)
  })

  it('reuses timeline byte estimates for metadata-only patches', () => {
    const cache = createSessionViewCache({ maxBytes: sessionViewCacheMaxBytesFromMb(1) })
    const entry = cache.set('s1', cached('s1', [1, 2, 3]))!

    const patched = cache.patch('s1', { selectedModel: 'gpt-5.1' })!

    expect(patched.estimateParts.timelineBytes).toBe(entry.estimateParts.timelineBytes)
    expect(patched.estimatedBytes).toBeGreaterThan(0)
  })

  it('treats a zero byte limit as disabled cache', () => {
    const cache = createSessionViewCache({ maxBytes: 0 })

    cache.set('s1', cached('s1', [1]))

    expect(cache.get('s1')).toBeNull()
    expect(cache.stats().sessions).toBe(0)
  })
})

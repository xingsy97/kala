import { describe, expect, it } from 'vitest'

import { SlidingWindowRateLimiter } from './rate-limit.js'

describe('SlidingWindowRateLimiter', () => {
  it('isolates limits by key and exposes retry timing', () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, maxRequests: 2 })
    expect(limiter.check('org:a', 1_000)).toEqual({ ok: true })
    expect(limiter.check('org:a', 1_100)).toEqual({ ok: true })
    expect(limiter.check('org:a', 1_200)).toEqual({ ok: false, retryAfterMs: 800 })
    expect(limiter.check('org:b', 1_200)).toEqual({ ok: true })
    expect(limiter.check('org:a', 2_001)).toEqual({ ok: true })
  })

  it('rejects invalid configuration', () => {
    expect(() => new SlidingWindowRateLimiter({ windowMs: 0, maxRequests: 1 })).toThrow('windowMs')
    expect(() => new SlidingWindowRateLimiter({ windowMs: 1, maxRequests: 0 })).toThrow('maxRequests')
  })
})

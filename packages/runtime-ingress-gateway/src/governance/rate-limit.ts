export type RateLimitDecision =
  | { ok: true }
  | { ok: false; retryAfterMs: number }

export interface RateLimiter {
  check(key: string, now?: number): RateLimitDecision
}

export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(private readonly options: { windowMs: number; maxRequests: number }) {
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) throw new Error('rate limit windowMs must be positive')
    if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1) throw new Error('rate limit maxRequests must be positive')
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const start = now - this.options.windowMs
    const retained = (this.hits.get(key) ?? []).filter((hit) => hit > start)
    if (retained.length >= this.options.maxRequests) {
      const retryAfterMs = Math.max(1, retained[0]! + this.options.windowMs - now)
      this.hits.set(key, retained)
      return { ok: false, retryAfterMs }
    }
    retained.push(now)
    this.hits.set(key, retained)
    return { ok: true }
  }
}

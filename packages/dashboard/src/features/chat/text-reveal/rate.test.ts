import { describe, expect, it } from 'vitest'

import {
  computeReveal,
  REVEAL_BASE_CPS,
  REVEAL_MAX_CPS,
  REVEAL_MAX_LAG_SECONDS,
} from './rate.js'

const FRAME = 1 / 60 // ~16.67ms

describe('computeReveal (even-rate text reveal)', () => {
  it('reveals nothing when the buffer is empty', () => {
    expect(computeReveal(0, FRAME, 0)).toEqual({ count: 0, carry: 0 })
  })

  it('paces a small backlog at ~REVEAL_BASE_CPS with an even per-frame rhythm', () => {
    let buffer = 200
    let carry = 0
    const perFrame: number[] = []
    let frames = 0
    while (buffer > 0 && frames < 1000) {
      const r = computeReveal(buffer, FRAME, carry)
      carry = r.carry
      buffer -= r.count
      perFrame.push(r.count)
      frames += 1
    }
    const max = Math.max(...perFrame)
    expect(max).toBeLessThanOrEqual(Math.ceil((REVEAL_MAX_CPS * FRAME) + 1))
    const nonZero = perFrame.filter((n) => n > 0)
    const avg = nonZero.reduce((a, b) => a + b, 0) / nonZero.length
    expect(avg).toBeLessThan(6)
  })

  it('accelerates a large backlog to catch up but caps at REVEAL_MAX_CPS', () => {
    const bigBuffer = 100_000
    const r = computeReveal(bigBuffer, FRAME, 0)
    expect(r.count).toBeLessThanOrEqual(Math.ceil(REVEAL_MAX_CPS * FRAME) + 1)
    expect(r.count).toBeGreaterThan(Math.floor(REVEAL_BASE_CPS * FRAME))
  })

  it('never lags the data by more than REVEAL_MAX_LAG_SECONDS worth of catch-up rate', () => {
    const backlog = 1200
    const r = computeReveal(backlog, REVEAL_MAX_LAG_SECONDS, 0)
    expect(r.count).toBeGreaterThanOrEqual(Math.min(backlog, Math.floor(REVEAL_MAX_CPS * REVEAL_MAX_LAG_SECONDS)))
  })

  it('carries fractional characters so the average rate is exact over time', () => {
    // Small backlog stays at base rate (base applies while buffer/MAX_LAG <= BASE).
    let carry = 0
    let released = 0
    const frames = 60 // ~1 second
    for (let i = 0; i < frames; i += 1) {
      const r = computeReveal(40, FRAME, carry)
      carry = r.carry
      released += r.count
    }
    expect(released).toBeGreaterThanOrEqual(REVEAL_BASE_CPS - 3)
    expect(released).toBeLessThanOrEqual(REVEAL_BASE_CPS + 3)
  })

  it('never reveals more than the buffer holds', () => {
    const r = computeReveal(3, 1, 0) // huge dt
    expect(r.count).toBeLessThanOrEqual(3)
  })
})

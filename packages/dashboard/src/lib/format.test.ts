import { describe, expect, it } from 'vitest'

import { formatElapsed, formatTokens } from './format.js'

describe('formatTokens', () => {
  it('keeps the fixed-1 token format used by context metrics', () => {
    expect(formatTokens(42)).toBe('42')
    expect(formatTokens(1_200)).toBe('1.2k')
    expect(formatTokens(400_000)).toBe('400.0k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })

  it('supports compact token labels used by activity text', () => {
    expect(formatTokens(1_200, { thousands: 'compact', millionSuffix: 'm' })).toBe('1.2k')
    expect(formatTokens(21_400, { thousands: 'compact', millionSuffix: 'm' })).toBe('21k')
    expect(formatTokens(1_250_000, { thousands: 'compact', millionSuffix: 'm' })).toBe('1.3m')
  })
})

describe('formatElapsed', () => {
  it('formats elapsed time without negative values', () => {
    expect(formatElapsed(-1)).toBe('0s')
    expect(formatElapsed(9_999)).toBe('9s')
    expect(formatElapsed(65_000)).toBe('1m 05s')
  })
})

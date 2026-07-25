import { describe, expect, it } from 'vitest'

import { errorMessageFromBody, formatBytes, formatDate, meaningfulInviteLabel, shellQuote } from './section-utils.js'

describe('errorMessageFromBody', () => {
  it('returns the error string when present', () => {
    expect(errorMessageFromBody({ error: 'boom' })).toBe('boom')
  })
  it('returns null for non-objects, missing, or empty error', () => {
    expect(errorMessageFromBody(null)).toBeNull()
    expect(errorMessageFromBody('x')).toBeNull()
    expect(errorMessageFromBody({})).toBeNull()
    expect(errorMessageFromBody({ error: '' })).toBeNull()
    expect(errorMessageFromBody({ error: 42 })).toBeNull()
  })
})

describe('meaningfulInviteLabel', () => {
  it('returns a trimmed label', () => {
    expect(meaningfulInviteLabel('  My box  ')).toBe('My box')
  })
  it('drops empty and the generic placeholder', () => {
    expect(meaningfulInviteLabel(undefined)).toBeUndefined()
    expect(meaningfulInviteLabel('   ')).toBeUndefined()
    expect(meaningfulInviteLabel('Connect Workspace')).toBeUndefined()
    expect(meaningfulInviteLabel('connect workspace')).toBeUndefined()
  })
})

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded quotes', () => {
    expect(shellQuote('abc')).toBe("'abc'")
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})

describe('formatBytes', () => {
  it('formats B / KB / MB thresholds', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('formatDate', () => {
  it('returns the raw value for unparseable input', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date')
  })
  it('formats a valid ISO date to a locale string', () => {
    const out = formatDate('2020-01-02T03:04:05.000Z')
    expect(typeof out).toBe('string')
    expect(out).not.toBe('2020-01-02T03:04:05.000Z')
  })
})

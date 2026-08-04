import { describe, expect, it } from 'vitest'

import { parseSessionDeepLink } from './section.js'

describe('parseSessionDeepLink', () => {
  it('extracts the session id from a #/sessions/<id> hash', () => {
    expect(parseSessionDeepLink('#/sessions/abc123')).toBe('abc123')
  })
  it('decodes safe percent-encoded ids', () => {
    expect(parseSessionDeepLink('#/sessions/a%20b')).toBe('a b')
  })
  it('rejects malformed, path-like, and trailing-segment ids', () => {
    expect(parseSessionDeepLink('#/sessions/a%2Fb')).toBeNull()
    expect(parseSessionDeepLink('#/sessions/a%5Cb')).toBeNull()
    expect(parseSessionDeepLink('#/sessions/%E0%A4%A')).toBeNull()
    expect(parseSessionDeepLink('#/sessions/abc123/whatever')).toBeNull()
  })
  it('returns null for non-session hashes', () => {
    expect(parseSessionDeepLink('#/agent')).toBeNull()
    expect(parseSessionDeepLink('#/artifacts')).toBeNull()
    expect(parseSessionDeepLink('')).toBeNull()
    expect(parseSessionDeepLink('#/sessions')).toBeNull()
    expect(parseSessionDeepLink('#/sessions/')).toBeNull()
  })
})

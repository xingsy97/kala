import { describe, expect, it } from 'vitest'

import { parseSessionDeepLink } from './section.js'

describe('parseSessionDeepLink', () => {
  it('extracts the session id from a #/sessions/<id> hash', () => {
    expect(parseSessionDeepLink('#/sessions/abc123')).toBe('abc123')
    expect(parseSessionDeepLink('#/sessions/abc123/whatever')).toBe('abc123')
  })
  it('decodes percent-encoded ids', () => {
    expect(parseSessionDeepLink('#/sessions/a%2Fb')).toBe('a/b')
  })
  it('returns null for non-session hashes', () => {
    expect(parseSessionDeepLink('#/agent')).toBeNull()
    expect(parseSessionDeepLink('#/benchmarks')).toBeNull()
    expect(parseSessionDeepLink('')).toBeNull()
    expect(parseSessionDeepLink('#/sessions')).toBeNull()
    expect(parseSessionDeepLink('#/sessions/')).toBeNull()
  })
})

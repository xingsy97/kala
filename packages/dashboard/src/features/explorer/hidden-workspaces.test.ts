import { describe, expect, it } from 'vitest'

import { parseHiddenIds, serializeHiddenIds } from './hidden-workspaces.js'

describe('hidden-workspaces storage codec', () => {
  it('parses null/empty into an empty set', () => {
    expect(parseHiddenIds(null).size).toBe(0)
    expect(parseHiddenIds('').size).toBe(0)
  })

  it('round-trips a set of workspace ids', () => {
    const original = new Set(['ws-a', 'ws-b', 'ws-c'])
    const decoded = parseHiddenIds(serializeHiddenIds(original))
    expect(decoded).toEqual(original)
  })

  it('returns empty on malformed JSON', () => {
    expect(parseHiddenIds('not-json').size).toBe(0)
    expect(parseHiddenIds('{').size).toBe(0)
  })

  it('returns empty when the wire shape is wrong', () => {
    expect(parseHiddenIds(JSON.stringify(['ws-a'])).size).toBe(0)
    expect(parseHiddenIds(JSON.stringify({ version: 2, ids: ['ws-a'] })).size).toBe(0)
    expect(parseHiddenIds(JSON.stringify({ version: 1, ids: 'ws-a' })).size).toBe(0)
    expect(parseHiddenIds(JSON.stringify({ version: 1 })).size).toBe(0)
  })

  it('drops non-string / empty ids defensively', () => {
    const raw = JSON.stringify({ version: 1, ids: ['ws-a', '', 42, null, 'ws-b'] })
    expect(parseHiddenIds(raw)).toEqual(new Set(['ws-a', 'ws-b']))
  })

  it('serializes deterministically to a version-1 envelope', () => {
    const serialized = serializeHiddenIds(new Set(['ws-a']))
    expect(JSON.parse(serialized)).toEqual({ version: 1, ids: ['ws-a'] })
  })
})

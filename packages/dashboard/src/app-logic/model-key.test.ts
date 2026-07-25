import { describe, expect, it } from 'vitest'

import { modelKey, resolveModelKey } from './model-key.js'

const m = (id: string, ref?: string): never => ({ id, ref }) as never

describe('modelKey', () => {
  it('prefers ref, then id, then empty', () => {
    expect(modelKey(m('id1', 'ref1'))).toBe('ref1')
    expect(modelKey(m('id1'))).toBe('id1')
    expect(modelKey(null)).toBe('')
    expect(modelKey(undefined)).toBe('')
  })
})

describe('resolveModelKey', () => {
  const models = [m('a', 'ref-a'), m('b', 'ref-b'), m('b', 'ref-b2')]
  it('returns empty for falsy input', () => {
    expect(resolveModelKey(models, null)).toBe('')
    expect(resolveModelKey(models, '')).toBe('')
  })
  it('matches an exact key', () => {
    expect(resolveModelKey(models, 'ref-a')).toBe('ref-a')
  })
  it('resolves a unique id to its key', () => {
    expect(resolveModelKey(models, 'a')).toBe('ref-a')
  })
  it('is ambiguous (empty) when an id maps to multiple models', () => {
    expect(resolveModelKey(models, 'b')).toBe('')
  })
})

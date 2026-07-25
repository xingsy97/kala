import { describe, expect, it } from 'vitest'

import { roleCounts, summarizeContent } from './timeline-model.js'

describe('roleCounts', () => {
  it('summarizes message role counts', () => {
    const out = roleCounts([
      { role: 'user' },
      { role: 'assistant' },
      { role: 'user' },
    ] as never)
    expect(out).toContain('user')
    expect(out).toContain('assistant')
    expect(out).toMatch(/2/)
  })
})

describe('summarizeContent', () => {
  it('joins text parts into a summary string', () => {
    const out = summarizeContent([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ] as never)
    expect(out).toContain('hello')
  })
  it('returns a string for empty content', () => {
    expect(typeof summarizeContent([] as never)).toBe('string')
  })
})

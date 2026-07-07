import { describe, expect, it } from 'vitest'

import { countAddDel, diffLines, diffWords } from './diff.js'

describe('diffLines', () => {
  it('pairs adjacent del+add into a replace row', () => {
    const rows = diffLines(['foo', 'bar', 'baz'], ['foo', 'BAR', 'baz'], 1)
    const replace = rows.find((r) => r.kind === 'replace')
    expect(replace).toBeDefined()
    if (replace && replace.kind === 'replace') {
      expect(replace.before).toBe('bar')
      expect(replace.after).toBe('BAR')
      expect(replace.oldNo).toBe(2)
      expect(replace.newNo).toBe(2)
    }
  })

  it('collapses unchanged runs longer than the context window into a gap', () => {
    const before = ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'x']
    const after = ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'y']
    const rows = diffLines(before, after, 2)
    const gap = rows.find((r) => r.kind === 'gap')
    expect(gap).toBeDefined()
    if (gap && gap.kind === 'gap') expect(gap.count).toBeGreaterThan(0)
  })

  it('numbers context lines using the corresponding source line', () => {
    const rows = diffLines(['a', 'b', 'c'], ['a', 'X', 'c'], 1)
    const cContext = rows.filter((r) => r.kind === 'context')
    expect(cContext.length).toBe(2)
    if (cContext[0]?.kind === 'context') {
      expect(cContext[0].oldNo).toBe(1)
      expect(cContext[0].newNo).toBe(1)
    }
    if (cContext[1]?.kind === 'context') {
      expect(cContext[1].oldNo).toBe(3)
      expect(cContext[1].newNo).toBe(3)
    }
  })
})

describe('diffWords', () => {
  it('identifies inserted words on the after side', () => {
    const segs = diffWords('hello world', 'hello brave world')
    expect(segs.some((s) => s.kind === 'add' && s.text.includes('brave'))).toBe(true)
    expect(segs.some((s) => s.kind === 'equal' && s.text.includes('hello'))).toBe(true)
  })

  it('identifies deleted words on the before side', () => {
    const segs = diffWords('hello brave world', 'hello world')
    expect(segs.some((s) => s.kind === 'del' && s.text.includes('brave'))).toBe(true)
  })

  it('returns a single equal segment when the lines match', () => {
    const segs = diffWords('same line', 'same line')
    expect(segs.length).toBe(1)
    expect(segs[0]?.kind).toBe('equal')
    expect(segs[0]?.text).toBe('same line')
  })

  it('coalesces runs of the same kind', () => {
    // "aaa bbb" vs "aaa ccc ddd" → equal("aaa "), add("ccc "), del("bbb"), add("ddd")
    // The trailing add-run must coalesce into a single segment rather than
    // producing two adjacent adds.
    const segs = diffWords('aaa bbb', 'aaa ccc ddd')
    const trailingAdds = segs.filter((s) => s.kind === 'add')
    // Confirm the added tokens are consolidated into no more than a couple
    // of add segments (coalesced), rather than one per word/space pair.
    expect(trailingAdds.length).toBeLessThanOrEqual(2)
  })
})

describe('countAddDel', () => {
  it('counts standalone add/del and replace rows', () => {
    const rows = diffLines(['a', 'b', 'c'], ['a', 'B', 'c', 'd'], 1)
    const { added, deleted } = countAddDel(rows)
    expect(added).toBe(2)
    expect(deleted).toBe(1)
  })
})

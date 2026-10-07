import { describe, expect, it } from 'vitest'
import { segmentAssistantReply } from './chapter-segments.js'

const paragraph = (size = 700): string => `${'A readable sentence with context. '.repeat(Math.ceil(size / 34))}\n\n`

describe('assistant reply chapters', () => {
  it('does not paginate short replies or replies without semantic headings', () => {
    expect(segmentAssistantReply(`## One\n${paragraph(800)}## Two\n${paragraph(800)}`)).toEqual([])
    expect(segmentAssistantReply(paragraph(5000))).toEqual([])
  })

  it('does not treat fake headings inside fenced code as page boundaries', () => {
    const code = '```md\n## Not a chapter\n' + 'code\n'.repeat(100) + '```\n'
    const chapters = segmentAssistantReply(`## Actual first\n${paragraph(800)}${code}\n## Actual second\n${paragraph(850)}`)
    expect(chapters).toHaveLength(2)
    expect(chapters[0]!.markdown).toContain('## Not a chapter')
    expect(chapters[0]!.markdown).toContain('```')
    expect(chapters[1]!.title).toBe('Actual second')
  })

  it('merges a short introduction and short section with their neighbors', () => {
    const chapters = segmentAssistantReply(`Intro.\n\n## One\n${paragraph(1300)}## Tiny\nBrief.\n\n## Three\n${paragraph(1300)}`)
    expect(chapters).toHaveLength(2)
    expect(chapters[0]!.markdown).toContain('Intro.')
    expect(chapters[0]!.markdown).toContain('## Tiny')
    expect(chapters[1]!.title).toBe('Three')
  })

  it('splits long sections on whole top-level blocks and retains reference definitions', () => {
    const code = '```typescript\n' + 'const text = "# heading"\n'.repeat(75) + '```\n\n'
    const text = `## One\n${paragraph(1100)}${code}${paragraph(1100)}${paragraph(1100)}\n[link][ref]\n\n## Two\n${paragraph(900)}\n[ref]: https://example.org/path\n`
    const chapters = segmentAssistantReply(text)
    expect(chapters.length).toBeGreaterThan(2)
    expect(chapters.filter((chapter) => chapter.markdown.includes('```typescript'))).toHaveLength(1)
    expect(chapters.every((chapter) => chapter.markdown.includes('[ref]: https://example.org/path'))).toBe(true)
    expect(chapters.some((chapter) => chapter.continuation && chapter.title === 'One')).toBe(true)
  })
})

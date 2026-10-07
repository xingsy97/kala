import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

export type ChapterSegment = { title: string; markdown: string; continuation?: boolean }

// Stable document-based thresholds: viewport changes must not renumber chapters.
const MIN_REPLY = 2_000
const MIN_CHAPTER = 350
const TARGET_CHAPTER = 2_400
const MAX_CHAPTER = 3_200

type Range = { start: number; end: number; title: string; continuation?: boolean }

/** Split only at Markdown AST top-level nodes, never inside a code fence, list, or table. */
export function segmentAssistantReply(text: string): ChapterSegment[] {
  if (text.length < MIN_REPLY) return []
  const nodes = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(text).children
  const offset = (index: number): number => nodes[index]?.position?.start.offset ?? text.length
  const headings = nodes.map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === 'heading' && node.depth <= 2)
  if (headings.length === 0) return []
  const ranges: Range[] = []
  if (offset(headings[0]!.index) > 0) ranges.push({ start: 0, end: offset(headings[0]!.index), title: '' })
  for (let i = 0; i < headings.length; i++) {
    const { node, index } = headings[i]!
    const start = offset(index)
    const end = i + 1 < headings.length ? offset(headings[i + 1]!.index) : text.length
    // AST title text, not a regex that could mistake fenced examples for real headings.
    const title = text.slice(start, node.position?.end.offset ?? start).split('\n')[0]!
      .replace(/^\s*#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim()
    ranges.push({ start, end, title: title || '' })
  }

  const split: Range[] = []
  for (const range of ranges) {
    let start = range.start
    let part = 0
    while (range.end - start > MAX_CHAPTER) {
      // Prefer a subheading, otherwise the closest complete top-level block near the target.
      const candidates = nodes.filter((node) => {
        const at = node.position?.start.offset ?? -1
        return at > start + MIN_CHAPTER && at < range.end && at <= start + MAX_CHAPTER
      })
      const preferred = candidates.filter((node) => node.type === 'heading' && node.depth >= 3)
      const near = (preferred.length ? preferred : candidates)
        .sort((a, b) => Math.abs((a.position?.start.offset ?? 0) - start - TARGET_CHAPTER)
          - Math.abs((b.position?.start.offset ?? 0) - start - TARGET_CHAPTER))[0]
      const end = near?.position?.start.offset
      if (end === undefined || end <= start) break // One indivisible large code/table/list block.
      split.push({ start, end, title: range.title, continuation: part > 0 })
      start = end
      part++
    }
    split.push({ start, end: range.end, title: range.title, continuation: part > 0 })
  }

  const merged: Range[] = []
  for (const range of split) {
    const previous = merged.at(-1)
    if (previous && (previous.end - previous.start < MIN_CHAPTER || range.end - range.start < MIN_CHAPTER)) {
      previous.end = range.end
      if (!previous.title) previous.title = range.title
    } else {
      merged.push({ ...range })
    }
  }
  // Keep Markdown reference-style links valid even if their definitions live on another page.
  const definitions = nodes.filter((node) => node.type === 'definition')
    .map((node) => ({ start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 }))
  return merged.length < 2 ? [] : merged.map((range) => ({
    title: range.title,
    continuation: range.continuation,
    markdown: (text.slice(range.start, range.end) + definitions
      .filter((definition) => definition.start < range.start || definition.start >= range.end)
      .map((definition) => `\n\n${text.slice(definition.start, definition.end)}`).join('')).trim(),
  }))
}

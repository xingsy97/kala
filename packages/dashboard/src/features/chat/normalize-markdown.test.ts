import { describe, expect, it } from 'vitest'

import {
  EMPHASIS_ADJACENCY_MARKER,
  normalizeMarkdownEmphasisAdjacency,
  remarkStripEmphasisAdjacencyMarker,
} from './normalize-markdown.js'

describe('normalizeMarkdownEmphasisAdjacency', () => {
  it.each([
    ['CJK punctuation', '- **香港可以接受：**QRT', `- **香港可以接受：**${EMPHASIS_ADJACENCY_MARKER}QRT`],
    ['ASCII punctuation', '- **Hong Kong accepted:**QRT', `- **Hong Kong accepted:**${EMPHASIS_ADJACENCY_MARKER}QRT`],
    ['CJK adjacent text', '**结论**继续', `**结论**${EMPHASIS_ADJACENCY_MARKER}继续`],
  ])('repairs %s before adjacent prose', (_kind, source, expected) => {
    expect(normalizeMarkdownEmphasisAdjacency(source)).toBe(expected)
  })

  it.each([
    ['ASCII punctuation after emphasis', '**Accepted**: QRT'],
    ['CJK punctuation after emphasis', '**接受**：QRT'],
    ['escaped delimiters', String.raw`\**香港可以接受：**QRT`],
    ['inline code', '`- **香港可以接受：**QRT`'],
    ['variable inline code', '``inside ` and **label:**value``'],
    ['backtick fence', '```md\n- **香港可以接受：**QRT\n```'],
    ['tilde fence', '~~~~md\n- **香港可以接受：**QRT\n~~~~'],
    ['long fence with shorter run inside', '`````md\n```\n**label:**value\n`````'],
    ['link label', '[**香港可以接受：**QRT](https://example.com)'],
    ['nested link destination', '[label](https://example.com/a_(b)/**path:**QRT)'],
    ['reference link', '[**label:**value][target]\n\n[target]: https://example.com'],
    ['reference destination', '[target]: https://example.com/**path:**QRT'],
    ['autolink destination', '<https://example.com/**path:**QRT>'],
    ['triple delimiters', '***香港可以接受：***QRT'],
    ['four delimiters', '****香港可以接受：****QRT'],
    ['unclosed strong', '**香港可以接受：QRT'],
  ])('leaves %s unchanged', (_kind, source) => {
    expect(normalizeMarkdownEmphasisAdjacency(source)).toBe(source)
  })

  it('strips only the complete parser marker from Markdown text nodes', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'text', value: `label${EMPHASIS_ADJACENCY_MARKER}value` },
        { type: 'code', value: EMPHASIS_ADJACENCY_MARKER },
      ],
    }
    remarkStripEmphasisAdjacencyMarker()(tree)
    expect(tree.children[0]?.value).toBe('labelvalue')
    expect(tree.children[1]?.value).toBe(EMPHASIS_ADJACENCY_MARKER)
  })
})

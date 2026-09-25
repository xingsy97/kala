import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it } from 'vitest'

import { canFadeRevealTail, renderRevealTail } from './RevealTail.js'
import { REVEAL_FADE_WINDOW_CHARS } from './rate.js'

function fadeSpanCount(html: string): number {
  return (html.match(/class="ak-char-in"/g) ?? []).length
}

describe('canFadeRevealTail (safety-net downgrade)', () => {
  it('allows fading a plain paragraph tail', () => {
    expect(canFadeRevealTail('the quick brown fox')).toBe(true)
  })
  it('refuses an empty tail', () => {
    expect(canFadeRevealTail('')).toBe(false)
  })
  it.each([
    ['emphasis', 'Answer: **香港可以接受：**QRT'],
    ['heading', '## 标题'],
    ['unordered list', '- 第一项'],
    ['ordered list', '1. 第一项'],
    ['table', '| 名称 | 值 |\n| --- | --- |'],
    ['link', '[文档](https://example.com)'],
    ['blockquote', '> 引用'],
    ['inline code', '运行 `pnpm test`'],
    ['fenced code', 'here is code:\n```js\nconst a = 1'],
    ['completed fence', '```js\nconst a = 1\n```\nnow prose'],
    ['plain multi-paragraph document', 'first paragraph\n\nsecond paragraph'],
    ['escaped syntax', String.raw`\*literal asterisk`],
    ['GFM URL autolink', 'See https://example.com'],
    ['GFM email autolink', 'Email dev@example.com'],
    ['entity', 'Copyright &copy;'],
    ['inline math', 'Value $x + y$'],
    ['indented code', '    const value = true'],
  ])('refuses a Markdown-significant %s tail', (_kind, tail) => {
    expect(canFadeRevealTail(tail)).toBe(false)
  })
})

describe('renderRevealTail (persistent per-character fade window)', () => {
  it('animates only the last REVEAL_FADE_WINDOW_CHARS characters', () => {
    const text = 'x'.repeat(REVEAL_FADE_WINDOW_CHARS + 200)
    const html = renderToStaticMarkup(renderRevealTail({ text }))
    expect(fadeSpanCount(html)).toBe(REVEAL_FADE_WINDOW_CHARS)
  })

  it('animates every character when shorter than the window', () => {
    const html = renderToStaticMarkup(renderRevealTail({ text: 'hello' }))
    expect(fadeSpanCount(html)).toBe(5)
  })

  it('preserves the full text (settled prefix + fading tail + no loss)', () => {
    const text = 'abcdef'.repeat(30)
    const html = renderToStaticMarkup(renderRevealTail({ text }))
    const visible = html.replace(/<[^>]*>/g, '')
    expect(visible).toBe(text)
  })

  it('renders a trailing reveal cursor', () => {
    const html = renderToStaticMarkup(renderRevealTail({ text: 'hi' }))
    expect(html).toContain('ak-streaming-cursor')
  })
})

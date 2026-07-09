import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeCtx } from './_test-helpers.js'
import { ToolError } from './registry.js'
import { htmlToText, webfetchTool } from './webfetch.js'

function fetchOnce(status: number, body: string, contentType = 'text/html'): typeof fetch {
  return vi.fn(async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': contentType },
    }),
  ) as unknown as typeof fetch
}

function fetchSequence(responses: Array<{ status: number; body: string; contentType?: string }>): typeof fetch {
  return vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    return new Response(next.body, {
      status: next.status,
      headers: { 'Content-Type': next.contentType ?? 'text/html' },
    })
  }) as unknown as typeof fetch
}

describe('webfetch tool', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects non-http URLs', async () => {
    await expect(webfetchTool.run({ url: 'file:///tmp/x' }, makeCtx('/tmp'))).rejects.toBeInstanceOf(ToolError)
  })

  it('fetches and cleans HTML pages', async () => {
    globalThis.fetch = fetchOnce(200, '<html><head><style>x</style></head><body><h1>Title</h1><p>A &amp; B</p><script>bad()</script></body></html>')
    const out = await webfetchTool.run({ url: 'https://example.com/a' }, makeCtx('/tmp'))
    expect(out).toContain('Fetched: https://example.com/a')
    expect(out).toContain('Title')
    expect(out).toContain('A & B')
    expect(out).not.toContain('bad()')
  })

  it('truncates output', async () => {
    globalThis.fetch = fetchOnce(200, 'x'.repeat(200), 'text/plain')
    const out = await webfetchTool.run({ url: 'https://example.com/a', maxChars: 50 }, makeCtx('/tmp'))
    expect(out).toContain('[truncated to 50 chars]')
  })

  it('throws EHTTP on non-2xx response', async () => {
    globalThis.fetch = fetchOnce(404, 'missing')
    await expect(webfetchTool.run({ url: 'https://example.com/missing' }, makeCtx('/tmp'))).rejects.toMatchObject({ code: 'EHTTP' })
  })

  it('adds Archive.org OCR text when fetching item landing pages', async () => {
    globalThis.fetch = fetchSequence([
      { status: 200, body: '<html><title>Item page</title><body>Landing only</body></html>' },
      { status: 200, body: 'OCR full text with discharge date 07/28/1865', contentType: 'text/plain' },
    ])
    const out = await webfetchTool.run({ url: 'https://archive.org/details/civilwarletters100wesc' }, makeCtx('/tmp'))
    expect(out).toContain('Archive.org OCR text: https://archive.org/stream/civilwarletters100wesc/civilwarletters100wesc_djvu.txt')
    expect(out).toContain('OCR full text with discharge date 07/28/1865')
    expect(out).toContain('Archive.org landing page text')
  })

  it('adds Archive.org OCR text when fetching stream file URLs', async () => {
    globalThis.fetch = fetchSequence([
      { status: 200, body: '<html><title>File page</title><body>PDF preview only</body></html>' },
      { status: 200, body: 'OCR full text from stream identifier', contentType: 'text/plain' },
    ])
    const out = await webfetchTool.run({ url: 'https://archive.org/stream/civilwarletters100wesc/civilwarletters100wesc.pdf' }, makeCtx('/tmp'))
    expect(out).toContain('Archive.org OCR text: https://archive.org/stream/civilwarletters100wesc/civilwarletters100wesc_djvu.txt')
    expect(out).toContain('OCR full text from stream identifier')
    expect(out).toContain('Archive.org landing page text')
  })

  it('does not return binary PDF bodies as readable evidence', async () => {
    globalThis.fetch = fetchOnce(200, '%PDF-1.7\n\u0000\u0001binary', 'application/pdf')
    const out = await webfetchTool.run({ url: 'https://example.com/paper.pdf' }, makeCtx('/tmp'))
    expect(out).toContain('PDF content was not extracted as readable text')
    expect(out).not.toContain('%PDF-1.7')
  })

  it('still returns Archive.org OCR for PDF URLs when OCR is available', async () => {
    globalThis.fetch = fetchSequence([
      { status: 200, body: '%PDF-1.7\n\u0000\u0001binary', contentType: 'application/pdf' },
      { status: 200, body: 'Archive OCR beats binary PDF', contentType: 'text/plain' },
    ])
    const out = await webfetchTool.run({ url: 'https://archive.org/stream/civilwarletters100wesc/civilwarletters100wesc.pdf' }, makeCtx('/tmp'))
    expect(out).toContain('Archive.org OCR text: https://archive.org/stream/civilwarletters100wesc/civilwarletters100wesc_djvu.txt')
    expect(out).toContain('Archive OCR beats binary PDF')
    expect(out).not.toContain('PDF content was not extracted as readable text')
  })

  it('converts common block tags to readable text', () => {
    expect(htmlToText('<div>One</div><p>Two</p><table><tr><td>A</td><td>B</td></tr></table>')).toContain('One')
    expect(htmlToText('<div>One</div><p>Two</p><table><tr><td>A</td><td>B</td></tr></table>')).toContain('A')
  })
})

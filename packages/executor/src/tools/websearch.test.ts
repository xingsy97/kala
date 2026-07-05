import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeCtx } from './_test-helpers.js'
import { ToolError } from './registry.js'
import { parseDuckDuckGoHtml, websearchTool } from './websearch.js'

const SAMPLE_HTML = `
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo">
      Example &amp; Co
    </a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo">
    Example description with <b>bold</b> text.
  </a>
</div>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftwo.example%2Fbar">
      Second result
    </a>
  </h2>
  <a class="result__snippet">Snippet two</a>
</div>
`

function fetchOnce(status: number, body: string): typeof fetch {
  return vi.fn(async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'text/html' },
    }),
  ) as unknown as typeof fetch
}

describe('websearch tool', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects missing query', async () => {
    await expect(
      websearchTool.run({}, makeCtx('/tmp')),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('rejects empty query', async () => {
    await expect(
      websearchTool.run({ query: '   ' }, makeCtx('/tmp')),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('formats DuckDuckGo results with unwrapped URLs and cleaned snippets', async () => {
    globalThis.fetch = fetchOnce(200, SAMPLE_HTML)
    const out = await websearchTool.run(
      { query: 'test query' },
      makeCtx('/tmp'),
    )
    expect(out).toContain('Web search results for: test query')
    expect(out).toContain('1. Example & Co')
    expect(out).toContain('https://example.com/foo')
    expect(out).toContain('Example description with bold text.')
    expect(out).toContain('2. Second result')
    expect(out).toContain('https://two.example/bar')
  })

  it('respects limit', async () => {
    globalThis.fetch = fetchOnce(200, SAMPLE_HTML)
    const out = await websearchTool.run(
      { query: 'test', limit: 1 },
      makeCtx('/tmp'),
    )
    expect(out).toContain('1. Example & Co')
    expect(out).not.toContain('2. Second result')
  })

  it('caps limit at 10', async () => {
    let capturedUrl: string | undefined
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrl = String(url)
      return new Response(SAMPLE_HTML, { status: 200 })
    }) as unknown as typeof fetch
    await websearchTool.run({ query: 'x', limit: 999 }, makeCtx('/tmp'))
    expect(capturedUrl).toContain('q=x')
  })

  it('returns a friendly message when there are no results', async () => {
    globalThis.fetch = fetchOnce(200, '<html><body>nothing here</body></html>')
    const out = await websearchTool.run({ query: 'zzz' }, makeCtx('/tmp'))
    expect(out).toBe('No results for: zzz')
  })

  it('throws EHTTP on non-2xx response', async () => {
    globalThis.fetch = fetchOnce(503, 'gateway busy')
    await expect(
      websearchTool.run({ query: 'x' }, makeCtx('/tmp')),
    ).rejects.toMatchObject({ code: 'EHTTP' })
  })

  it('propagates cancellation from the context signal', async () => {
    const ac = new AbortController()
    globalThis.fetch = vi.fn(async (_url, init: RequestInit | undefined) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }) as unknown as typeof fetch
    const promise = websearchTool.run(
      { query: 'x' },
      makeCtx('/tmp', ac.signal),
    )
    ac.abort()
    await expect(promise).rejects.toMatchObject({ code: 'ECANCELED' })
  })

  it('truncates very long snippets', async () => {
    const longSnippet = 'x'.repeat(1200)
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example">Long</a>
      <a class="result__snippet">${longSnippet}</a>
    `
    const results = parseDuckDuckGoHtml(html, 5)
    expect(results).toHaveLength(1)
    expect(results[0].snippet.length).toBeLessThanOrEqual(501)
    expect(results[0].snippet.endsWith(' - ')).toBe(true)
  })

  it('drops results with unresolvable hrefs', async () => {
    const html = `
      <a class="result__a" href="javascript:void(0)">Bad</a>
      <a class="result__snippet">skip</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgood.example">Good</a>
      <a class="result__snippet">keep</a>
    `
    const results = parseDuckDuckGoHtml(html, 5)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://good.example')
  })
})

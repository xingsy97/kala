import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeCtx } from './_test-helpers.js'
import { ToolError } from './registry.js'
import { filterLowQualityResults, parseDuckDuckGoHtml, websearchTool } from './websearch.js'

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

function fetchSequence(responses: Array<{ status: number; body: string }>): typeof fetch {
  let i = 0
  return vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)]!
    i += 1
    return new Response(next.body, {
      status: next.status,
      headers: { 'Content-Type': 'text/html' },
    })
  }) as unknown as typeof fetch
}

describe('websearch tool', () => {
  const originalFetch = globalThis.fetch
  const originalSerperKey = process.env.SERPER_API_KEY

  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalSerperKey === undefined) delete process.env.SERPER_API_KEY
    else process.env.SERPER_API_KEY = originalSerperKey
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
    delete process.env.SERPER_API_KEY
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
    delete process.env.SERPER_API_KEY
    globalThis.fetch = fetchOnce(200, SAMPLE_HTML)
    const out = await websearchTool.run(
      { query: 'test', limit: 1 },
      makeCtx('/tmp'),
    )
    expect(out).toContain('1. Example & Co')
    expect(out).not.toContain('2. Second result')
  })

  it('caps limit at 10', async () => {
    delete process.env.SERPER_API_KEY
    let capturedUrl: string | undefined
    globalThis.fetch = vi.fn(async (url) => {
      capturedUrl = String(url)
      return new Response(SAMPLE_HTML, { status: 200 })
    }) as unknown as typeof fetch
    await websearchTool.run({ query: 'x', limit: 999 }, makeCtx('/tmp'))
    expect(capturedUrl).toContain('q=x')
  })

  it('returns a friendly message when there are no results', async () => {
    delete process.env.SERPER_API_KEY
    globalThis.fetch = fetchOnce(200, '<html><body>nothing here</body></html>')
    const out = await websearchTool.run({ query: 'zzz' }, makeCtx('/tmp'))
    expect(out).toBe('No results for: zzz')
  })

  it('falls back when one endpoint returns a landing page', async () => {
    delete process.env.SERPER_API_KEY
    globalThis.fetch = fetchSequence([
      { status: 202, body: '<html><head><link rel="canonical" href="https://duckduckgo.com/"></head><body></body></html>' },
      { status: 200, body: SAMPLE_HTML },
    ])
    const out = await websearchTool.run({ query: 'test query' }, makeCtx('/tmp'))
    expect(out).toContain('Example & Co')
  })

  it('parses DuckDuckGo lite result-link anchors', () => {
    const html = '<a rel="nofollow" href="https://example.com/lite" class="result-link">Lite Result</a>'
    const results = parseDuckDuckGoHtml(html, 5)
    expect(results).toEqual([{ title: 'Lite Result', url: 'https://example.com/lite', snippet: '' }])
  })

  it('throws EHTTP on non-2xx response', async () => {
    delete process.env.SERPER_API_KEY
    globalThis.fetch = fetchOnce(503, 'gateway busy')
    await expect(
      websearchTool.run({ query: 'x' }, makeCtx('/tmp')),
    ).rejects.toMatchObject({ code: 'EHTTP' })
  })

  it('propagates cancellation from the context signal', async () => {
    delete process.env.SERPER_API_KEY
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

  it('uses Serper when SERPER_API_KEY is configured', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = String(url)
      capturedInit = init
      return Response.json({
        organic: [
          { title: 'Serper Result', link: 'https://example.com/serper', snippet: 'Serper snippet' },
        ],
      })
    }) as unknown as typeof fetch
    const out = await websearchTool.run({ query: 'test query', limit: 2 }, makeCtx('/tmp'))
    expect(capturedUrl).toBe('https://google.serper.dev/search')
    expect(capturedInit?.method).toBe('POST')
    expect(capturedInit?.headers).toMatchObject({ 'X-API-KEY': 'test-key' })
    expect(capturedInit?.body).toBe(JSON.stringify({ q: 'test query', num: 2 }))
    expect(out).toContain('Serper Result')
    expect(out).toContain('https://example.com/serper')
  })

  it('filters question-mirroring SEO spam while keeping credible sources', async () => {
    const query = 'ALS thesis 2012 director National Academy of Sciences 2022 Fulbright scholar 2018'
    const filtered = filterLowQualityResults(query, [
      {
        title: 'fulbright scholar 2018 thesis director als',
        url: 'https://centresportifarthurnaze.be/local/live/5aunlxtixg',
        snippet: 'View 100 Fulbright Scholar 2018 Director Als Thesis Published In 2012 Who Was Selected To National Academy Of Sciences 2022 jobs',
      },
      {
        title: 'Dr. Example elected to the National Academy of Sciences',
        url: 'https://www.university.edu/news/example-nas-2022',
        snippet: 'A university announcement about an official faculty honor.',
      },
    ], 5)
    expect(filtered.dropped).toHaveLength(1)
    expect(filtered.results).toEqual([
      {
        title: 'Dr. Example elected to the National Academy of Sciences',
        url: 'https://www.university.edu/news/example-nas-2022',
        snippet: 'A university announcement about an official faculty honor.',
      },
    ])
  })

  it('filters crossword and future-dated scraper results', async () => {
    const filtered = filterLowQualityResults('Korean drama debuted in 2004 talent competition romance', [
      {
        title: 'korean drama 2004 debut actor 1990s talent competition winner',
        url: 'https://jkrkytiu9.bienenmuddi.de/',
        snippet: 'Answers for series aired 2000s protagonist fateful encounter romance, 5 letters.',
      },
      {
        title: 'Air City - AsianWiki',
        url: 'https://asianwiki.com/Air_City',
        snippet: 'Cast and details for the Korean television drama.',
      },
    ], 5)
    expect(filtered.dropped).toHaveLength(1)
    expect(filtered.results[0]?.title).toBe('Air City - AsianWiki')
  })

  it('reports filtered suspicious Serper results to the caller', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    globalThis.fetch = vi.fn(async () => Response.json({
      organic: [
        {
          title: 'fulbright scholar 2018 thesis director als',
          link: 'https://centresportifarthurnaze.be/local/live/5aunlxtixg',
          snippet: 'View 100 Fulbright Scholar 2018 Director Als Thesis Published In 2012 Who Was Selected To National Academy Of Sciences 2022 jobs',
        },
        {
          title: 'Official University Profile',
          link: 'https://www.example.edu/faculty/profile',
          snippet: 'A faculty profile from an institutional source.',
        },
      ],
    })) as unknown as typeof fetch
    const out = await websearchTool.run({ query: 'ALS thesis 2012 director National Academy of Sciences 2022 Fulbright scholar 2018' }, makeCtx('/tmp'))
    expect(out).toContain('Official University Profile')
    expect(out).not.toContain('centresportifarthurnaze')
    expect(out).toContain('[filtered 1 suspicious low-quality result(s)]')
  })

  it('throws EHTTP when Serper returns an error', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    globalThis.fetch = vi.fn(async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch
    await expect(
      websearchTool.run({ query: 'x' }, makeCtx('/tmp')),
    ).rejects.toMatchObject({ code: 'EHTTP' })
  })

  it('truncates very long snippets', async () => {
    const longSnippet = 'x'.repeat(1200)
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example">Long</a>
      <a class="result__snippet">${longSnippet}</a>
    `
    const results = parseDuckDuckGoHtml(html, 5)
    expect(results).toHaveLength(1)
    expect(results[0].snippet.length).toBeLessThanOrEqual(500)
    expect(results[0].snippet.endsWith('...')).toBe(true)
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

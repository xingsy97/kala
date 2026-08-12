import { describe, expect, it, vi } from 'vitest'

import { runWebSearch, type WebSearchCredentialStore } from './index.js'

const credentials: WebSearchCredentialStore = { get: () => 'test-key' }

describe('host web search', () => {
  it('uses the injected Serper credential and formats results', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      organic: [{ title: 'Primary source', link: 'https://example.test/source', snippet: 'Details' }],
    })) as unknown as typeof fetch

    const result = await runWebSearch({ query: 'current docs', limit: 2 }, { credentials, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith('https://google.serper.dev/search', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-API-KEY': 'test-key' }),
      body: JSON.stringify({ q: 'current docs', num: 2 }),
    }))
    expect(result).toEqual({
      ok: true,
      content: 'Web search results for: current docs\n\n1. Primary source\n   https://example.test/source\n   Details',
    })
  })

  it('fails without a configured credential and does not fall back', async () => {
    const fetchImpl = vi.fn()
    const result = await runWebSearch({ query: 'query' }, {
      credentials: { get: () => undefined },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, failure: { code: 'ESEARCH_CREDENTIAL', outcome: 'blocked' } })
  })

  it('does not fall back when Serper fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch

    const result = await runWebSearch({ query: 'query' }, { credentials, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, failure: { code: 'EHTTP', responsibility: 'provider' } })
  })

  it('caps the requested limit and truncates long snippets', async () => {
    const fetchImpl = vi.fn(async (_url, init) => Response.json({
      organic: [{ title: 'Result', link: 'https://example.test', snippet: 'x'.repeat(700) }],
    })) as unknown as typeof fetch
    const result = await runWebSearch({ query: 'query', limit: 100 }, { credentials, fetchImpl })

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ q: 'query', num: 10 })
    expect(result.content.length).toBeLessThan(600)
    expect(result.content.endsWith('...')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import { fetchHuggingFaceRows } from './hf-datasets-server.js'

describe('fetchHuggingFaceRows', () => {
  it('paginates through datasets-server responses until the limit is reached', async () => {
    const capturedOffsets: number[] = []
    const fakeFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const params = new URL(url).searchParams
      const offset = Number(params.get('offset') ?? '0')
      const length = Number(params.get('length') ?? '100')
      capturedOffsets.push(offset)
      const total = 250
      const start = offset
      const end = Math.min(offset + length, total)
      const rows = []
      for (let i = start; i < end; i++) rows.push({ row_idx: i, row: { instance_id: `i-${i}` } })
      return new Response(JSON.stringify({ rows, num_rows_total: total }), { status: 200 })
    }

    const result = await fetchHuggingFaceRows({
      datasetRef: 'princeton-nlp/SWE-bench_Lite',
      baseUrl: 'http://private-2.example.com',
      fetchImpl: fakeFetch,
      limit: 250,
    })

    expect(result.rows).toHaveLength(250)
    expect(result.requestCount).toBe(3)
    expect(capturedOffsets).toEqual([0, 100, 200])
    expect(result.rows[0]).toMatchObject({ instance_id: 'i-0' })
    expect(result.rows[249]).toMatchObject({ instance_id: 'i-249' })
    expect(result.totalRows).toBe(250)
  })

  it('stops early when the caller-provided limit is smaller than one page', async () => {
    let requests = 0
    const fakeFetch: typeof fetch = async (input) => {
      requests++
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const params = new URL(url).searchParams
      const length = Number(params.get('length') ?? '100')
      const rows = Array.from({ length }, (_, i) => ({ row_idx: i, row: { instance_id: `x-${i}` } }))
      return new Response(JSON.stringify({ rows, num_rows_total: 1000 }), { status: 200 })
    }

    const result = await fetchHuggingFaceRows({
      datasetRef: 'org/ds',
      baseUrl: 'http://private-2.example.com',
      fetchImpl: fakeFetch,
      limit: 3,
    })

    expect(result.rows).toHaveLength(3)
    expect(requests).toBe(1)
  })

  it('retries on 429 with exponential backoff and eventually succeeds', async () => {
    let attempts = 0
    const retryReasons: string[] = []
    const fakeFetch: typeof fetch = async () => {
      attempts++
      if (attempts <= 2) {
        return new Response('rate limited', { status: 429, headers: { 'RateLimit': 't=0' } })
      }
      return new Response(
        JSON.stringify({ rows: [{ row_idx: 0, row: { instance_id: 'z' } }], num_rows_total: 1 }),
        { status: 200 },
      )
    }

    const result = await fetchHuggingFaceRows({
      datasetRef: 'org/ds',
      baseUrl: 'http://private-2.example.com',
      fetchImpl: fakeFetch,
      retries: 3,
      onRetry: (attempt, reason) => retryReasons.push(`${attempt}:${reason}`),
    })

    expect(result.rows).toHaveLength(1)
    expect(attempts).toBe(3)
    expect(retryReasons.length).toBe(2)
    expect(retryReasons[0]).toMatch(/status 429/)
  })

  it('gives up after exhausting retries', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('nope', { status: 429, headers: { 'RateLimit': 't=0' } })

    await expect(
      fetchHuggingFaceRows({
        datasetRef: 'org/ds',
        baseUrl: 'http://private-2.example.com',
        fetchImpl: fakeFetch,
        retries: 1,
      }),
    ).rejects.toThrow(/429/)
  })

  it('propagates a 4xx non-retriable error immediately', async () => {
    let attempts = 0
    const fakeFetch: typeof fetch = async () => {
      attempts++
      return new Response('not found', { status: 404 })
    }

    await expect(
      fetchHuggingFaceRows({
        datasetRef: 'org/missing',
        baseUrl: 'http://private-2.example.com',
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/404/)
    expect(attempts).toBe(1)
  })

  it('sends a bearer token when hfToken is supplied', async () => {
    let capturedAuth: string | null = null
    const fakeFetch: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers ?? {})
      capturedAuth = headers.get('authorization')
      return new Response(
        JSON.stringify({ rows: [{ row_idx: 0, row: { instance_id: 'w' } }], num_rows_total: 1 }),
        { status: 200 },
      )
    }

    await fetchHuggingFaceRows({
      datasetRef: 'org/private',
      baseUrl: 'http://private-2.example.com',
      fetchImpl: fakeFetch,
      hfToken: 'hf_ABCDEF',
    })

    expect(capturedAuth).toBe('Bearer hf_ABCDEF')
  })
})

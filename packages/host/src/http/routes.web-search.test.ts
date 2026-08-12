import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { attachJsonRoutes } from './routes.js'
import type { WebSearchCredentialStatus } from '../web-search/credential-store.js'

const TEST_KEY = 'route-test-credential'
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('web search settings routes', () => {
  it('supports credential CRUD without returning the key', async () => {
    let key: string | undefined
    let updatedAt: string | undefined
    const credentials = {
      get: () => key,
      status: (): WebSearchCredentialStatus => key ? { configured: true, provider: 'serper', updatedAt } : { configured: false, provider: 'serper' },
      set: (_provider: 'serper', next: string): WebSearchCredentialStatus => {
        key = next
        updatedAt = '2026-01-01T00:00:00.000Z'
        return { configured: true, provider: 'serper', updatedAt }
      },
      delete: (): WebSearchCredentialStatus => {
        key = undefined
        updatedAt = undefined
        return { configured: false, provider: 'serper' }
      },
    }
    const baseUrl = await startRoutes(credentials)

    const initial = await fetch(`${baseUrl}/settings/web-search`)
    expect(initial.headers.get('cache-control')).toBe('no-store')
    expect(await initial.json()).toEqual({ configured: false, provider: 'serper' })

    const put = await fetch(`${baseUrl}/settings/web-search`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'serper', apiKey: TEST_KEY }),
    })
    const putText = await put.text()
    expect(put.status).toBe(200)
    expect(putText).not.toContain(TEST_KEY)
    expect(JSON.parse(putText)).toMatchObject({ configured: true, provider: 'serper' })

    const invalid = await fetch(`${baseUrl}/settings/web-search`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'other', apiKey: TEST_KEY }),
    })
    expect(invalid.status).toBe(400)

    const removed = await fetch(`${baseUrl}/settings/web-search`, { method: 'DELETE' })
    expect(await removed.json()).toEqual({ configured: false, provider: 'serper' })
  })

  it('tests the stored credential through Serper and never exposes it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-API-KEY')).toBe(TEST_KEY)
      return Response.json({ organic: [{ title: 'Result', link: 'https://example.test' }] })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const baseUrl = await startRoutes({
      get: () => TEST_KEY,
      status: () => ({ configured: true, provider: 'serper' as const }),
      set: () => ({ configured: true, provider: 'serper' as const }),
      delete: () => ({ configured: false, provider: 'serper' as const }),
    })

    const response = await originalFetch(`${baseUrl}/settings/web-search/test`, { method: 'POST' })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).toBe('{"ok":true}')
    expect(text).not.toContain(TEST_KEY)
  })
})

const originalFetch = globalThis.fetch

async function startRoutes(credentials: Parameters<typeof attachJsonRoutes>[1]['webSearchCredentials']): Promise<string> {
  const server = createServer()
  servers.push(server)
  attachJsonRoutes(server, { models: [], defaultModel: '', webSearchCredentials: credentials })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

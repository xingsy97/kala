import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { artifactRequest } from './artifact-client.js'
import { useArtifactManifest } from './useArtifactManifest.js'

vi.mock('./artifact-client.js', () => ({ artifactRequest: vi.fn() }))

const requestMock = vi.mocked(artifactRequest)

describe('useArtifactManifest', () => {
  beforeEach(() => requestMock.mockReset())

  it('requests filtered pages and appends the next page only on demand', async () => {
    requestMock
      .mockResolvedValueOnce(response({
        entries: [{ path: 'a.json', kind: 'trace', mediaType: 'application/json', bytes: 2, mtime: '2026-01-01T00:00:00.000Z' }],
        page: { limit: 1, returnedEntries: 1, totalEntries: 2, hasMore: true, nextCursor: 'next-page', snapshotId: 'snapshot-1' },
      }))
      .mockResolvedValueOnce(response({
        entries: [{ path: 'b.json', kind: 'trace', mediaType: 'application/json', bytes: 2, mtime: '2026-01-01T00:00:00.000Z' }],
        page: { limit: 1, returnedEntries: 1, totalEntries: 2, hasMore: false, snapshotId: 'snapshot-1' },
      }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useArtifactManifest({ kinds: ['trace'], pageSize: 1 }), { wrapper })

    await waitFor(() => expect(result.current.manifest?.entries.map((entry) => entry.path)).toEqual(['a.json']))
    expect(requestMock.mock.calls[0]?.[0]).toContain('limit=1')
    expect(requestMock.mock.calls[0]?.[0]).toContain('kind=trace')
    expect(result.current.hasMore).toBe(true)

    await act(async () => result.current.loadMore())
    await waitFor(() => expect(result.current.manifest?.entries.map((entry) => entry.path)).toEqual(['a.json', 'b.json']))
    expect(requestMock.mock.calls[1]?.[0]).toContain('cursor=next-page')
    expect(result.current.hasMore).toBe(false)
  })
})

function response(input: { entries: unknown[]; page: Record<string, unknown> }): Response {
  return new Response(JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    rootDir: '/redacted',
    entries: input.entries,
    summary: { entryCount: 2, totalBytes: 4, hashedCount: 2, hashSkippedCount: 0, kinds: { trace: 2 } },
    page: input.page,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

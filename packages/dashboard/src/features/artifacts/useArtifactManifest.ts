import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef } from 'react'

import type { ArtifactManifest } from './product-artifact-views.js'
import { artifactRequest } from './artifact-client.js'

export type ManifestState = {
  manifest: ArtifactManifest | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore(): void
  reload(): void
  reloadToken: number
}

export const ARTIFACT_MANIFEST_QUERY_KEY = ['artifact-manifest'] as const

type ManifestOptions = { kinds?: readonly string[]; pageSize?: number }

async function fetchArtifactManifest(input: { cursor?: string; kinds: readonly string[]; pageSize: number; refresh?: boolean }): Promise<ArtifactManifest | null> {
  const params = new URLSearchParams({ limit: String(input.pageSize) })
  for (const kind of input.kinds) params.append('kind', kind)
  if (input.cursor) params.set('cursor', input.cursor)
  if (input.refresh) params.set('refresh', '1')
  const res = await artifactRequest(`/artifacts/manifest?${params.toString()}`, { cache: 'no-store' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (isMissingArtifactDirectory(res.status, body?.error)) return emptyManifest()
    throw new Error(body?.error ?? `artifact manifest request failed: ${res.status}`)
  }
  const next = (await res.json()) as ArtifactManifest
  if (!next || typeof next !== 'object' || !('summary' in next) || !('entries' in next)) return null
  return next
}

function isMissingArtifactDirectory(status: number, message: string | undefined): boolean {
  if (status === 404 && (message?.includes('artifact not found') || message?.includes('artifact capture is not configured'))) return true
  if (!message) return false
  return message.includes('ENOENT') && message.includes('scandir')
}

function emptyManifest(): ArtifactManifest {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    rootDir: '',
    entries: [],
    summary: { entryCount: 0, totalBytes: 0, hashedCount: 0, hashSkippedCount: 0, kinds: {} },
    page: { limit: 100, returnedEntries: 0, totalEntries: 0, hasMore: false, snapshotId: 'empty' },
  }
}

export function useArtifactManifest(options: ManifestOptions = {}): ManifestState {
  const client = useQueryClient()
  const refreshRequested = useRef(false)
  const kindsKey = [...new Set(options.kinds ?? [])].sort().join(',')
  const kinds = useMemo(() => kindsKey ? kindsKey.split(',') : [], [kindsKey])
  const pageSize = options.pageSize ?? 100
  const queryKey = [...ARTIFACT_MANIFEST_QUERY_KEY, kindsKey, pageSize] as const
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const refresh = pageParam === undefined && refreshRequested.current
      refreshRequested.current = false
      return fetchArtifactManifest({ cursor: pageParam, kinds, pageSize, refresh })
    },
    getNextPageParam: (lastPage) => lastPage?.page?.hasMore ? lastPage.page.nextCursor : undefined,
    staleTime: 15_000,
  })

  const manifest = useMemo(() => {
    const pages = query.data?.pages.filter((page): page is ArtifactManifest => page !== null) ?? []
    const first = pages[0]
    const last = pages.at(-1)
    if (!first || !last) return null
    return { ...first, entries: pages.flatMap((page) => page.entries), page: last.page }
  }, [query.data])

  return useMemo(() => ({
    manifest,
    loading: query.isLoading,
    loadingMore: query.isFetchingNextPage,
    error: query.error ? (query.error as Error).message : null,
    hasMore: Boolean(query.hasNextPage),
    loadMore: () => { void query.fetchNextPage() },
    reload: () => {
      refreshRequested.current = true
      void client.resetQueries({ queryKey, exact: true })
    },
    reloadToken: query.dataUpdatedAt,
  }), [manifest, query.isLoading, query.isFetchingNextPage, query.error, query.hasNextPage, query.fetchNextPage, query.dataUpdatedAt, client, queryKey])
}

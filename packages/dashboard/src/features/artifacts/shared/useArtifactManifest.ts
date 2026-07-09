import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'

import type { ArtifactManifest } from './internals.js'

export type ManifestState = {
  manifest: ArtifactManifest | null
  loading: boolean
  error: string | null
  reload(): void
  reloadToken: number
}

export const ARTIFACT_MANIFEST_QUERY_KEY = ['artifact-manifest'] as const

async function fetchArtifactManifest(): Promise<ArtifactManifest | null> {
  const res = await fetch('/artifacts/manifest', { cache: 'no-store' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `artifact manifest request failed: ${res.status}`)
  }
  const next = (await res.json()) as ArtifactManifest
  if (!next || typeof next !== 'object' || !('summary' in next) || !('entries' in next)) {
    return null
  }
  return next
}

export function useArtifactManifest(): ManifestState {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ARTIFACT_MANIFEST_QUERY_KEY,
    queryFn: fetchArtifactManifest,
    staleTime: 15_000,
  })

  return useMemo(
    () => ({
      manifest: query.data ?? null,
      loading: query.isLoading || query.isFetching,
      error: query.error ? (query.error as Error).message : null,
      reload: () => {
        void client.invalidateQueries({ queryKey: ARTIFACT_MANIFEST_QUERY_KEY })
      },
      reloadToken: query.dataUpdatedAt,
    }),
    [
      query.data,
      query.isLoading,
      query.isFetching,
      query.error,
      query.dataUpdatedAt,
      client,
    ],
  )
}

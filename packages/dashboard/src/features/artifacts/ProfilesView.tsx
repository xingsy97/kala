import { useEffect, useState } from 'react'

import {
  ProfilesView as ProfilesViewInternal,
  fetchArtifactContent,
  type ProfileRow,
  type SessionProfile,
} from './product-artifact-views.js'
import { useArtifactManifest } from './useArtifactManifest.js'
import { mapWithConcurrency } from './concurrency.js'

const ARTIFACT_FETCH_CONCURRENCY = 6

export function ProfilesView({ onOpenSession }: { onOpenSession?(sessionId: string): void } = {}): JSX.Element {
  const { manifest, loading, loadingMore, error, reload, reloadToken, hasMore, loadMore } = useArtifactManifest({ kinds: ['profile'], pageSize: 50 })
  const [rows, setRows] = useState<readonly ProfileRow[]>([])
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)

  useEffect(() => {
    if (!manifest) return
    const profiles = manifest.entries.filter((entry) => entry.kind === 'profile' || entry.path.endsWith('/profile.json'))
    let cancelled = false
    setRowsError(null)
    setRowsLoading(true)
    void mapWithConcurrency(profiles, ARTIFACT_FETCH_CONCURRENCY, async (entry): Promise<ProfileRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, profile: content.body as SessionProfile }
    })
      .then((next) => {
        if (!cancelled) setRows(next.sort((a, b) => a.path.localeCompare(b.path)))
      })
      .catch((err: unknown) => {
        if (!cancelled) setRowsError(err instanceof Error ? err.message : String(err))
      }).finally(() => {
        if (!cancelled) setRowsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [manifest, reloadToken])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="artifact-inline-panel-profiles">
      <ProfilesViewInternal
        manifest={manifest}
        rows={rows}
        error={error ?? rowsError}
        loading={loading || rowsLoading}
        loadingMore={loadingMore}
        hasMore={hasMore}
        onLoadMore={loadMore}
        onArtifactActionComplete={reload}
        onOpenSession={onOpenSession}
      />
    </div>
  )
}

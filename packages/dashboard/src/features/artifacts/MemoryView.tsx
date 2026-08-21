import { useEffect, useState } from 'react'

import {
  MemoryView as MemoryViewInternal,
  fetchArtifactContent,
  type MemoryIndex,
  type MemoryIndexRow,
} from './product-artifact-views.js'
import { useArtifactManifest } from './useArtifactManifest.js'
import { mapWithConcurrency } from './concurrency.js'

const ARTIFACT_FETCH_CONCURRENCY = 6

export function MemoryView({ onOpenSession }: { onOpenSession?(sessionId: string): void } = {}): JSX.Element {
  const { manifest, loading, loadingMore, error, reload, reloadToken, hasMore, loadMore } = useArtifactManifest({ kinds: ['memory_index'], pageSize: 50 })
  const [rows, setRows] = useState<readonly MemoryIndexRow[]>([])
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)

  useEffect(() => {
    if (!manifest) return
    const indexes = manifest.entries.filter((entry) => entry.kind === 'memory_index' || entry.path.endsWith('/memory-index.json'))
    let cancelled = false
    setRowsError(null)
    setRowsLoading(true)
    void mapWithConcurrency(indexes, ARTIFACT_FETCH_CONCURRENCY, async (entry): Promise<MemoryIndexRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, index: content.body as MemoryIndex }
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
    <div className="flex h-full min-h-0 flex-col" data-testid="artifact-inline-panel-memory">
      <MemoryViewInternal
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

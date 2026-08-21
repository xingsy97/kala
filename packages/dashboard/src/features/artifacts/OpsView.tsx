import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  OpsView as OpsViewInternal,
  ArtifactContentDialog,
  fetchArtifactContent,
  type ArtifactDetailRequest,
  type OpsArtifactKind,
  type OpsArtifactRow,
} from './product-artifact-views.js'
import { asRecord, isOpsArtifactKind, OPS_ARTIFACT_KINDS, opsKindOrder } from './artifact-model.js'
import { useArtifactManifest } from './useArtifactManifest.js'
import { mapWithConcurrency } from './concurrency.js'

const ARTIFACT_FETCH_CONCURRENCY = 6

export function OpsView({ onOpenSession }: { onOpenSession?(sessionId: string): void } = {}): JSX.Element {
  const { t } = useTranslation()
  const { manifest, loading, loadingMore, error, reload, reloadToken, hasMore, loadMore } = useArtifactManifest({ kinds: OPS_ARTIFACT_KINDS, pageSize: 25 })
  const [rows, setRows] = useState<readonly OpsArtifactRow[]>([])
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetailRequest | null>(null)

  useEffect(() => {
    if (!manifest) return
    const entries = manifest.entries.filter((entry) => isOpsArtifactKind(entry.kind))
    let cancelled = false
    setRowsError(null)
    setRowsLoading(true)
    void mapWithConcurrency(entries, ARTIFACT_FETCH_CONCURRENCY, async (entry): Promise<{ row?: OpsArtifactRow; error?: string }> => {
      try {
        const content = await fetchArtifactContent(entry.path)
        return { row: { path: entry.path, kind: entry.kind as OpsArtifactKind, body: asRecord(content.body) } }
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    })
      .then((results) => {
        if (cancelled) return
        const next = results.flatMap((result) => result.row ? [result.row] : [])
        const failures = results.filter((result) => result.error).length
        setRows(next.sort((a, b) => opsKindOrder(a.kind) - opsKindOrder(b.kind) || a.path.localeCompare(b.path)))
        if (failures > 0) setRowsError(t('artifacts.ops.partialLoadFailed', { count: failures }))
      })
      .catch((err: unknown) => {
        if (!cancelled) setRowsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [manifest, reloadToken, t])

  return (
    <>
      <div className="flex h-full min-h-0 flex-col" data-testid="artifact-inline-panel-ops">
        <OpsViewInternal
          manifest={manifest}
          rows={rows}
          error={error ?? rowsError}
          loading={loading || rowsLoading}
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onOpenArtifact={setArtifactDetail}
          onArtifactActionComplete={reload}
        />
      </div>
      <ArtifactContentDialog request={artifactDetail} onOpenChange={(nextOpen) => !nextOpen && setArtifactDetail(null)} onOpenSession={onOpenSession} />
    </>
  )
}

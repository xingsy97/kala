import { useEffect, useState } from 'react'

import {
  OpsView as OpsViewInternal,
  ArtifactContentDialog,
  fetchArtifactContent,
  isOpsArtifactKind,
  opsKindOrder,
  asRecord,
  type ArtifactDetailRequest,
  type OpsArtifactKind,
  type OpsArtifactRow,
} from './shared/internals.js'
import { useArtifactManifest } from './shared/useArtifactManifest.js'

export function OpsView(): JSX.Element {
  const { manifest, loading, error, reload, reloadToken } = useArtifactManifest()
  const [rows, setRows] = useState<readonly OpsArtifactRow[]>([])
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetailRequest | null>(null)

  useEffect(() => {
    if (!manifest) return
    const entries = manifest.entries.filter((entry) => isOpsArtifactKind(entry.kind))
    let cancelled = false
    setRowsError(null)
    setRows([])
    void Promise.all(entries.map(async (entry): Promise<OpsArtifactRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, kind: entry.kind as OpsArtifactKind, body: asRecord(content.body) }
    }))
      .then((next) => {
        if (!cancelled) setRows(next.sort((a, b) => opsKindOrder(a.kind) - opsKindOrder(b.kind) || a.path.localeCompare(b.path)))
      })
      .catch((err: unknown) => {
        if (!cancelled) setRowsError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [manifest, reloadToken])

  return (
    <>
      <div className="flex h-full min-h-0 flex-col" data-testid="artifact-inline-panel-ops">
        <OpsViewInternal
          manifest={manifest}
          rows={rows}
          error={error ?? rowsError}
          loading={loading}
          onOpenArtifact={setArtifactDetail}
          onArtifactActionComplete={reload}
        />
      </div>
      <ArtifactContentDialog request={artifactDetail} onOpenChange={(nextOpen) => !nextOpen && setArtifactDetail(null)} />
    </>
  )
}

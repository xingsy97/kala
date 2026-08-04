import { useMemo, useState } from 'react'

import { ArtifactContentDialog, ArtifactInventory, type ArtifactDetailRequest } from './product-artifact-views.js'
import { useArtifactManifest } from './useArtifactManifest.js'

export function ArtifactInventoryView({ onOpenSession }: { onOpenSession?(sessionId: string): void } = {}): JSX.Element {
  const { manifest, loading, error } = useArtifactManifest()
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetailRequest | null>(null)
  const kindRows = useMemo(() => {
    if (!manifest || !manifest.summary) return [] as [string, number][]
    return Object.entries(manifest.summary.kinds).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [manifest])
  return (
    <>
      <div className="flex h-full min-h-0 flex-col" data-testid="artifact-inline-panel-artifacts">
        <ArtifactInventory manifest={manifest} kindRows={kindRows} error={error} loading={loading} onOpenArtifact={setArtifactDetail} />
      </div>
      <ArtifactContentDialog request={artifactDetail} onOpenChange={(open) => !open && setArtifactDetail(null)} onOpenSession={onOpenSession} />
    </>
  )
}

import { useMemo } from 'react'

import { ArtifactInventory } from './shared/internals.js'
import { useArtifactManifest } from './shared/useArtifactManifest.js'

export function ArtifactInventoryView(): JSX.Element {
  const { manifest, loading, error } = useArtifactManifest()
  const kindRows = useMemo(() => {
    if (!manifest || !manifest.summary) return [] as [string, number][]
    return Object.entries(manifest.summary.kinds).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [manifest])
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="artifact-inline-panel-artifacts">
      <ArtifactInventory manifest={manifest} kindRows={kindRows} error={error} loading={loading} />
    </div>
  )
}

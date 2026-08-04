import { useEffect, useState } from 'react'

import {
  ProfilesView as ProfilesViewInternal,
  fetchArtifactContent,
  type ProfileRow,
  type SessionProfile,
} from './product-artifact-views.js'
import { useArtifactManifest } from './useArtifactManifest.js'

export function ProfilesView(): JSX.Element {
  const { manifest, loading, error, reload, reloadToken } = useArtifactManifest()
  const [rows, setRows] = useState<readonly ProfileRow[]>([])
  const [rowsError, setRowsError] = useState<string | null>(null)

  useEffect(() => {
    if (!manifest) return
    const profiles = manifest.entries.filter((entry) => entry.kind === 'profile' || entry.path.endsWith('/profile.json'))
    let cancelled = false
    setRowsError(null)
    setRows([])
    void Promise.all(profiles.map(async (entry): Promise<ProfileRow> => {
      const content = await fetchArtifactContent(entry.path)
      return { path: entry.path, profile: content.body as SessionProfile }
    }))
      .then((next) => {
        if (!cancelled) setRows(next.sort((a, b) => a.path.localeCompare(b.path)))
      })
      .catch((err: unknown) => {
        if (!cancelled) setRowsError(err instanceof Error ? err.message : String(err))
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
        loading={loading}
        onArtifactActionComplete={reload}
      />
    </div>
  )
}

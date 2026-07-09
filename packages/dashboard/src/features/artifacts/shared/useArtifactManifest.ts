import { useEffect, useState } from 'react'

import type { ArtifactManifest } from './internals.js'

export type ManifestState = {
  manifest: ArtifactManifest | null
  loading: boolean
  error: string | null
  reload(): void
  reloadToken: number
}

export function useArtifactManifest(): ManifestState {
  const [manifest, setManifest] = useState<ArtifactManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void fetch('/artifacts/manifest', { cache: 'no-store' })
      .then(async (res) => {
        if (res.ok) return (await res.json()) as ArtifactManifest
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `artifact manifest request failed: ${res.status}`)
      })
      .then((next) => {
        if (cancelled) return
        if (!next || typeof next !== 'object' || !('summary' in next) || !('entries' in next)) {
          // Ignore stray responses (e.g. shared fetch mocks that return artifact-content payloads).
          return
        }
        setManifest(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setManifest(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  return {
    manifest,
    loading,
    error,
    reload: () => setReloadToken((token) => token + 1),
    reloadToken,
  }
}

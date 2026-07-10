/**
 * Top-level nav for the dashboard. Five tabs, URL-hash routing.
 *
 * Deep-link contract (per principle C4):
 * - `#/agent`, `#/benchmarks`, `#/operations`, `#/artifacts`, `#/settings`
 * - default (empty hash) resolves to `#/agent`
 * - back/forward and refresh restore the same section
 *
 * Phase-1 scope: the tab bar is a router only. Agent stays in the current
 * layout; the other four tabs open the existing surfaces (ArtifactExplorer
 * modes, SettingsDialog) as a bridge. Phase-2 replaces them with real pages.
 */

import { useEffect, useState } from 'react'

export type AppSection = 'agent' | 'benchmarks' | 'operations' | 'artifacts' | 'settings'

const SECTIONS: readonly AppSection[] = ['agent', 'benchmarks', 'operations', 'artifacts', 'settings']

function parseHash(hash: string): AppSection {
  const cleaned = hash.replace(/^#\/?/, '').split('/')[0]?.toLowerCase() ?? ''
  return (SECTIONS as readonly string[]).includes(cleaned) ? (cleaned as AppSection) : 'agent'
}

export function useAppSection(): [AppSection, (next: AppSection) => void] {
  const [section, setSection] = useState<AppSection>(() =>
    typeof window === 'undefined' ? 'agent' : parseHash(window.location.hash),
  )
  useEffect(() => {
    const onHash = (): void => setSection(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const go = (next: AppSection): void => {
    if (typeof window === 'undefined') {
      setSection(next)
      return
    }
    const target = `#/${next}`
    if (window.location.hash === target) return
    window.location.hash = target
  }
  return [section, go]
}

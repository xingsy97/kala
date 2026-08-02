/**
 * Top-level nav for the dashboard. URL-hash routing.
 *
 * Deep-link contract (per principle C4):
 * - `#/agent`, `#/benchmarks`, `#/operations`, `#/artifacts`, `#/pipeline`, `#/docs`
 * - default (empty hash) resolves to `#/agent`
 * - back/forward and refresh restore the same section
 *
 * Phase-1 scope: the tab bar is a router only. Agent stays in the current
 * layout; the other four tabs open the existing surfaces (ArtifactExplorer
 * modes, PipelineGuideDialog) as a bridge. Phase-2 replaces them with real
 * pages. Settings is not a tab — it lives as an icon on the right of the nav.
 */

import type { RuntimeCapabilities } from '@agent-kernel/shared'
import { useEffect, useState } from 'react'

export type AppSection = 'agent' | 'benchmarks' | 'operations' | 'artifacts' | 'pipeline' | 'docs' | 'memo'

const SECTIONS: readonly AppSection[] = ['agent', 'benchmarks', 'operations', 'artifacts', 'pipeline', 'docs', 'memo']

function parseHash(hash: string): AppSection {
  const cleaned = hash.replace(/^#\/?/, '').split('/')[0]?.toLowerCase() ?? ''
  return (SECTIONS as readonly string[]).includes(cleaned) ? (cleaned as AppSection) : 'agent'
}

export function isSectionEnabled(section: AppSection, capabilities?: RuntimeCapabilities): boolean {
  if (section === 'benchmarks') return capabilities?.benchmarks ?? true
  return true
}

export function useAppSection(capabilities?: RuntimeCapabilities): [AppSection, (next: AppSection) => void] {
  const enabledSection = (hash: string): AppSection => {
    const parsed = parseHash(hash)
    return isSectionEnabled(parsed, capabilities) ? parsed : 'agent'
  }
  const [section, setSection] = useState<AppSection>(() =>
    typeof window === 'undefined' ? 'agent' : enabledSection(window.location.hash),
  )
  useEffect(() => {
    const onHash = (): void => {
      const next = enabledSection(window.location.hash)
      setSection(next)
      if (next === 'agent' && parseHash(window.location.hash) !== 'agent') {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/agent`)
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [capabilities?.benchmarks])
  useEffect(() => {
    if (isSectionEnabled(section, capabilities)) return
    setSection('agent')
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/agent`)
  }, [capabilities, section])
  const go = (next: AppSection): void => {
    if (!isSectionEnabled(next, capabilities)) next = 'agent'
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

/**
 * Extract a session id from a `#/sessions/<id>` deep-link hash, or null.
 * Used by notification deep-links (Web Push URL `/#/sessions/<id>`), both for a
 * cold-start (openWindow with the hash) and a focused tab (the SW posts
 * PUSH_NAVIGATE which sets the hash → hashchange).
 */
export function parseSessionDeepLink(hash: string): string | null {
  const cleaned = hash.replace(/^#\/?/, '')
  const parts = cleaned.split('/')
  if (parts[0]?.toLowerCase() !== 'sessions') return null
  const id = parts[1]
  return id && id.length > 0 ? decodeURIComponent(id) : null
}

/**
 * Route a `#/sessions/<id>` deep-link to the given session selector on load and
 * on hashchange, then normalise the hash to `#/agent` so the same link doesn't
 * re-fire and so the section router settles on the agent surface.
 */
export function useSessionDeepLink(onSelect: (sessionId: string) => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const apply = (): void => {
      const sessionId = parseSessionDeepLink(window.location.hash)
      if (!sessionId) return
      onSelect(sessionId)
      // Replace the hash without adding a history entry or re-triggering us.
      const url = `${window.location.pathname}${window.location.search}#/agent`
      window.history.replaceState(null, '', url)
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [onSelect])
}

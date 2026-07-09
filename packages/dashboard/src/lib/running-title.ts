import { useEffect } from 'react'

const FAVICON_FRAMES = [0, 1, 2, 3] as const
const FAVICON_INTERVAL_MS = 500

export const DASHBOARD_TITLE = 'Agent RunLab'

export function useRunningTitleIndicator(isRunning: boolean, baseTitle = DASHBOARD_TITLE): void {
  useEffect(() => {
    if (!isRunning) {
      document.title = baseTitle
      return
    }

    let frame = 0
    const favicon = getOrCreateFaviconLink()
    const previousHref = favicon.getAttribute('href')
    document.title = baseTitle

    const render = (): void => {
      favicon.href = renderRunningFavicon(FAVICON_FRAMES[frame]!)
      frame = (frame + 1) % FAVICON_FRAMES.length
    }
    render()
    const interval = window.setInterval(render, FAVICON_INTERVAL_MS)
    return () => {
      window.clearInterval(interval)
      document.title = baseTitle
      if (previousHref) favicon.href = previousHref
      else favicon.remove()
    }
  }, [baseTitle, isRunning])
}

function getOrCreateFaviconLink(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (existing) return existing
  const link = document.createElement('link')
  link.rel = 'icon'
  link.href = '/favicon.svg'
  document.head.appendChild(link)
  return link
}

function renderRunningFavicon(frame: number): string {
  const arc = [
    '<path d="M32 8a24 24 0 0 1 24 24" stroke="#22c55e" stroke-width="12" stroke-linecap="round" fill="none"/>',
    '<path d="M56 32a24 24 0 0 1-24 24" stroke="#22c55e" stroke-width="12" stroke-linecap="round" fill="none"/>',
    '<path d="M32 56A24 24 0 0 1 8 32" stroke="#22c55e" stroke-width="12" stroke-linecap="round" fill="none"/>',
    '<path d="M8 32A24 24 0 0 1 32 8" stroke="#22c55e" stroke-width="12" stroke-linecap="round" fill="none"/>',
  ][frame]!
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '<rect width="64" height="64" rx="12" fill="#111827"/>',
    '<circle cx="32" cy="32" r="24" fill="#0f172a" stroke="#334155" stroke-width="4"/>',
    arc,
    '<circle cx="32" cy="32" r="12" fill="#f8fafc"/>',
    '<circle cx="32" cy="32" r="5" fill="#111827"/>',
    '</svg>',
  ].join('')
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

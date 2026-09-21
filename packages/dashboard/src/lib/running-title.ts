import { useEffect } from 'react'
import { octopusSvg } from '../brand/octopus.js'
import { isDesktopClient } from './desktop.js'

const FAVICON_FRAMES = [0, 1, 2, 3] as const
const FAVICON_INTERVAL_MS = 500

export const DASHBOARD_TITLE = 'Kala'

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
    let timeout: number | undefined
    const schedule = (): void => {
      timeout = window.setTimeout(() => {
        render()
        schedule()
      }, FAVICON_INTERVAL_MS)
    }
    render()
    schedule()
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
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
  link.href = isDesktopClient() ? '/icons/octopus-desktop.svg' : '/icons/octopus-web.svg'
  document.head.appendChild(link)
  return link
}

function renderRunningFavicon(frame: number): string {
  const svg = octopusSvg(isDesktopClient() ? 'desktop' : 'web', { runningFrame: frame })
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

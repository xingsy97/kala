import { useEffect, useState } from 'react'
import { useInterfaceScale } from '../lib/interface-scale.js'

/** Reactively tracks whether a min-width media query currently matches. */
export function useMinWidth(px: number): boolean {
  const scale = useInterfaceScale()
  const query = `(min-width: ${Math.round(px * scale)}px)`
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** True on narrow (mobile-width) viewports. */
export function useIsMobile(): boolean {
  return !useMinWidth(640)
}

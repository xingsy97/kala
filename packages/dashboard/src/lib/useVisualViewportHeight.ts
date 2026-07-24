/**
 * Mirrors the browser's visible viewport into CSS variables used by the app
 * shell, drawers, and dialogs. `100dvh` is not enough on iOS PWA: in
 * standalone mode and during keyboard transitions WebKit can report a layout
 * viewport that is larger than the actually visible area. `visualViewport`
 * is the most reliable cross-browser signal for that visible area.
 */

import { useEffect, useState } from 'react'

export function useVisualViewportHeight(): number {
  const [height, setHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    return window.visualViewport?.height ?? window.innerHeight
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const root = document.documentElement
    const vv = window.visualViewport
    const update = (): void => {
      const h = Math.max(1, Math.round(vv?.height ?? window.innerHeight))
      const layoutHeight = Math.max(1, Math.round(window.innerHeight))
      const offsetTop = Math.max(0, Math.round(vv?.offsetTop ?? 0))
      const keyboardOpen = Boolean(vv && layoutHeight - h > 120)
      setHeight(h)
      root.style.setProperty('--ak-viewport-h', `${h}px`)
      root.style.setProperty('--ak-layout-vh', `${layoutHeight}px`)
      root.style.setProperty('--ak-viewport-offset-top', `${offsetTop}px`)
      root.dataset.akKeyboard = keyboardOpen ? 'open' : 'closed'
    }
    update()
    // visualViewport fires 'resize' while the keyboard slides, when the URL
    // bar collapses, and on orientation changes. window 'resize' catches the
    // desktop path and older WebKit builds where visualViewport is missing.
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.addEventListener('focusin', update)
    window.addEventListener('focusout', update)
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.removeEventListener('focusin', update)
      window.removeEventListener('focusout', update)
    }
  }, [])

  return height
}

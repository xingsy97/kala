/**
 * Reports the current visual-viewport height as a CSS variable and returns
 * the same number for JS consumers.
 *
 * Why not `100dvh`: iOS Safari in PWA standalone mode has a long-standing
 * quirk where `100dvh` / `100vh` reports the full device height including
 * the region behind the status bar and home indicator, but content only
 * paints inside a smaller inner area. Using `100dvh` in a root
 * `overflow-hidden` container leaves an unreachable strip of blank space
 * below the composer (or clips it entirely on rotate). `visualViewport`
 * is the WebKit-approved way to read the *actually visible* height and
 * reacts correctly to keyboard show/hide + safe-area changes.
 *
 * The hook writes the value to `document.documentElement.style` as
 * `--ak-viewport-h` so CSS can consume it via `h-[var(--ak-viewport-h)]`
 * on any element that needs to match the viewport.
 */

import { useEffect, useState } from 'react'

export function useVisualViewportHeight(): number {
  const [height, setHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    return window.visualViewport?.height ?? window.innerHeight
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    const update = (): void => {
      // Skip updates while a text input is focused — iOS fires
      // visualViewport.resize with the *keyboard-shrunk* height, and if
      // we shrink the root the composer floats up above the keyboard
      // leaving a black gap between them. Letting the root stay at the
      // full viewport height allows iOS to slide the keyboard *over*
      // the page and auto-scroll the focused input into view, which is
      // the intended platform behavior.
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        return
      }
      const h = vv?.height ?? window.innerHeight
      setHeight(h)
      document.documentElement.style.setProperty('--ak-viewport-h', `${h}px`)
    }
    update()
    // visualViewport fires 'resize' when keyboard slides / orientation
    // changes / URL bar hides. window 'resize' catches the desktop path
    // and older WebKit builds where visualViewport is missing.
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    // Re-measure after the keyboard closes so any transient value
    // written before focus is corrected.
    window.addEventListener('focusout', update)
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.removeEventListener('focusout', update)
    }
  }, [])

  return height
}

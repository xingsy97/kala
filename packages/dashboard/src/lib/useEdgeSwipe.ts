import { useEffect, useRef } from 'react'

export type EdgeSwipeOptions = {
  /** Fired when a left-edge → right swipe is recognised. */
  onOpen?: () => void
  /** Fired when a right → left swipe is recognised (e.g. to close a drawer). */
  onClose?: () => void
  /**
   * Only start tracking an open-swipe when the touch begins within this many
   * px of the left screen edge. Keeps normal in-content horizontal scrolls and
   * button taps from triggering the drawer.
   */
  edgeWidth?: number
  /** Minimum horizontal travel (px) to count as a swipe. */
  threshold?: number
  /** Max vertical drift (px) allowed before we treat it as a scroll, not a swipe. */
  maxVerticalDrift?: number
  /** Disable entirely (e.g. on wide/desktop layouts). */
  enabled?: boolean
}

/**
 * Left-edge swipe gesture for opening/closing a mobile navigation drawer.
 *
 * - `onOpen`: a horizontal right-swipe that STARTS at the left screen edge.
 * - `onClose`: a horizontal left-swipe (start position anywhere), useful while
 *   a drawer is open.
 *
 * The listeners are attached to `window` with `passive: true` so they never
 * block scrolling; the gesture is recognised on `touchend` from the net
 * displacement, so an in-progress vertical scroll is naturally ignored.
 */
export function useEdgeSwipe(options: EdgeSwipeOptions): void {
  const optsRef = useRef(options)
  optsRef.current = options

  useEffect(() => {
    if (typeof window === 'undefined') return
    let startX = 0
    let startY = 0
    let startedAtEdge = false
    let tracking = false

    const onTouchStart = (e: TouchEvent): void => {
      const o = optsRef.current
      if (o.enabled === false) return
      // Ignore multi-touch (pinch/zoom) so we don't fight the browser.
      if (e.touches.length !== 1) {
        tracking = false
        return
      }
      const t = e.touches[0]
      if (!t) return
      startX = t.clientX
      startY = t.clientY
      startedAtEdge = t.clientX <= (o.edgeWidth ?? 24)
      tracking = true
    }

    const onTouchEnd = (e: TouchEvent): void => {
      if (!tracking) return
      tracking = false
      const o = optsRef.current
      if (o.enabled === false) return
      const t = e.changedTouches[0]
      if (!t) return
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      const threshold = o.threshold ?? 56
      const maxVerticalDrift = o.maxVerticalDrift ?? 60
      if (Math.abs(dy) > maxVerticalDrift) return
      if (Math.abs(dx) < threshold) return
      if (dx > 0 && startedAtEdge) {
        o.onOpen?.()
      } else if (dx < 0) {
        o.onClose?.()
      }
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [])
}

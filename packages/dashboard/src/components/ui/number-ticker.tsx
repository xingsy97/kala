/**
 * NumberTicker — animates a numeric readout from its previous value to a
 * new one whenever `value` changes. Rendered as a plain span so callers
 * can drop it in wherever a static number used to live.
 *
 * Design choices
 * --------------
 * - Callers pass the *raw number* plus a `formatValue` callback. This is
 *   important for tokens because `formatTokens(12345)` is `"12.3k"`, and
 *   we want the interpolated frames to also read "6.1k → 12.3k" rather
 *   than "6123 → 12345" flickering to k-suffixes at the end.
 * - Uses `requestAnimationFrame`. `setInterval` at 60Hz drifts and hides
 *   the last frame if the tab throttles; rAF pauses cleanly on
 *   backgrounded tabs (which is what we want) and hits vsync.
 * - Reduced-motion: skips the animation entirely and just prints the new
 *   value. The `formatValue(value)` output is emitted synchronously on
 *   mount and after every value change.
 * - No easing library. `1 - (1 - t) ** 3` is a decent ease-out and
 *   produces the "settle in" feel with no dependency cost.
 */

import { useEffect, useRef, useState } from 'react'

type Props = {
  value: number
  /** How to render the interpolated intermediate values. */
  formatValue?: (n: number) => string
  /** Ms. Kept short: this is a readout, not a hero animation. */
  durationMs?: number
  className?: string
  /** Test-only escape hatch so JSDOM tests can inspect the final state. */
  'data-testid'?: string
}

const DEFAULT_DURATION = 600

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function NumberTicker({
  value,
  formatValue = defaultFormat,
  durationMs = DEFAULT_DURATION,
  className,
  ...rest
}: Props): JSX.Element {
  const [display, setDisplay] = useState<number>(value)
  const startedFromRef = useRef<number>(value)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (prefersReducedMotion() || durationMs <= 0) {
      startedFromRef.current = value
      setDisplay(value)
      return
    }
    const from = startedFromRef.current
    if (from === value) return
    const start = performance.now()
    const tick = (now: number): void => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / durationMs)
      const next = from + (value - from) * easeOutCubic(t)
      setDisplay(next)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
        startedFromRef.current = value
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [value, durationMs])

  return (
    <span className={className} {...rest}>
      {formatValue(display)}
    </span>
  )
}

function defaultFormat(n: number): string {
  return Math.round(n).toLocaleString()
}

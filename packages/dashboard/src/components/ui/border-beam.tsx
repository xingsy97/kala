/**
 * BorderBeam  -  a rotating conic-gradient border that runs around a container
 * to signal "this is live / in-flight." Purely presentational: it renders a
 * span positioned absolutely inside a `relative` parent, does not affect
 * layout, and does not read events.
 *
 * Implementation
 * --------------
 * We paint a 200%-wide conic gradient inside a mask that only keeps a
 * 1.5px-wide ring around the edge (`mask-composite: xor`). Rotating the
 * gradient's `--angle` custom property produces the traveling-highlight
 * effect. Two angle stops with tiny `transition-duration` differences would
 * chug in Chrome, so we drive it via a CSS `@keyframes` animation and let
 * the compositor handle it.
 *
 * A11y
 * ----
 * The whole element is `aria-hidden`  -  the sub-agent's textual status badge
 * already conveys "running" to assistive tech. The `@media
 * (prefers-reduced-motion: reduce)` block pauses the animation and holds
 * the beam at 90 -  so the border is a static tinted outline rather than a
 * moving one.
 */

import { cn } from '../../lib/utils.js'

type Props = {
  className?: string
  /**
   * Ring thickness in pixels. 1.5px reads as "a bit thicker than the base
   * card border" which is what makes it noticeable without shouting.
   */
  size?: number
  /**
   * Full-cycle duration in seconds. Slower (4 - 6s) reads as "gentle", faster
   * (< 2s) starts to feel anxious. Default balances "clearly moving" with
   * "not distracting when four sub-agents render at once."
   */
  duration?: number
  /**
   * Gradient colors. Two-stop is intentional: three-stop conic gradients
   * often read as "loading skeleton" instead of "in-flight border."
   */
  colorFrom?: string
  colorTo?: string
}

export function BorderBeam({
  className,
  size = 1.5,
  duration = 4,
  colorFrom = 'hsl(199 89% 62%)',
  colorTo = 'hsl(217 91% 68%)',
}: Props): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="border-beam"
      className={cn(
        'pointer-events-none absolute inset-0 rounded-[inherit]',
        'ak-border-beam',
        className,
      )}
      style={
        {
          '--ak-beam-size': `${size}px`,
          '--ak-beam-duration': `${duration}s`,
          '--ak-beam-color-from': colorFrom,
          '--ak-beam-color-to': colorTo,
        } as React.CSSProperties
      }
    />
  )
}

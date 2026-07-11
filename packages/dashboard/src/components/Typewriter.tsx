import type { CSSProperties } from 'react'

import { cn } from '../lib/utils.js'
import { useTypewriter } from '../lib/useTypewriter.js'

type Props = {
  text: string
  className?: string
  style?: CSSProperties
  charMs?: number
  startDelayMs?: number
  /** Hide the trailing caret entirely (useful for placeholders). */
  hideCaret?: boolean
  /** Keep the caret blinking after typing finishes. */
  persistCaret?: boolean
  as?: 'span' | 'div' | 'p' | 'h1' | 'h2' | 'h3'
}

/**
 * Typewriter  -  reveals `text` character by character, then shows a blinking
 * caret. Respects `prefers-reduced-motion` by rendering the full text with no
 * caret animation. Intended for low-frequency, ambience-focused positions
 * (empty states, welcome copy, first-time dialogs).
 */
export function Typewriter({
  text,
  className,
  style,
  charMs,
  startDelayMs,
  hideCaret = false,
  persistCaret = false,
  as = 'span',
}: Props): JSX.Element {
  const { visible, done } = useTypewriter(text, {
    ...(charMs !== undefined ? { charMs } : {}),
    ...(startDelayMs !== undefined ? { startDelayMs } : {}),
  })
  const showCaret = !hideCaret && (persistCaret || !done)
  const Tag = as
  return (
    <Tag
      className={className}
      style={style}
      data-testid="typewriter"
      data-done={done ? 'true' : 'false'}
    >
      <span>{visible}</span>
      {showCaret ? (
        <span aria-hidden="true" className={cn('ak-caret', 'text-current')}>
           - 
        </span>
      ) : null}
    </Tag>
  )
}

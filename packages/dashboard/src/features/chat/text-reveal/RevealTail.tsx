import { memo } from 'react'

import { REVEAL_FADE_WINDOW_CHARS } from './rate.js'

/**
 * Text-reveal render layer — how streamed assistant text is *displayed*
 * character by character. This is a presentation concern (reveal pacing +
 * per-character fade), NOT stream data transport. See
 * docs/design/smooth-streaming-text.md.
 *
 * The actively-revealing trailing block is rendered by <RevealTail> OUTSIDE
 * ReactMarkdown. ReactMarkdown re-parses its subtree on every token, which would
 * remount any nested fade spans and restart their CSS animation each frame — so
 * the fade looked absent and already-shown text flashed. Rendering the tail as a
 * persistent plain-text component keeps each fade span mounted exactly once.
 */

/** The blinking caret placed at the current reveal position. */
export function RevealCursor(): JSX.Element {
  return <span className="ak-streaming-cursor" aria-hidden="true" data-testid="streaming-cursor" />
}

/**
 * Whether the actively-revealing trailing block may use the persistent
 * per-character fade tail. We downgrade (render via markdown, no fade) when the
 * tail contains any Markdown-significant syntax. Only genuinely plain prose uses
 * the persistent text path; structural or inline Markdown renders immediately.
 */
export function canFadeRevealTail(tail: string): boolean {
  if (tail.length === 0) return false
  // Newlines can change paragraph/list/fence/reference interpretation elsewhere
  // in the document, so only a single line can take the non-Markdown fast path.
  if (/[\r\n]/u.test(tail)) return false
  // Inline constructs: emphasis/strike, code, links/images, tables, entities,
  // raw HTML, and escapes all need the Markdown parser.
  if (/[*_~`$\[\]|<>\\&]/u.test(tail)) return false
  // GFM autolink literals have no punctuation delimiter but still produce links.
  if (/\b(?:https?:\/\/|www\.)|\b[^\s@]+@[^\s@]+\.[^\s@]+/iu.test(tail)) return false
  // Block constructs: headings, lists, blockquotes, indented code, and rules.
  if (/^(?: {4}|\t)/u.test(tail)) return false
  if (/^ {0,3}(?:#{1,6}(?:\s|$)|>|[-+]\s|\d+[.)]\s|(?:-{3,}|_{3,})\s*$)/mu.test(tail)) return false
  return true
}

/**
 * Render the reveal tail: settled text (plain) + the last
 * REVEAL_FADE_WINDOW_CHARS characters each in an `.ak-char-in` fade span +
 * trailing cursor. Reveal only appends, so a character's absolute index is
 * stable — keying each span by that index means an already-visible character
 * keeps the same element across renders and its fade runs to completion exactly
 * once. The number of animated spans is bounded by the window regardless of
 * reply length.
 *
 * Exported as a plain function (not the memo wrapper) so unit tests can render it
 * directly; production uses the memoized {@link RevealTail}.
 */
export function renderRevealTail({ text }: { text: string }): JSX.Element {
  const windowSize = Math.min(REVEAL_FADE_WINDOW_CHARS, text.length)
  const settledLen = text.length - windowSize
  const settled = text.slice(0, settledLen)
  const fading = text.slice(settledLen)
  return (
    <div className="ak-chat-text ak-streaming-tail min-w-0 max-w-full whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere]">
      {settled}
      {Array.from(fading, (ch, i) => (
        <span key={settledLen + i} className="ak-char-in">
          {ch}
        </span>
      ))}
      <RevealCursor />
    </div>
  )
}

export const RevealTail = memo(function RevealTail({ text }: { text: string }): JSX.Element {
  return renderRevealTail({ text })
})

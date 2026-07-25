/**
 * Text-reveal feature — how streamed assistant text is *displayed* character by
 * character (reveal pacing + per-character fade). This is a presentation
 * concern, distinct from stream data transport. Design:
 * docs/design/smooth-streaming-text.md.
 *
 * - rate.ts: pure reveal-rate model + shared tunable parameters (consumed by the
 *   session drain loop).
 * - RevealTail.tsx: the persistent per-character fade render (consumed by the
 *   chat markdown renderer).
 */
export {
  REVEAL_BASE_CPS,
  REVEAL_MAX_CPS,
  REVEAL_MAX_LAG_SECONDS,
  REVEAL_FADE_DURATION_MS,
  REVEAL_FADE_WINDOW_CHARS,
  computeReveal,
} from './rate.js'

export { RevealCursor, RevealTail, renderRevealTail, canFadeRevealTail } from './RevealTail.js'

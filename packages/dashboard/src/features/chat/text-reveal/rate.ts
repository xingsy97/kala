/**
 * Text-reveal rate model (pure, no React/DOM) — how fast streamed assistant text
 * is *displayed*, character by character. This is a presentation concern, NOT
 * stream data transport (the socket delivers tokens as fast as they arrive; this
 * paces how they are revealed to the reader). See
 * docs/design/smooth-streaming-text.md.
 *
 * All tunable parameters for both reveal layers (pacing + per-character fade)
 * live here so they stay consistent.
 */

// ── Reveal rate (session drain loop) ──────────────────────────────────────────

/** Base reveal rate: characters revealed per second when not catching up. */
export const REVEAL_BASE_CPS = 120

/**
 * Ceiling so a large backlog catches up quickly but never dumps a clump. Kept
 * moderate (not a huge burst) so the reveal stays even and the cursor does not
 * race far ahead of the freshly-faded characters.
 */
export const REVEAL_MAX_CPS = 260

/** The buffer is drained fast enough to never lag the data by more than this. */
export const REVEAL_MAX_LAG_SECONDS = 0.6

// ── Per-character fade (RevealTail render) ────────────────────────────────────

/**
 * Per-character fade-in duration. Longer + ease-in makes the fade clearly
 * visible (a short ease-out finished before a character was even noticeable, so
 * the effect looked absent).
 */
export const REVEAL_FADE_DURATION_MS = 340

/**
 * Adaptive fade window: a character must finish fading in BEFORE it slides out of
 * the animated window, otherwise it hard-cuts to solid text and the fade is
 * invisible. The window therefore holds at least as many characters as can be
 * revealed during one fade duration at the base rate. Deriving it (instead of a
 * magic constant) keeps the fade visible while staying a small, bounded
 * plain-text region.
 */
export const REVEAL_FADE_WINDOW_CHARS = Math.ceil((REVEAL_FADE_DURATION_MS / 1000) * REVEAL_BASE_CPS)

/**
 * Even-rate reveal math. Given the current unrevealed buffer length, elapsed
 * seconds since the last frame, and the fractional `carry` from prior frames,
 * return how many characters to reveal this frame plus the new carry. Rate is
 * REVEAL_BASE_CPS, accelerating toward REVEAL_MAX_CPS only enough to drain the
 * backlog within REVEAL_MAX_LAG_SECONDS.
 */
export function computeReveal(
  bufferLength: number,
  dtSeconds: number,
  carry: number,
): { count: number; carry: number } {
  if (bufferLength <= 0) return { count: 0, carry: 0 }
  const effectiveCps = Math.min(
    REVEAL_MAX_CPS,
    Math.max(REVEAL_BASE_CPS, bufferLength / REVEAL_MAX_LAG_SECONDS),
  )
  const nextCarry = carry + effectiveCps * dtSeconds
  let count = Math.floor(nextCarry)
  if (count <= 0) return { count: 0, carry: nextCarry }
  const remainder = nextCarry - count
  if (count > bufferLength) count = bufferLength
  return { count, carry: remainder }
}

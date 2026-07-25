import { streamingMarkdownLlm } from '../fixtures/index.js'
import { measureDomChurn, measureEarlyRegionChanges, waitMs } from '../probes/index.js'
import type { ScenarioContext, ScenarioResult } from './types.js'

/**
 * CASE: streaming markdown flicker.
 *
 * Symptom the user reported: while a markdown answer streams in, everything
 * ALREADY rendered above the cursor flickers heavily as new tokens arrive,
 * hurting readability.
 *
 * Root cause found with this harness: AssistantMarkdown re-parsed the whole
 * growing text through ReactMarkdown on every ~15fps commit; intermediate
 * states (unclosed fences, half tables, KaTeX) reshaped the tree so React
 * rebuilt the entire subtree — ~315 block elements removed / ~328 added over a
 * single stream.
 *
 * Fix: split streaming text into completed blocks (each its own memoized
 * <MarkdownBlock>) plus a trailing block; only the tail re-renders. After the
 * fix, changes to the already-rendered (non-tail) region dropped to ~2.
 *
 * This scenario re-measures both signals so the fix can't silently regress.
 */
export const STREAMING_MARKDOWN_LLM = streamingMarkdownLlm

export type StreamingMarkdownMetrics = {
  /** Block-level elements removed during the stream (lower is better). */
  blocksRemoved: number
  /** Block-level elements added during the stream. */
  blocksAdded: number
  /** Changes to the earlier (non-tail) region — the true "flicker" signal. */
  earlyRegionChanges: number
  /** Peak number of per-character fade spans seen at any instant (must stay bounded). */
  maxFadeSpans: number
}

/** Suggested threshold: the already-rendered region must stay near-stable. */
const EARLY_REGION_CHANGES_MAX = 8
/**
 * The per-character fade window is bounded (REVEAL_FADE_WINDOW_CHARS in the
 * dashboard text-reveal module). Sampling can catch a couple of in-flight
 * leaves, so allow a small multiple; the point is it must NOT grow with length.
 */
const MAX_FADE_SPANS_CEILING = 160

export async function runStreamingMarkdownFlicker(
  ctx: ScenarioContext,
  observeMs = 9000,
): Promise<ScenarioResult<StreamingMarkdownMetrics>> {
  const { session } = ctx
  await session.waitForComposer()

  const BLOCK_SELECTOR = 'p, pre, li, table, ul, ol, h1, h2, h3, h4, blockquote'
  const STREAM_CONTAINER = '.ak-streaming-markdown'

  // Poll the live count of per-character fade spans while streaming, tracking the
  // peak. Bounded peak => the fade window is capped regardless of reply length.
  let maxFadeSpans = 0
  let polling = true
  const pollFade = async (): Promise<void> => {
    while (polling) {
      const n = await session.page
        .evaluate(() => document.querySelectorAll('.ak-char-in').length)
        .catch(() => 0)
      if (n > maxFadeSpans) maxFadeSpans = n
      await waitMs(120)
    }
  }
  const fadePoll = pollFade()

  // Two overlapping observers in one run: total block churn and early-region
  // churn. We start the stream once and observe both windows concurrently.
  let churn = { removed: 0, added: 0, totalMutations: 0 }
  const early = await measureEarlyRegionChanges(session.page, STREAM_CONTAINER, async () => {
    churn = await measureDomChurn(session.page, { selector: BLOCK_SELECTOR }, async () => {
      await session.sendPrompt('stream a markdown answer')
      await waitMs(observeMs)
    })
  })
  polling = false
  await fadePoll

  const metrics: StreamingMarkdownMetrics = {
    blocksRemoved: churn.removed,
    blocksAdded: churn.added,
    earlyRegionChanges: early.earlyRegionChanges,
    maxFadeSpans,
  }
  const pass = metrics.earlyRegionChanges <= EARLY_REGION_CHANGES_MAX && metrics.maxFadeSpans <= MAX_FADE_SPANS_CEILING
  return {
    name: 'streaming-markdown-flicker',
    reproduces: 'Already-rendered markdown blocks flicker while later content streams in.',
    metrics,
    pass,
    notes: `earlyRegionChanges ${metrics.earlyRegionChanges} (threshold ≤ ${EARLY_REGION_CHANGES_MAX}); blockChurn removed=${metrics.blocksRemoved} added=${metrics.blocksAdded}; maxFadeSpans ${metrics.maxFadeSpans} (bounded ≤ ${MAX_FADE_SPANS_CEILING}). Only the trailing block should update, and the per-character fade window must stay bounded.`,
  }
}

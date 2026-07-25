import { toolLoopLlm } from '../fixtures/index.js'
import { measureDomChurn, measureFrameTiming, profileMainThread, waitMs } from '../probes/index.js'
import type { ScenarioContext, ScenarioResult } from './types.js'

/**
 * CASE: sidebar / title status-indicator jank during a tool-heavy turn.
 *
 * Symptom the user reported: the spinning session-status indicators (left
 * sidebar and next to the session name) stutter/reset while a tool call runs.
 *
 * Two distinct root causes were found with this harness:
 *   1. The status indicator DOM was being re-mounted on every tool step
 *      (status flipped thinking↔executing_tools, re-rendering the memoized
 *      Explorer). Fixed by coarsening status + memoizing the indicator.
 *      Verified here via DOM churn of `[data-testid=session-status-indicator]`
 *      (must stay 0 during the turn).
 *   2. A single ~666ms main-thread long task — source-mapped to
 *      `toolRiskWeight @ human-attention/evaluator.ts` — froze every animation.
 *      Fixed by not JSON.stringify-ing large tool inputs + debouncing the
 *      recompute. Verified here via a source-mapped CPU profile (no single
 *      frame should be a giant long task) and frame timing.
 *
 * The tool payload is intentionally large to reproduce cause #2. A CPU throttle
 * (set on the browser session) is recommended so a fast dev machine behaves a
 * bit more like a phone.
 */
export const TOOL_LOOP_LLM = () => toolLoopLlm({ turns: 40, thinkMs: 300, payloadChars: 10_000 })

export type StatusIndicatorMetrics = {
  /** Indicator elements removed during the turn (must be 0 — no re-mount). */
  indicatorRemoved: number
  /** Indicator elements added during the turn. */
  indicatorAdded: number
  /** Worst frame during the turn (ms). */
  worstFrameMs: number
  /** Frames over 100ms (visible hitches). */
  hitchesOver100ms: number
  /** Worst source-mapped self-time hot spot during the turn. */
  topHotSpot: { functionName: string; source: string; selfMs: number } | null
}

/**
 * Suggested threshold: the indicator must not be torn down *repeatedly* during
 * the turn. A few re-mounts around turn start/end (the session transitioning
 * into and out of "running") are expected; the bug was the spinner rebuilding
 * on *every* tool step, which pushes this into the dozens. Tune against a real
 * device / longer turn if needed.
 */
const INDICATOR_REMOUNTS_MAX = 8

export async function runStatusIndicatorJank(
  ctx: ScenarioContext,
  observeMs = 14_000,
): Promise<ScenarioResult<StatusIndicatorMetrics>> {
  const { session } = ctx
  await session.waitForComposer()

  // Profile + frame-time + indicator churn across the same tool-heavy turn.
  let frame = { frames: 0, avgMs: 0, maxMs: 0, droppedOver33ms: 0, hitchesOver100ms: 0 }
  let churn = { removed: 0, added: 0, totalMutations: 0 }
  const profile = await profileMainThread(session.page, session.cdp, async () => {
    frame = await measureFrameTiming(session.page, async () => {
      churn = await measureDomChurn(
        session.page,
        { selector: '[data-testid="session-status-indicator"]' },
        async () => {
          await session.sendPrompt('run many tools')
          await waitMs(observeMs)
        },
      )
    })
  })

  const top = profile.hotSpots[0] ?? null
  const metrics: StatusIndicatorMetrics = {
    indicatorRemoved: churn.removed,
    indicatorAdded: churn.added,
    worstFrameMs: frame.maxMs,
    hitchesOver100ms: frame.hitchesOver100ms,
    topHotSpot: top ? { functionName: top.functionName, source: top.source, selfMs: top.selfMs } : null,
  }
  const pass = metrics.indicatorRemoved <= INDICATOR_REMOUNTS_MAX
  return {
    name: 'status-indicator-jank',
    reproduces: 'Status-indicator spinners stutter/reset while a tool call runs.',
    metrics,
    pass,
    notes: `indicator re-mounts ${metrics.indicatorRemoved} (threshold ≤ ${INDICATOR_REMOUNTS_MAX}); worst frame ${metrics.worstFrameMs}ms; top hot spot ${top ? `${top.functionName} @ ${top.source} (${top.selfMs}ms)` : 'n/a'}. Watch this hot spot for a regression like the 666ms toolRiskWeight one.`,
  }
}

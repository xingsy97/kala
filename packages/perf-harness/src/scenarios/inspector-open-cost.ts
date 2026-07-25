import { toolLoopLlm } from '../fixtures/index.js'
import { measureFrameTiming, waitMs } from '../probes/index.js'
import type { ScenarioContext, ScenarioResult } from './types.js'

/**
 * CASE: opening the right-hand inspector (the "debugger") causes a noticeable
 * one-off page hitch.
 *
 * Symptom the user reported: clicking to expand the inspector janks the whole
 * page for a moment.
 *
 * Diagnosis with this harness: InspectorPanel runs several O(timeline)
 * computations (stateFlow / buildLlmCalls / buildToolCalls / buildReplaySnapshots)
 * on first mount, which on a throttled CPU shows up as a ~300ms hitch frame.
 * This is a one-time cost when opening (not a persistent stutter), so the
 * scenario reports the worst frame while opening as an advisory metric rather
 * than a hard gate.
 */
export const INSPECTOR_LOAD_LLM = () => toolLoopLlm({ turns: 40, thinkMs: 300, payloadChars: 4000 })

export type InspectorOpenMetrics = {
  /** Worst frame while the inspector mounts (ms). */
  openWorstFrameMs: number
  /** Frames over 100ms while opening. */
  hitchesOver100ms: number
  /** Whether the inspector panel actually appeared. */
  inspectorMounted: boolean
}

export async function runInspectorOpenCost(
  ctx: ScenarioContext,
  buildTimelineMs = 12_000,
): Promise<ScenarioResult<InspectorOpenMetrics>> {
  const { session } = ctx
  await session.waitForComposer()

  // Build up a timeline first so the inspector has real work to do on mount.
  await session.sendPrompt('run tools to build a timeline')
  await waitMs(buildTimelineMs)

  // Collapse the inspector if it's open (it defaults to open on wide layouts),
  // then measure the frame cost of opening it.
  await session.page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="inspector-collapse-button"]')?.click()
  })
  await waitMs(800)

  const frame = await measureFrameTiming(session.page, async () => {
    await session.page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="inspector-toggle"]')?.click()
    })
    await waitMs(2500)
  })
  const inspectorMounted = await session.page.evaluate(
    () => !!document.querySelector('[data-testid="inspector-panel"]'),
  )

  const metrics: InspectorOpenMetrics = {
    openWorstFrameMs: frame.maxMs,
    hitchesOver100ms: frame.hitchesOver100ms,
    inspectorMounted,
  }
  return {
    name: 'inspector-open-cost',
    reproduces: 'Opening the inspector janks the whole page for a moment.',
    metrics,
    pass: null, // advisory: a one-time mount cost, tracked for trend not gated.
    notes: `worst frame on open ${metrics.openWorstFrameMs}ms, hitches>100ms ${metrics.hitchesOver100ms}. This is InspectorPanel's first-mount O(timeline) work; track for regressions.`,
  }
}

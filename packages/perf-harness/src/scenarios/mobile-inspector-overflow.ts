import { toolLoopLlm } from '../fixtures/index.js'
import { detectHorizontalOverflow, waitMs } from '../probes/index.js'
import type { ScenarioContext, ScenarioResult } from './types.js'

/**
 * CASE: on mobile / PWA the inspector (debugger) content spills past the screen
 * edge.
 *
 * Symptom the user reported: opening the inspector on a phone shows content
 * overflowing horizontally beyond the viewport.
 *
 * This scenario opens the mobile inspector drawer and scans for descendants
 * whose content is wider than the viewport. NOTE: overflow tends to come from
 * specific rich content (large JSON traces, long prompts/commands), so a clean
 * scripted timeline may not trigger it — pass richer scripted content to make
 * this bite. Requires a `mobile: true` browser session.
 */
export const MOBILE_INSPECTOR_LLM = () => toolLoopLlm({ turns: 20, thinkMs: 200, payloadChars: 6000 })

export type MobileInspectorMetrics = {
  /** Whether the inspector drawer was found. */
  drawerFound: boolean
  /** Count of horizontally-overflowing descendants. */
  overflowCount: number
  /** Example offenders (tag / testid / classes / widths). */
  samples: { tag: string; testId: string; className: string; scrollWidth: number; clientWidth: number }[]
}

export async function runMobileInspectorOverflow(
  ctx: ScenarioContext,
  buildTimelineMs = 8000,
): Promise<ScenarioResult<MobileInspectorMetrics>> {
  const { session } = ctx
  await session.waitForComposer()

  await session.sendPrompt('run tools to build a timeline')
  await waitMs(buildTimelineMs)

  // Open the mobile inspector drawer.
  await session.page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="inspector-toggle"]')?.click()
  })
  await waitMs(1500)

  const overflow = await detectHorizontalOverflow(
    session.page,
    '[data-testid="inspector-drawer-mobile"], [data-testid="inspector-panel"]',
  )

  const metrics: MobileInspectorMetrics = {
    drawerFound: overflow.found,
    overflowCount: overflow.overflowCount,
    samples: overflow.samples,
  }
  const pass = overflow.found ? overflow.overflowCount === 0 : null
  return {
    name: 'mobile-inspector-overflow',
    reproduces: 'Inspector content overflows the screen edge on mobile/PWA.',
    metrics,
    pass,
    notes: `drawer ${overflow.found ? 'found' : 'not found'}, overflowCount ${metrics.overflowCount}. If 0 with a clean timeline, feed richer content (big JSON traces / long commands) — that is where real overflow appears.`,
  }
}

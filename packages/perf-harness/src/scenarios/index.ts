import type { LLMAdapter } from '@agent-kernel/host'

import type { ScenarioContext, ScenarioResult } from './types.js'
import { runStreamingMarkdownFlicker, STREAMING_MARKDOWN_LLM } from './streaming-markdown-flicker.js'
import { runStatusIndicatorJank, TOOL_LOOP_LLM } from './status-indicator-jank.js'
import { runInspectorOpenCost, INSPECTOR_LOAD_LLM } from './inspector-open-cost.js'
import { runMobileInspectorOverflow, MOBILE_INSPECTOR_LLM } from './mobile-inspector-overflow.js'
import { runStreamingScrollAnchor, STREAMING_SCROLL_ANCHOR_LLM } from './streaming-scroll-anchor.js'
import { runSaasCapabilities, SAAS_CAPABILITIES_LLM } from './saas-capabilities.js'

export type { ScenarioContext, ScenarioResult } from './types.js'
export * from './streaming-markdown-flicker.js'
export * from './status-indicator-jank.js'
export * from './inspector-open-cost.js'
export * from './mobile-inspector-overflow.js'
export * from './streaming-scroll-anchor.js'
export * from './saas-capabilities.js'

/**
 * A registry entry ties a scenario to the scripted LLM that drives it and the
 * browser conditions it needs. bin/run-scenario and the regression tests both
 * iterate over this so adding a scenario is one entry, not N call sites.
 */
export type ScenarioDefinition = {
  name: string
  reproduces: string
  /** Factory for the scripted LLM that shapes this scenario's load. */
  makeLlm(): LLMAdapter
  /** Whether the browser session must emulate a phone. */
  mobile: boolean
  /** Recommended CPU throttle (e.g. 6 ≈ mid phone). 1 = none. */
  cpuThrottleRate: number
  /** Run the measurement against a booted context. */
  run(ctx: ScenarioContext): Promise<ScenarioResult>
}

export const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    name: 'saas-capabilities',
    reproduces: 'SaaS exposes Agent while hiding and blocking Benchmark/Evaluation.',
    makeLlm: () => SAAS_CAPABILITIES_LLM(),
    mobile: true,
    cpuThrottleRate: 1,
    run: (ctx) => runSaasCapabilities(ctx),
  },
  {
    name: 'streaming-scroll-anchor',
    reproduces: 'User scrolls upward while a live markdown row keeps growing.',
    makeLlm: () => STREAMING_SCROLL_ANCHOR_LLM(),
    mobile: false,
    cpuThrottleRate: 1,
    run: (ctx) => runStreamingScrollAnchor(ctx),
  },
  {
    name: 'streaming-scroll-anchor-mobile',
    reproduces: 'User scrolls upward on mobile while a live markdown row keeps growing.',
    makeLlm: () => STREAMING_SCROLL_ANCHOR_LLM(),
    mobile: true,
    cpuThrottleRate: 2,
    run: (ctx) => runStreamingScrollAnchor(ctx),
  },
  {
    name: 'streaming-markdown-flicker',
    reproduces: 'Already-rendered markdown blocks flicker while later content streams in.',
    makeLlm: () => STREAMING_MARKDOWN_LLM(),
    mobile: false,
    cpuThrottleRate: 1,
    run: (ctx) => runStreamingMarkdownFlicker(ctx),
  },
  {
    name: 'status-indicator-jank',
    reproduces: 'Status-indicator spinners stutter/reset while a tool call runs.',
    makeLlm: () => TOOL_LOOP_LLM(),
    mobile: false,
    cpuThrottleRate: 6,
    run: (ctx) => runStatusIndicatorJank(ctx),
  },
  {
    name: 'inspector-open-cost',
    reproduces: 'Opening the inspector janks the whole page for a moment.',
    makeLlm: () => INSPECTOR_LOAD_LLM(),
    mobile: false,
    cpuThrottleRate: 6,
    run: (ctx) => runInspectorOpenCost(ctx),
  },
  {
    name: 'mobile-inspector-overflow',
    reproduces: 'Inspector content overflows the screen edge on mobile/PWA.',
    makeLlm: () => MOBILE_INSPECTOR_LLM(),
    mobile: true,
    cpuThrottleRate: 1,
    run: (ctx) => runMobileInspectorOverflow(ctx),
  },
]

/** Look up a scenario definition by name. */
export function findScenario(name: string): ScenarioDefinition | undefined {
  return SCENARIOS.find((s) => s.name === name)
}

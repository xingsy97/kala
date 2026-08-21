import { startLocalStack, type AgentToolSchema } from './fixtures/index.js'
import { openDashboard } from './probes/index.js'
import type { ScenarioDefinition, ScenarioResult } from './scenarios/index.js'
import { PRIVATE_CLOUD_DEPLOYMENT } from '@agent-kernel/shared'

/**
 * Boot a fresh local stack + browser for a single scenario, run it, and tear
 * everything down. This is the one-call entry both the CLI and the regression
 * tests use so lifecycle/cleanup lives in exactly one place.
 */

export type RunScenarioOptions = {
  /** Override the CPU throttle the scenario recommends. */
  cpuThrottleRate?: number
  /** Extra tools the session should expose (the default `write` is always present). */
  extraTools?: AgentToolSchema[]
}

export async function runScenarioOnce(
  definition: ScenarioDefinition,
  options: RunScenarioOptions = {},
): Promise<ScenarioResult> {
  const stack = await startLocalStack({
    llm: definition.makeLlm(), tools: options.extraTools,
    ...(definition.name === 'private-cloud-capabilities' ? { deployment: PRIVATE_CLOUD_DEPLOYMENT, capabilities: { agent: true, workspace: true, operations: true, artifacts: true, pipeline: true } } : {}),
  })
  try {
    const session = await openDashboard({
      url: stack.dashboardUrl,
      mobile: definition.mobile,
      cpuThrottleRate: options.cpuThrottleRate ?? definition.cpuThrottleRate,
    })
    try {
      return await definition.run({ stack, session })
    } finally {
      await session.close()
    }
  } finally {
    await stack.close()
  }
}

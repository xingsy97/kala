import type { RuntimeCapabilities } from '@agent-kernel/shared'

const BENCHMARK_ACTION_PREFIXES = [
  'benchmark-run-',
  'swebench-',
  'terminal-bench-',
  'program-bench-',
  'swe-marathon-',
] as const

const BENCHMARK_ACTIONS = new Set([
  'legacy-swebench-import',
  'run-registry-list',
])

const EVALUATION_ACTION_PREFIXES = [
  'eval-',
  'badcase-',
] as const

const EVALUATION_ACTIONS = new Set([
  'rollout-verify-reward',
])

export function disabledEnhancementCapability(
  action: string,
  capabilities: RuntimeCapabilities,
): 'benchmarks' | 'evaluations' | null {
  if (!capabilities.benchmarks && (
    BENCHMARK_ACTIONS.has(action)
    || BENCHMARK_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix))
  )) return 'benchmarks'
  if (!capabilities.evaluations && (
    EVALUATION_ACTIONS.has(action)
    || EVALUATION_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix))
  )) return 'evaluations'
  return null
}

import { BenchmarkDescriptorSchema } from '@agent-kernel/eval-protocol'
import { allStepsMetrics, createDeclarativeBenchmarkPlugin } from '@agent-kernel/eval-benchmark-common'
import type { VerificationStepResult } from '@agent-kernel/eval-benchmark-common'

const policy = { descriptor: BenchmarkDescriptorSchema.parse({ schemaVersion: 1, id: 'terminal-bench', label: 'Terminal-Bench-compatible local task pack · non-official', version: '1.0.0', official: false, nativePrimaryMetric: 'reward', verifierId: 'terminal-bench-native', verifierVersion: '1.0.0' }), taskPackId: 'terminal-bench', failureCode: 'TERMINAL_BENCH_UNRESOLVED', failureSummary: 'Local Terminal-Bench-compatible verifier did not pass', deriveMetrics: terminalBenchMetrics }
export const evaluationPlugins = [createDeclarativeBenchmarkPlugin(policy)] as const
export const createTerminalBenchAdapter = evaluationPlugins[0].create

export function terminalBenchMetrics(steps: readonly VerificationStepResult[]): Record<string, number | string | boolean> {
  const metrics = allStepsMetrics('reward', steps)
  const verifier = steps.find((step) => step.nativeMetric === 'reward')
  const reward = verifier?.emittedMetrics.reward
  if (!verifier || !verifier.passed || typeof reward !== 'number' || !Number.isFinite(reward) || reward < 0 || reward > 1) return { ...metrics, reward: 0, verifier_protocol_valid: false }
  return { ...metrics, reward, verifier_protocol_valid: true, resolved: reward >= 1 }
}

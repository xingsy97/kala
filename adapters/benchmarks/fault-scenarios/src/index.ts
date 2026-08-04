import { BenchmarkDescriptorSchema } from '@agent-kernel/eval-protocol'
import { allStepsMetrics, createDeclarativeBenchmarkPlugin } from '@agent-kernel/eval-benchmark-common'
import type { VerificationStepResult } from '@agent-kernel/eval-benchmark-common'
const policy = { descriptor: BenchmarkDescriptorSchema.parse({ schemaVersion: 1, id: 'fault-scenarios', label: 'Fault Scenarios', version: '1.0.0', official: false, nativePrimaryMetric: 'recovered', verifierId: 'fault-scenario-native', verifierVersion: '1.0.0' }), taskPackId: 'fault-scenarios', failureCode: 'FAULT_RECOVERY_FAILED', failureSummary: 'Agent did not recover from a declared deterministic fault', deriveMetrics: faultScenarioMetrics }
export const evaluationPlugins = [createDeclarativeBenchmarkPlugin(policy)] as const
export const createFaultScenarioAdapter = evaluationPlugins[0].create

const REQUIRED_FAULT_STAGES = ['fault_injected', 'fault_observed', 'recovery_action_grounded', 'service_recovered', 'success_control_passed'] as const
export function faultScenarioMetrics(steps: readonly VerificationStepResult[]): Record<string, number | string | boolean> {
  const metrics = allStepsMetrics('recovered', steps)
  const stages = Object.fromEntries(REQUIRED_FAULT_STAGES.map((name) => [name, steps.some((step) => step.nativeMetric === name && step.passed && step.emittedMetrics[name] === true)]))
  return { ...metrics, ...stages, recovered: Object.values(stages).every(Boolean), recovery_stages: Object.values(stages).filter(Boolean).length, total_recovery_stages: REQUIRED_FAULT_STAGES.length }
}

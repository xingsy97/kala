import { BenchmarkDescriptorSchema } from '@agent-kernel/eval-protocol'
import { allStepsMetrics, createDeclarativeBenchmarkPlugin } from '@agent-kernel/eval-benchmark-common'
import type { VerificationStepResult } from '@agent-kernel/eval-benchmark-common'
const policy = { descriptor: BenchmarkDescriptorSchema.parse({ schemaVersion: 1, id: 'swe-marathon', label: 'SWE-Marathon-compatible local task pack · non-official', version: '1.0.0', official: false, nativePrimaryMetric: 'resolved_tasks', verifierId: 'swe-marathon-native', verifierVersion: '1.0.0' }), taskPackId: 'swe-marathon', failureCode: 'SWE_MARATHON_UNRESOLVED', failureSummary: 'Local SWE-Marathon-compatible verifier did not complete the declared journey', deriveMetrics: sweMarathonMetrics }
export const evaluationPlugins = [createDeclarativeBenchmarkPlugin(policy)] as const
export const createSweMarathonAdapter = evaluationPlugins[0].create

export function sweMarathonMetrics(steps: readonly VerificationStepResult[]): Record<string, number | string | boolean> {
  const metrics = allStepsMetrics('resolved_tasks', steps)
  const verifier = steps.find((step) => step.nativeMetric === 'resolved_tasks')
  const resolved = verifier?.emittedMetrics.resolved_tasks
  const total = verifier?.emittedMetrics.total_tasks
  const valid = verifier?.passed === true && typeof resolved === 'number' && Number.isInteger(resolved) && resolved >= 0 && typeof total === 'number' && Number.isInteger(total) && total > 0 && resolved <= total
  return { ...metrics, resolved_tasks: valid ? resolved : 0, total_tasks: valid ? total : 0, completion_rate: valid ? resolved / total : 0, verifier_protocol_valid: valid }
}

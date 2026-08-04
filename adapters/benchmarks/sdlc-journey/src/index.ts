import { BenchmarkDescriptorSchema } from '@agent-kernel/eval-protocol'
import { allStepsMetrics, createDeclarativeBenchmarkPlugin } from '@agent-kernel/eval-benchmark-common'
import type { VerificationStepResult } from '@agent-kernel/eval-benchmark-common'
const policy = { descriptor: BenchmarkDescriptorSchema.parse({ schemaVersion: 1, id: 'sdlc-journey', label: 'SDLC local task pack · non-official', version: '1.0.0', official: false, nativePrimaryMetric: 'journey_completed', verifierId: 'sdlc-journey-native', verifierVersion: '1.0.0' }), taskPackId: 'sdlc-journey', failureCode: 'SDLC_JOURNEY_FAILED', failureSummary: 'Local SDLC task-pack build, test, deploy, health, or rollback verifier failed', deriveMetrics: sdlcJourneyMetrics }
export const evaluationPlugins = [createDeclarativeBenchmarkPlugin(policy)] as const
export const createSdlcJourneyAdapter = evaluationPlugins[0].create

const REQUIRED_STAGES = ['investigation_passed', 'implementation_verified', 'tests_passed', 'build_passed', 'package_created', 'deploy_succeeded', 'health_verified', 'rollback_verified'] as const
export function sdlcJourneyMetrics(steps: readonly VerificationStepResult[]): Record<string, number | string | boolean> {
  const metrics = allStepsMetrics('journey_completed', steps)
  const stages = Object.fromEntries(REQUIRED_STAGES.map((name) => [name, steps.some((step) => step.nativeMetric === name && step.passed && step.emittedMetrics[name] === true)]))
  return { ...metrics, ...stages, journey_completed: Object.values(stages).every(Boolean), completed_stages: Object.values(stages).filter(Boolean).length, total_stages: REQUIRED_STAGES.length }
}

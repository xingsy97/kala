import { describe, expect, it } from 'vitest'
import { createFaultScenarioAdapter, faultScenarioMetrics } from './index.js'
const stages = ['fault_injected', 'fault_observed', 'recovery_action_grounded', 'service_recovered', 'success_control_passed']
describe('Fault Scenario adapter', () => {
  it('requires deterministic injection, observation, grounded recovery, restored service, and control', () => { expect(createFaultScenarioAdapter().descriptor).toMatchObject({ id: 'fault-scenarios', nativePrimaryMetric: 'recovered' }); expect(faultScenarioMetrics(stages.map(step))).toMatchObject({ recovered: true, recovery_stages: 5 }) })
  it('does not report recovery when the success control is missing', () => { expect(faultScenarioMetrics(stages.slice(0, -1).map(step))).toMatchObject({ recovered: false, recovery_stages: 4 }) })
})
function step(nativeMetric: string) { return { stepId: nativeMetric, nativeMetric, passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', emittedMetrics: { [nativeMetric]: true } } }

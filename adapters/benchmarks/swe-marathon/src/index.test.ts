import { describe, expect, it } from 'vitest'
import { createSweMarathonAdapter, sweMarathonMetrics } from './index.js'
describe('SWE-Marathon adapter', () => {
  it('preserves long-horizon native resolution and denominator', () => { expect(createSweMarathonAdapter().descriptor).toMatchObject({ id: 'swe-marathon', label: expect.stringMatching(/compatible local task pack · non-official/), official: false, nativePrimaryMetric: 'resolved_tasks' }); expect(sweMarathonMetrics([step({ resolved_tasks: 2, total_tasks: 3 })])).toMatchObject({ resolved_tasks: 2, total_tasks: 3, completion_rate: 2 / 3, verifier_protocol_valid: true }) })
  it('rejects impossible or absent task counts', () => { expect(sweMarathonMetrics([step({ resolved_tasks: 4, total_tasks: 3 })])).toMatchObject({ resolved_tasks: 0, total_tasks: 0, verifier_protocol_valid: false }) })
})
function step(emittedMetrics: Record<string, number | string | boolean>) { return { stepId: 'resolved', nativeMetric: 'resolved_tasks', passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', emittedMetrics } }

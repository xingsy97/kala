import { describe, expect, it } from 'vitest'
import { createSdlcJourneyAdapter, sdlcJourneyMetrics } from './index.js'
const stages = ['investigation_passed', 'implementation_verified', 'tests_passed', 'build_passed', 'package_created', 'deploy_succeeded', 'health_verified', 'rollback_verified']
describe('SDLC Journey adapter', () => {
  it('owns the complete build through rollback journey', () => { expect(createSdlcJourneyAdapter().descriptor).toMatchObject({ id: 'sdlc-journey', label: 'SDLC local task pack · non-official', official: false, nativePrimaryMetric: 'journey_completed' }); expect(sdlcJourneyMetrics(stages.map(step))).toMatchObject({ journey_completed: true, completed_stages: 8, total_stages: 8 }) })
  it('does not complete when rollback evidence is absent', () => { expect(sdlcJourneyMetrics(stages.slice(0, -1).map(step))).toMatchObject({ journey_completed: false, completed_stages: 7 }) })
})
function step(nativeMetric: string) { return { stepId: nativeMetric, nativeMetric, passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', emittedMetrics: { [nativeMetric]: true } } }

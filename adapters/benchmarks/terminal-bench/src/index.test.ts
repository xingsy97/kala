import { describe, expect, it } from 'vitest'
import { createTerminalBenchAdapter, terminalBenchMetrics } from './index.js'
describe('Terminal-Bench adapter', () => {
  it('preserves bounded native reward semantics without claiming official harness evidence', () => { expect(createTerminalBenchAdapter().descriptor).toMatchObject({ id: 'terminal-bench', label: expect.stringMatching(/compatible local task pack · non-official/), nativePrimaryMetric: 'reward', official: false }); expect(terminalBenchMetrics([step('reward', true, { reward: 0.75 })])).toMatchObject({ reward: 0.75, verifier_protocol_valid: true, resolved: false }) })
  it('does not accept a missing, failed, or out-of-range reward protocol', () => { expect(terminalBenchMetrics([step('reward', true, { reward: 2 })])).toMatchObject({ reward: 0, verifier_protocol_valid: false }); expect(terminalBenchMetrics([step('other', true, { reward: 1 })])).toMatchObject({ reward: 0, verifier_protocol_valid: false }) })
})
function step(nativeMetric: string, passed: boolean, emittedMetrics: Record<string, number | string | boolean>) { return { stepId: nativeMetric, nativeMetric, passed, exitCode: passed ? 0 : 1, timedOut: false, stdout: '', stderr: '', emittedMetrics } }

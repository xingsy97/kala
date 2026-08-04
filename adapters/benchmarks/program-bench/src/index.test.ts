import { describe, expect, it } from 'vitest'
import { createProgramBenchAdapter, programBenchMetrics } from './index.js'
describe('ProgramBench adapter', () => {
  it('requires the submission, compile, and test contracts together', () => { expect(createProgramBenchAdapter().descriptor).toMatchObject({ id: 'program-bench', label: expect.stringMatching(/compatible local task pack · non-official/), official: false, nativePrimaryMetric: 'compile_passed' }); expect(programBenchMetrics([step('submission_contract', { contract_ok: true, implementation_file_count: 1 }), step('compile_passed', { compile_passed: true }), step('tests_passed', { tests_passed: true })])).toMatchObject({ submission_contract: true, compile_passed: true, tests_passed: true }) })
  it('rejects a successful compiler exit without a valid submission contract', () => { expect(programBenchMetrics([step('compile_passed', { compile_passed: true }), step('tests_passed', { tests_passed: true })])).toMatchObject({ compile_passed: false, verifier_protocol_valid: false }) })
})
function step(nativeMetric: string, emittedMetrics: Record<string, number | string | boolean>) { return { stepId: nativeMetric, nativeMetric, passed: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', emittedMetrics } }

import { BenchmarkDescriptorSchema } from '@agent-kernel/eval-protocol'
import { allStepsMetrics, createDeclarativeBenchmarkPlugin } from '@agent-kernel/eval-benchmark-common'
import type { VerificationStepResult } from '@agent-kernel/eval-benchmark-common'
const policy = { descriptor: BenchmarkDescriptorSchema.parse({ schemaVersion: 1, id: 'program-bench', label: 'ProgramBench-compatible local task pack · non-official', version: '1.0.0', official: false, nativePrimaryMetric: 'compile_passed', verifierId: 'program-bench-native', verifierVersion: '1.0.0' }), taskPackId: 'program-bench', failureCode: 'PROGRAM_BENCH_COMPILE_FAILED', failureSummary: 'Local ProgramBench-compatible artifact contract or compile verifier failed', deriveMetrics: programBenchMetrics }
export const evaluationPlugins = [createDeclarativeBenchmarkPlugin(policy)] as const
export const createProgramBenchAdapter = evaluationPlugins[0].create

export function programBenchMetrics(steps: readonly VerificationStepResult[]): Record<string, number | string | boolean> {
  const metrics = allStepsMetrics('compile_passed', steps)
  const contract = steps.find((step) => step.nativeMetric === 'submission_contract')
  const compile = steps.find((step) => step.nativeMetric === 'compile_passed')
  const tests = steps.find((step) => step.nativeMetric === 'tests_passed')
  const contractOk = contract?.passed === true && contract.emittedMetrics.contract_ok === true && numberAtLeast(contract.emittedMetrics.implementation_file_count, 1)
  const compileOk = compile?.passed === true && compile.emittedMetrics.compile_passed === true
  const testsOk = tests?.passed === true && tests.emittedMetrics.tests_passed === true
  return { ...metrics, submission_contract: contractOk, compile_passed: contractOk && compileOk && testsOk, tests_passed: testsOk, verifier_protocol_valid: contract !== undefined && compile !== undefined && tests !== undefined }
}

function numberAtLeast(value: unknown, minimum: number): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= minimum }

import type { ProgramBenchSubmissionContract, ProgramBenchSubmissionContractProgress } from './programbench-contract.js'

export type ProgramBenchCompletionControlClassification =
  | 'contract_satisfied'
  | 'artifact_progress'
  | 'implementation_write_through_failure'
  | 'promise_without_artifacts'
  | 'no_artifact_progress'

export type ProgramBenchCompletionControlAction =
  | 'accept_final'
  | 'continue_same_session'
  | 'stop_no_progress'

export type ProgramBenchCompletionControl = {
  classification: ProgramBenchCompletionControlClassification
  action: ProgramBenchCompletionControlAction
  unfinished: boolean
  final_response_promises_files: boolean
  missing_required_artifacts: readonly string[]
  reason: string
}

const PROMISE_PATTERNS = [
  /\b(?:i\s+will|i'll|let\s+me|now\s+i\s+will|i\s+need\s+to)\b[^.\n]{0,120}\b(?:write|create|implement|add)\b/i,
  /\b(?:write|create|implement|add)\b[^.\n]{0,120}\b(?:source|code|implementation|compile\.sh|files?)\b/i,
]

export function classifyProgramBenchCompletionControl(input: {
  contract: ProgramBenchSubmissionContract
  progress?: ProgramBenchSubmissionContractProgress
  responseText: string
}): ProgramBenchCompletionControl {
  const missing = missingRequiredArtifacts(input.contract)
  const promisesFiles = PROMISE_PATTERNS.some((pattern) => pattern.test(input.responseText))
  if (input.contract.reason_codes.includes('bootstrap_scaffold_not_replaced') || input.contract.checks.implementation_written_through_after_bootstrap === false) {
    return {
      classification: 'implementation_write_through_failure',
      action: 'stop_no_progress',
      unfinished: true,
      final_response_promises_files: promisesFiles,
      missing_required_artifacts: ['agent_authored_implementation'],
      reason: 'runner bootstrap scaffold is still the only implementation; native score would be scaffold baseline evidence',
    }
  }
  if (input.contract.ok) {
    return {
      classification: 'contract_satisfied',
      action: 'accept_final',
      unfinished: false,
      final_response_promises_files: promisesFiles,
      missing_required_artifacts: [],
      reason: 'minimum ProgramBench submission contract is satisfied',
    }
  }
  if (promisesFiles && input.progress?.classification === 'no_progress' && missing.length > 0) {
    return {
      classification: 'promise_without_artifacts',
      action: 'stop_no_progress',
      unfinished: true,
      final_response_promises_files: true,
      missing_required_artifacts: missing,
      reason: 'assistant promised file creation again but the continuation produced no required-artifact progress',
    }
  }
  if (promisesFiles && missing.length > 0) {
    return {
      classification: 'promise_without_artifacts',
      action: 'continue_same_session',
      unfinished: true,
      final_response_promises_files: true,
      missing_required_artifacts: missing,
      reason: 'assistant final response promised file creation while required artifacts were still missing',
    }
  }
  if (input.progress?.improved) {
    return {
      classification: 'artifact_progress',
      action: 'continue_same_session',
      unfinished: true,
      final_response_promises_files: promisesFiles,
      missing_required_artifacts: missing,
      reason: 'contract improved but required artifacts are still missing',
    }
  }
  return {
    classification: 'no_artifact_progress',
    action: 'stop_no_progress',
    unfinished: missing.length > 0,
    final_response_promises_files: promisesFiles,
    missing_required_artifacts: missing,
    reason: 'no required-artifact progress was detected',
  }
}

function missingRequiredArtifacts(contract: ProgramBenchSubmissionContract): string[] {
  const missing: string[] = []
  if (!implementationFilesPresent(contract)) missing.push('source_files')
  if (!contract.checks.compile_sh_exists) missing.push('compile.sh')
  else if (!contract.checks.compile_sh_executable) missing.push('compile.sh_executable')
  return missing
}

function implementationFilesPresent(contract: ProgramBenchSubmissionContract): boolean {
  if (Array.isArray(contract.implementation_files)) return contract.implementation_files.length > 0
  return contract.source_files.some(isImplementationFile)
}

function isImplementationFile(path: string): boolean {
  const name = path.split('/').at(-1) ?? path
  if (name === 'Makefile') return true
  return /\.(c|cc|cpp|cxx|go|rs|sh|py|java|js|ts|mk)$/i.test(name)
}

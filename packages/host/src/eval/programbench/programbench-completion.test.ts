import { describe, expect, it } from 'vitest'

import { classifyProgramBenchCompletionControl } from './programbench-completion.js'
import type { ProgramBenchSubmissionContract, ProgramBenchSubmissionContractProgress } from './programbench-contract.js'

describe('ProgramBench completion control', () => {
  it('classifies a satisfied submission contract', () => {
    const control = classifyProgramBenchCompletionControl({
      contract: contract({ ok: true, compile: true, executable: true, sources: ['main.c'], reasons: [] }),
      responseText: 'Done.',
    })

    expect(control).toMatchObject({
      classification: 'contract_satisfied',
      action: 'accept_final',
      unfinished: false,
      final_response_promises_files: false,
      missing_required_artifacts: [],
    })
  })

  it('detects a promise to write files while required artifacts are absent', () => {
    const control = classifyProgramBenchCompletionControl({
      contract: contract({ ok: false, compile: false, executable: false, sources: [], reasons: ['missing_compile_sh', 'missing_source_files'] }),
      responseText: 'Now I will write the complete implementation and compile script.',
    })

    expect(control).toMatchObject({
      classification: 'promise_without_artifacts',
      action: 'continue_same_session',
      unfinished: true,
      final_response_promises_files: true,
      missing_required_artifacts: ['source_files', 'compile.sh'],
    })
  })

  it('blocks native scoring when only runner bootstrap scaffold is present', () => {
    const control = classifyProgramBenchCompletionControl({
      contract: contract({ ok: false, compile: true, executable: true, sources: ['main.c'], reasons: ['bootstrap_scaffold_not_replaced'], writtenThrough: false }),
      responseText: 'Now I will implement seqtk fully.',
    })

    expect(control).toMatchObject({
      classification: 'implementation_write_through_failure',
      action: 'stop_no_progress',
      unfinished: true,
      final_response_promises_files: true,
      missing_required_artifacts: ['agent_authored_implementation'],
    })
  })

  it('keeps artifact progress distinct from completion', () => {
    const progress: ProgramBenchSubmissionContractProgress = {
      classification: 'progress',
      improved: true,
      resolved_reason_codes: ['missing_source_files'],
      new_reason_codes: [],
      remaining_reason_codes: ['missing_compile_sh'],
      source_file_delta: 1,
      implementation_file_delta: 1,
      compile_sh_created: false,
      compile_sh_became_executable: false,
    }

    const control = classifyProgramBenchCompletionControl({
      contract: contract({ ok: false, compile: false, executable: false, sources: ['seqtk.c'], reasons: ['missing_compile_sh'] }),
      progress,
      responseText: 'I created seqtk.c but still need compile.sh.',
    })

    expect(control).toMatchObject({
      classification: 'artifact_progress',
      action: 'continue_same_session',
      unfinished: true,
      final_response_promises_files: false,
      missing_required_artifacts: ['compile.sh'],
    })
  })

  it('does not treat header-only artifacts as a completed source requirement', () => {
    const control = classifyProgramBenchCompletionControl({
      contract: contract({ ok: false, compile: true, executable: true, sources: ['kseq.h'], reasons: ['missing_source_files'] }),
      responseText: 'I need to write the full seqtk.c implementation.',
    })

    expect(control).toMatchObject({
      classification: 'promise_without_artifacts',
      action: 'continue_same_session',
      unfinished: true,
      missing_required_artifacts: ['source_files'],
    })
  })

  it('stops repeated no-progress repairs as an unfinished failure', () => {
    const progress: ProgramBenchSubmissionContractProgress = {
      classification: 'no_progress',
      improved: false,
      resolved_reason_codes: [],
      new_reason_codes: [],
      remaining_reason_codes: ['missing_compile_sh'],
      source_file_delta: 0,
      implementation_file_delta: 0,
      compile_sh_created: false,
      compile_sh_became_executable: false,
    }

    const control = classifyProgramBenchCompletionControl({
      contract: contract({ ok: false, compile: false, executable: false, sources: ['main.c'], reasons: ['missing_compile_sh'] }),
      progress,
      responseText: 'I inspected the workspace.',
    })

    expect(control).toMatchObject({
      classification: 'no_artifact_progress',
      action: 'stop_no_progress',
      unfinished: true,
      missing_required_artifacts: ['compile.sh'],
    })
  })

  it('stops a no-progress promise loop instead of spending another continuation', () => {
    const progress: ProgramBenchSubmissionContractProgress = {
      classification: 'no_progress',
      improved: false,
      resolved_reason_codes: [],
      new_reason_codes: [],
      remaining_reason_codes: ['compile_sh_not_executable', 'missing_source_files'],
      source_file_delta: 0,
      implementation_file_delta: 0,
      compile_sh_created: false,
      compile_sh_became_executable: false,
    }

    const control = classifyProgramBenchCompletionControl({
      contract: contract({ ok: false, compile: true, executable: false, sources: ['kseq.h'], reasons: ['compile_sh_not_executable', 'missing_source_files'] }),
      progress,
      responseText: "I'll write the seqtk.c source file and fix compile.sh immediately.",
    })

    expect(control).toMatchObject({
      classification: 'promise_without_artifacts',
      action: 'stop_no_progress',
      unfinished: true,
      final_response_promises_files: true,
      missing_required_artifacts: ['source_files', 'compile.sh_executable'],
    })
  })
})

function contract(input: {
  ok: boolean
  compile: boolean
  executable: boolean
  sources: string[]
  reasons: string[]
  writtenThrough?: boolean
}): ProgramBenchSubmissionContract {
  const implementationFiles = input.sources.filter((file) => !/\.(h|hpp)$/i.test(file))
  return {
    schema_version: 1,
    ok: input.ok,
    checks: {
      compile_sh_exists: input.compile,
      compile_sh_executable: input.executable,
      source_files_present: implementationFiles.length > 0,
      implementation_files_present: implementationFiles.length > 0,
      implementation_written_through_after_bootstrap: input.writtenThrough ?? true,
      reference_executable_present_before_packaging: true,
    },
    source_file_count: input.sources.length,
    source_files: input.sources,
    implementation_file_count: implementationFiles.length,
    implementation_files: implementationFiles,
    reason_codes: input.reasons,
    required_actions: [],
    runner_normalizations: [],
  }
}

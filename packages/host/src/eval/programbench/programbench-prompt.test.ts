import { describe, expect, it } from 'vitest'

import { buildProgramBenchContractRepairPrompt, buildProgramBenchPrompt } from './programbench-prompt.js'
import type { ProgramBenchSubmissionContract } from './programbench-contract.js'

describe('ProgramBench prompt', () => {
  const workspace = '/tmp/legacy-runner/artifacts/program-bench/run/agent-runlab/case/workspace'

  it('separates filesystem host path from container bash path', () => {
    const prompt = buildProgramBenchPrompt({ instance_id: 'owner__repo.abc', repository: 'owner/repo', language: 'c' }, workspace)

    expect(prompt).toContain(`Host workspace path for filesystem tools: ${workspace}`)
    expect(prompt).toContain('Bash workspace path: /workspace')
    expect(prompt).toContain('do not cd to the host workspace path')
    expect(prompt).toContain('Before doing extended reference-executable probing, create the minimum submission skeleton')
    expect(prompt).toContain('Runner-provided scaffold')
    expect(prompt).toContain('placeholder scaffolding only, not as a completed solution')
    expect(prompt).toContain('Passing test -x ./compile.sh, or compiling an empty placeholder program, is not enough')
    expect(prompt).toContain('Filesystem tools run on the host workspace path, not /workspace')
    expect(prompt).toContain('If a filesystem write to /workspace fails, immediately retry')
    expect(prompt).toContain('The benchmark gives no credit for analysis without files')
    expect(prompt).toContain('A final answer like "now I will write the source" is a failed run')
    expect(prompt).not.toContain('Current task workspace:')
  })

  it('uses the same path semantics in repair prompts', () => {
    const contract: ProgramBenchSubmissionContract = {
      schema_version: 1,
      ok: false,
      checks: {
        compile_sh_exists: false,
        compile_sh_executable: false,
        source_files_present: false,
        implementation_files_present: false,
        implementation_written_through_after_bootstrap: true,
        reference_executable_present_before_packaging: true,
      },
      source_file_count: 0,
      source_files: [],
      implementation_file_count: 0,
      implementation_files: [],
      reason_codes: ['missing_compile_sh', 'missing_source_files'],
      required_actions: [
        'Create a top-level compile.sh file in the workspace root.',
        'Write the source/build files needed for compile.sh to build ./executable.',
      ],
      runner_normalizations: [],
    }

    const prompt = buildProgramBenchContractRepairPrompt({ instance_id: 'owner__repo.abc' }, workspace, contract)

    expect(prompt).toContain(`Host workspace path for filesystem tools: ${workspace}`)
    expect(prompt).toContain('Bash workspace path: /workspace')
    expect(prompt).toContain('do not cd to the host workspace path')
    expect(prompt).toContain('do not start by investigating the reference executable again')
    expect(prompt).toContain('runner-provided placeholder scaffolding')
    expect(prompt).toContain('replace or extend them into a real implementation')
    expect(prompt).toContain('First create a top-level ./compile.sh and at least one source file')
    expect(prompt).toContain('minimum-artifact-completion task')
    expect(prompt).toContain('Source files are missing')
    expect(prompt).toContain('the only acceptable next action is a file-writing tool call')
    expect(prompt).toContain('Filesystem tools run on the host workspace path, not /workspace')
    expect(prompt).toContain('Do not finish with a promise to write files')
    expect(prompt).toContain('- missing_compile_sh')
    expect(prompt).not.toContain('Current task workspace:')
  })

  it('turns missing compile.sh with existing sources into an entrypoint-focused repair', () => {
    const contract: ProgramBenchSubmissionContract = {
      schema_version: 1,
      ok: false,
      checks: {
        compile_sh_exists: false,
        compile_sh_executable: false,
        source_files_present: true,
        implementation_files_present: true,
        implementation_written_through_after_bootstrap: true,
        reference_executable_present_before_packaging: true,
      },
      source_file_count: 2,
      source_files: ['kseq.h', 'seqtk.c'],
      implementation_file_count: 1,
      implementation_files: ['seqtk.c'],
      reason_codes: ['missing_compile_sh'],
      required_actions: ['Create a top-level compile.sh file in the workspace root.'],
      runner_normalizations: [],
    }

    const prompt = buildProgramBenchContractRepairPrompt({ instance_id: 'lh3__seqtk.94e7070' }, workspace, contract)

    expect(prompt).toContain('entrypoint-completion task')
    expect(prompt).toContain('Source files are already present but top-level ./compile.sh is missing')
    expect(prompt).toContain('- kseq.h')
    expect(prompt).toContain('- seqtk.c')
    expect(prompt).toContain('Create ./compile.sh first')
  })
})

import { describe, expect, it } from 'vitest'

import { buildProgramBenchCompileRepairPrompt, classifyProgramBenchCompileRepair } from './programbench-compile-repair.js'
import type { ProgramBenchCompileProbe } from './programbench-compile.js'
import type { ProgramBenchSubmissionContract } from './programbench-contract.js'

describe('ProgramBench compile repair', () => {
  it('does not run compile repair before the artifact contract is satisfied', () => {
    const control = classifyProgramBenchCompileRepair({
      contract: contract({ ok: false }),
      compileProbe: probe({ ok: false, status: 'failed', reasons: ['compile_failed'] }),
    })

    expect(control).toMatchObject({
      classification: 'artifact_contract_not_satisfied',
      action: 'stop_until_artifact_contract_fixed',
      unfinished: true,
    })
  })

  it('classifies failed compilation after a satisfied contract as bounded compile repair', () => {
    const control = classifyProgramBenchCompileRepair({
      contract: contract({ ok: true }),
      compileProbe: probe({ ok: false, status: 'failed', reasons: ['compile_failed'], stderr: 'undefined reference to `main`' }),
    })

    expect(control).toMatchObject({
      classification: 'compile_failed_after_contract',
      action: 'continue_compile_repair',
      unfinished: true,
      compile_reason_codes: ['compile_failed'],
    })
    expect(control.stderr_preview).toContain('undefined reference')
  })

  it('accepts a passing compile probe', () => {
    const control = classifyProgramBenchCompileRepair({
      contract: contract({ ok: true }),
      compileProbe: probe({ ok: true, status: 'passed', reasons: [] }),
    })

    expect(control).toMatchObject({
      classification: 'compile_passed',
      action: 'accept_compile',
      unfinished: false,
    })
  })

  it('builds a compile-focused repair prompt from probe stderr', () => {
    const prompt = buildProgramBenchCompileRepairPrompt({
      item: { instance_id: 'lh3__seqtk.94e7070', repository: 'lh3/seqtk', language: 'c' },
      workspaceRoot: '/tmp/workspace',
      contract: contract({ ok: true }),
      compileProbe: probe({ ok: false, status: 'failed', reasons: ['compile_failed'], stderr: 'kroundup32 undeclared\nundefined reference to `main`' }),
    })

    expect(prompt).toContain('The minimum artifact contract is already satisfied')
    expect(prompt).toContain('The next blocker is compile failure')
    expect(prompt).toContain('Do not restart from scratch')
    expect(prompt).toContain('- seqtk.c')
    expect(prompt).toContain('kroundup32 undeclared')
    expect(prompt).toContain('undefined reference to `main`')
    expect(prompt).toContain('run ./compile.sh')
  })
})

function contract(input: { ok: boolean }): ProgramBenchSubmissionContract {
  return {
    schema_version: 1,
    ok: input.ok,
    checks: {
      compile_sh_exists: input.ok,
      compile_sh_executable: input.ok,
      source_files_present: true,
      implementation_files_present: true,
      implementation_written_through_after_bootstrap: true,
      reference_executable_present_before_packaging: true,
    },
    source_file_count: 1,
    source_files: ['seqtk.c'],
    implementation_file_count: 1,
    implementation_files: ['seqtk.c'],
    reason_codes: input.ok ? [] : ['missing_compile_sh'],
    required_actions: [],
    runner_normalizations: [],
  }
}

function probe(input: {
  ok: boolean
  status: ProgramBenchCompileProbe['status']
  reasons: string[]
  stderr?: string
}): ProgramBenchCompileProbe {
  return {
    schema_version: 1,
    kind: 'programbench_compile_probe',
    ok: input.ok,
    status: input.status,
    workspace_root: '/tmp/workspace',
    docker_image: 'programbench/example:task_cleanroom_v6',
    timeout_ms: 300_000,
    command: ['bash', '-lc', './compile.sh'],
    exit_code: input.ok ? 0 : 1,
    signal: null,
    duration_ms: 10,
    stdout: '',
    stderr: input.stderr ?? '',
    reason_codes: input.reasons,
  }
}

import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bootstrapProgramBenchSubmissionSkeleton, programBenchAgentRunlabCommandArgs, programBenchAgentRunnerTimeoutMs, shouldRunProgramBenchCompileRepair, shouldRunProgramBenchContractContinuation, shouldSkipProgramBenchAgentRun } from '../../../bin/run-programbench-legacy-runner.js'
import { inspectProgramBenchSubmissionContract, type ProgramBenchSubmissionContract } from './programbench-contract.js'
import type { ProgramBenchCompileRepairControl } from './programbench-compile-repair.js'

describe('ProgramBench runner policy', () => {
  it('runs bounded outer contract continuation for Agent RunLab when the main prompt runner leaves missing artifacts', () => {
    expect(shouldRunProgramBenchContractContinuation(
      'agent-runlab',
      { repairContract: true, contractContinuationAttempts: 2 },
      contract({ ok: false, compile: false, executable: false, sources: ['kseq.h'], reasons: ['missing_compile_sh'] }),
    )).toBe(true)
  })

  it('runs outer contract continuation for Claude Code under the artifact contract gate', () => {
    expect(shouldRunProgramBenchContractContinuation(
      'claude-code',
      { repairContract: true, contractContinuationAttempts: 2 },
      contract({ ok: false, compile: true, executable: true, sources: [], reasons: ['missing_source_files'] }),
    )).toBe(true)
  })

  it('does not run continuation when disabled, exhausted, or contract is already satisfied', () => {
    const missing = contract({ ok: false, compile: false, executable: false, sources: [], reasons: ['missing_compile_sh', 'missing_source_files'] })
    const satisfied = contract({ ok: true, compile: true, executable: true, sources: ['main.c'], reasons: [] })

    expect(shouldRunProgramBenchContractContinuation('claude-code', { repairContract: false, contractContinuationAttempts: 2 }, missing)).toBe(false)
    expect(shouldRunProgramBenchContractContinuation('claude-code', { repairContract: true, contractContinuationAttempts: 0 }, missing)).toBe(false)
    expect(shouldRunProgramBenchContractContinuation('claude-code', { repairContract: true, contractContinuationAttempts: 2 }, satisfied)).toBe(false)
  })

  it('runs compile repair only for compile-repair control actions with remaining attempts', () => {
    expect(shouldRunProgramBenchCompileRepair(
      { compileRepairAttempts: 1 },
      compileRepairControl({ action: 'continue_compile_repair' }),
    )).toBe(true)
    expect(shouldRunProgramBenchCompileRepair(
      { compileRepairAttempts: 0 },
      compileRepairControl({ action: 'continue_compile_repair' }),
    )).toBe(false)
    expect(shouldRunProgramBenchCompileRepair(
      { compileRepairAttempts: 1 },
      compileRepairControl({ action: 'stop_until_artifact_contract_fixed' }),
    )).toBe(false)
    expect(shouldRunProgramBenchCompileRepair(
      { compileRepairAttempts: 1 },
      compileRepairControl({ action: 'accept_compile' }),
    )).toBe(false)
  })

  it('wraps agent subprocesses with an outer hard timeout grace period', () => {
    expect(programBenchAgentRunnerTimeoutMs(900_000)).toBe(960_000)
  })

  it('passes the ProgramBench output-token budget to the Agent RunLab prompt runner', () => {
    const argv = programBenchAgentRunlabCommandArgs(
      {
        model: 'claude-sonnet-4-6',
        timeoutMs: 900_000,
        repairMaxTurns: 4,
        repairContract: true,
        contractContinuationAttempts: 2,
        agentRunlabMaxOutputTokens: 32_000,
        agentRunlabInactivityTimeoutMs: 120_000,
      },
      '/tmp/prompt.txt',
      '/tmp/workspace',
      '/tmp/case',
      {
        responsePath: '/tmp/response.txt',
        artifactsDir: '/tmp/artifacts',
        maxTurns: 20,
      },
      'programbench/image:task_cleanroom_v6',
    )

    expect(argv).toContain('--max-output-tokens')
    expect(argv[argv.indexOf('--max-output-tokens') + 1]).toBe('32000')
    expect(argv).toContain('--inactivity-timeout-ms')
    expect(argv[argv.indexOf('--inactivity-timeout-ms') + 1]).toBe('120000')
  })

  it('applies stop gates only from the beginning of a case so the comparator side can still run', () => {
    expect(shouldSkipProgramBenchAgentRun(undefined)).toBe(false)
    expect(shouldSkipProgramBenchAgentRun('stop_after_errors:1')).toBe(true)
  })

  it('bootstraps a shared ProgramBench skeleton as runner-normalized scaffolding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'programbench-bootstrap-'))
    try {
      const normalization = await bootstrapProgramBenchSubmissionSkeleton({ language: 'c' }, dir)
      const contract = await inspectProgramBenchSubmissionContract(dir, [normalization])
      const compile = await readFile(join(dir, 'compile.sh'), 'utf8')
      const source = await readFile(join(dir, 'main.c'), 'utf8')

      expect(normalization).toMatchObject({
        kind: 'runner_bootstrap_submission_skeleton',
        applied: true,
        files: ['compile.sh', 'main.c'],
      })
      expect(compile).toContain('gcc -O2 -o executable main.c')
      expect(source).toContain('int main')
      expect(contract.ok).toBe(false)
      expect(contract.checks.implementation_written_through_after_bootstrap).toBe(false)
      expect(contract.reason_codes).toContain('bootstrap_scaffold_not_replaced')
      expect(contract.runner_normalizations).toEqual([normalization])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function contract(input: {
  ok: boolean
  compile: boolean
  executable: boolean
  sources: string[]
  reasons: string[]
}): ProgramBenchSubmissionContract {
  return {
    schema_version: 1,
    ok: input.ok,
    checks: {
      compile_sh_exists: input.compile,
      compile_sh_executable: input.executable,
      source_files_present: input.sources.length > 0,
      implementation_files_present: input.sources.length > 0,
      implementation_written_through_after_bootstrap: true,
      reference_executable_present_before_packaging: true,
    },
    source_file_count: input.sources.length,
    source_files: input.sources,
    implementation_file_count: input.sources.length,
    implementation_files: input.sources,
    reason_codes: input.reasons,
    required_actions: [],
    runner_normalizations: [],
  }
}

function compileRepairControl(input: { action: ProgramBenchCompileRepairControl['action'] }): ProgramBenchCompileRepairControl {
  return {
    classification: input.action === 'accept_compile'
      ? 'compile_passed'
      : input.action === 'stop_until_artifact_contract_fixed'
        ? 'artifact_contract_not_satisfied'
        : 'compile_failed_after_contract',
    action: input.action,
    unfinished: input.action !== 'accept_compile',
    reason: 'test control',
    compile_reason_codes: input.action === 'accept_compile' ? [] : ['compile_failed'],
    stderr_preview: '',
  }
}

#!/usr/bin/env tsx
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { createRuntimeLogger } from '../src/logger.js'
import { benchmarkStopReason, type BenchmarkStopGateStats } from '../src/eval/core/benchmark-stop-gates.js'
import {
  collectProgramBenchSourceFiles,
  compareProgramBenchSubmissionContracts,
  inspectProgramBenchSubmissionContract,
  maybeNormalizeProgramBenchCompileShExecutable,
  type ProgramBenchSubmissionContract,
  type ProgramBenchSubmissionContractNormalization,
  type ProgramBenchSubmissionContractProgress,
} from '../src/eval/programbench/programbench-contract.js'
import {
  buildProgramBenchContractRepairPrompt,
  buildProgramBenchPrompt,
} from '../src/eval/programbench/programbench-prompt.js'
import { classifyProgramBenchCompletionControl, type ProgramBenchCompletionControl } from '../src/eval/programbench/programbench-completion.js'
import { runProgramBenchCompileProbe, type ProgramBenchCompileProbe } from '../src/eval/programbench/programbench-compile.js'
import {
  buildProgramBenchCompileRepairPrompt,
  classifyProgramBenchCompileRepair,
  type ProgramBenchCompileRepairControl,
} from '../src/eval/programbench/programbench-compile-repair.js'
import { defaultBenchmarkEnvPath, loadAnthropicCliDefaults, loadEnvFile, redactedUrlForArtifact, requireAnthropicBaseUrl } from '../src/runtime-config.js'

type AgentName = 'agent-runlab' | 'claude-code'

type Args = {
  portfolioDir: string
  casesPath: string
  agents: readonly AgentName[]
  model: string
  baseUrl: string
  baseUrlSource: 'cli' | 'env' | 'env-file' | 'claude-settings'
  smallFastModel: string
  timeoutMs: number
  claudeInactivityTimeoutMs?: number
  agentRunlabInactivityTimeoutMs?: number
  nativeEvalTimeoutMs: number
  maxTurns: number
  repairContract: boolean
  repairMaxTurns: number
  agentRunlabMaxOutputTokens: number
  contractContinuationAttempts: number
  compileRepairAttempts: number
  normalizeCompileShExecutable: boolean
  bootstrapSubmissionSkeleton: boolean
  maxAgentRuns?: number
  stopAfterErrors?: number
  stopAfterContractFailures?: number
  runId: string
  dryRun: boolean
  caseIds: readonly string[]
  limit?: number
  offset: number
}

type ProgramBenchCase = {
  benchmark: 'program-bench'
  instance_id: string
  repository?: string
  commit?: string
  language?: string
  difficulty?: string | null
  image_name?: string
  active_test_branches?: number
}

type InstanceResult = {
  benchmark: 'program-bench'
  instance_id: string
  agent: AgentName
  model: string
  status: 'prepared' | 'submitted' | 'scored' | 'not_run' | 'error'
  score: number
  official: boolean
  scorer: string
  error_type: string | null
  artifact_refs: string[]
  submission_contract?: ProgramBenchSubmissionContract
  completion_control?: ProgramBenchCompletionControl
  completion_control_failure?: string | null
  compile_probe?: ProgramBenchCompileProbe
  compile_probe_failure?: string | null
  compile_repair_control?: ProgramBenchCompileRepairControl
}

type RunAgentOptions = {
  responsePath: string
  sessionLogPath?: string
  metadataPath?: string
  sessionsDir?: string
  artifactsDir: string
  caseJsonPath?: string
  maxTurns: number
}

type RunStats = BenchmarkStopGateStats & {
  stopReason?: string
}

type RunProgress = {
  args: Args
  runRoot: string
  current?: {
    agent: AgentName
    instance_id: string
    case_root: string
  }
  results: InstanceResult[]
  stats: RunStats
}

class ProgramBenchControlledStop extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProgramBenchControlledStop'
  }
}

export function shouldRunProgramBenchContractContinuation(
  agent: AgentName,
  args: Pick<Args, 'repairContract' | 'contractContinuationAttempts'>,
  contract: ProgramBenchSubmissionContract,
): boolean {
  return (agent === 'agent-runlab' || agent === 'claude-code') && !contract.ok && args.repairContract && args.contractContinuationAttempts > 0
}

export function shouldRunProgramBenchCompileRepair(
  args: Pick<Args, 'compileRepairAttempts'>,
  control: ProgramBenchCompileRepairControl,
): boolean {
  return control.action === 'continue_compile_repair' && args.compileRepairAttempts > 0
}

export function shouldSkipProgramBenchAgentRun(stopReasonBeforeCase: string | undefined): boolean {
  return stopReasonBeforeCase !== undefined
}

const logger = createRuntimeLogger('programbench-portfolio')
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp()
    return
  }
  const args = parseArgs(process.argv.slice(2))
  const cases = selectCases(await readJsonl<ProgramBenchCase>(args.casesPath), args)
  const root = join(args.portfolioDir, 'artifacts', 'program-bench')
  const runRoot = join(root, args.runId)
  await mkdir(runRoot, { recursive: true })

  const results: InstanceResult[] = []
  const stats: RunStats = { attemptedAgentRuns: 0, errors: 0, contractFailures: 0 }
  const progress: RunProgress = { args, runRoot, results, stats }
  installInterruptedRunSummaryHandlers(progress)
  for (const item of cases) {
    const stopReasonBeforeCase = stats.stopReason
    for (const agent of args.agents) {
      const caseRoot = join(runRoot, agent, item.instance_id)
      const workspaceRoot = join(caseRoot, 'workspace')
      const submissionDir = join(runRoot, 'submissions', agent, item.instance_id)
      const promptPath = join(caseRoot, 'prompt.txt')
      const responsePath = join(caseRoot, 'response.txt')
      const manifestPath = join(caseRoot, 'run-manifest.json')
      const caseJsonPath = join(caseRoot, 'programbench-case.json')
      progress.current = { agent, instance_id: item.instance_id, case_root: relativeToPortfolio(args.portfolioDir, caseRoot) }
      await rm(workspaceRoot, { recursive: true, force: true })
      await mkdir(workspaceRoot, { recursive: true })
      await mkdir(submissionDir, { recursive: true })
      await writeFile(promptPath, buildProgramBenchPrompt(item, workspaceRoot), 'utf8')
      await writeFile(caseJsonPath, `${JSON.stringify(item, null, 2)}\n`, 'utf8')
      await writeFile(manifestPath, `${JSON.stringify({
        schema_version: 1,
        benchmark: 'program-bench',
        run_id: args.runId,
        agent,
        model: args.model,
        anthropic_base_url: redactedUrlForArtifact(args.baseUrl),
        anthropic_base_url_source: args.baseUrlSource,
        instance: item,
        workspace_root: relativeToPortfolio(args.portfolioDir, workspaceRoot),
        prompt: relativeToPortfolio(args.portfolioDir, promptPath),
        case_json: relativeToPortfolio(args.portfolioDir, caseJsonPath),
        response: relativeToPortfolio(args.portfolioDir, responsePath),
        submission_archive: relativeToPortfolio(args.portfolioDir, join(submissionDir, 'submission.tar.gz')),
        eval_json: relativeToPortfolio(args.portfolioDir, join(submissionDir, `${item.instance_id}.eval.json`)),
        native_eval_command: `programbench eval ${relativeToPortfolio(args.portfolioDir, join(runRoot, 'submissions', agent))} --filter '^${escapeRegex(item.instance_id)}$' --workers 1`,
        native_eval_timeout_ms: args.nativeEvalTimeoutMs,
        agent_runner_timeout_ms: programBenchAgentRunnerTimeoutMs(args.timeoutMs),
        agent_runlab_max_output_tokens: agent === 'agent-runlab' ? args.agentRunlabMaxOutputTokens : null,
        agent_runlab_inactivity_timeout_ms: agent === 'agent-runlab' ? args.agentRunlabInactivityTimeoutMs ?? null : null,
        claude_inactivity_timeout_ms: args.claudeInactivityTimeoutMs,
        internet_policy: 'web tools disabled in runners; task workspace must not use internet during inference',
        bash_isolation: agent === 'agent-runlab'
          ? {
              mode: 'docker_network_none',
              image: item.image_name ? `${item.image_name}:task_cleanroom_v6` : null,
              workspace_mount: '/workspace',
            }
          : {
              mode: 'docker_network_none_mcp_bash',
              image: item.image_name ? `${item.image_name}:task_cleanroom_v6` : null,
              workspace_scope: relativeToPortfolio(args.portfolioDir, workspaceRoot),
            },
        contract_repair: {
          enabled: args.repairContract,
          max_turns: args.repairMaxTurns,
          continuation_attempts: args.contractContinuationAttempts,
          mode: agent === 'agent-runlab' ? 'bounded_agent_runlab_repair_invocations_after_prompt_runner' : 'bounded_claude_code_repair_invocations',
        },
        compile_repair: {
          attempts: args.compileRepairAttempts,
          max_turns_per_attempt: args.repairMaxTurns,
          applies_after: 'submission contract satisfied and compile probe failed or timed out',
          mode: agent === 'agent-runlab' ? 'bounded_agent_runlab_compile_repair_invocations' : 'bounded_claude_code_compile_repair_invocations',
        },
        runner_normalization: {
          normalize_compile_sh_executable: args.normalizeCompileShExecutable,
          scope: 'Only chmod an existing top-level compile.sh; never create files or edit contents.',
        },
        runner_bootstrap: {
          submission_skeleton: args.bootstrapSubmissionSkeleton,
          scope: 'If enabled, write the same minimal compile.sh plus empty implementation entrypoint into both agent workspaces before inference; recorded as runner bootstrap, not agent-authored work.',
        },
        stop_gates: {
          max_agent_runs: args.maxAgentRuns,
          stop_after_errors: args.stopAfterErrors,
          stop_after_contract_failures: args.stopAfterContractFailures,
        },
        dry_run: args.dryRun,
      }, null, 2)}\n`, 'utf8')

      let status: InstanceResult['status'] = 'prepared'
      let errorType: string | null = null
      let score = 0
      let official = false
      let scorer = 'programbench.eval.pending'
      if (!args.dryRun && shouldSkipProgramBenchAgentRun(stopReasonBeforeCase)) {
        status = 'not_run'
        errorType = `stop_gate:${stopReasonBeforeCase}`
        await writeFile(join(caseRoot, 'skipped.txt'), `${errorType}\n`, 'utf8')
      } else if (!args.dryRun) {
        stats.attemptedAgentRuns += 1
        try {
          await prepareCleanroomWorkspace(item, workspaceRoot, caseRoot)
          const benchmarkImage = `${item.image_name}:task_cleanroom_v6`
          const runnerNormalizations: ProgramBenchSubmissionContractNormalization[] = []
          if (args.bootstrapSubmissionSkeleton) {
            const bootstrap = await bootstrapProgramBenchSubmissionSkeleton(item, workspaceRoot)
            runnerNormalizations.push(bootstrap)
            await writeFile(join(caseRoot, 'submission-contract-normalization.bootstrap.json'), `${JSON.stringify(bootstrap, null, 2)}\n`, 'utf8')
          }
          try {
            await runAgent(agent, args, promptPath, workspaceRoot, caseRoot, {
              responsePath,
              sessionLogPath: join(caseRoot, 'agent-runlab-session.jsonl'),
              metadataPath: join(caseRoot, 'agent-runlab-metadata.json'),
              sessionsDir: join(caseRoot, 'sessions'),
              artifactsDir: agent === 'agent-runlab' ? join(caseRoot, 'artifacts') : join(caseRoot, 'claude-code-artifacts'),
              caseJsonPath,
              maxTurns: args.maxTurns,
            }, benchmarkImage)
          } catch (err: unknown) {
            errorType = err instanceof Error ? err.message : String(err)
            await writeFile(join(caseRoot, 'agent-error.txt'), `${errorType}\n`, 'utf8')
          }
          const contamination = await detectOutOfScopeProgramBenchAccess(caseRoot, workspaceRoot, runRoot)
          if (contamination.length) {
            errorType = `${errorType ? `${errorType}; ` : ''}out-of-scope workspace access detected: ${contamination.join(', ')}`
            await writeFile(join(caseRoot, 'isolation-warning.txt'), `${contamination.join('\n')}\n`, 'utf8')
          }
          let contract = await inspectProgramBenchSubmissionContract(workspaceRoot, runnerNormalizations)
          const initialContractPath = join(caseRoot, 'submission-contract.initial.json')
          if (!existsSync(initialContractPath)) {
            await writeFile(initialContractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
          }
          const initialNormalization = await maybeNormalizeCompileShExecutable(args, workspaceRoot, contract)
          if (initialNormalization.applied) {
            runnerNormalizations.push({ kind: 'chmod_compile_sh_executable', ...initialNormalization })
            await writeFile(join(caseRoot, 'submission-contract-normalization.initial.json'), `${JSON.stringify(runnerNormalizations.at(-1), null, 2)}\n`, 'utf8')
            contract = await inspectProgramBenchSubmissionContract(workspaceRoot, runnerNormalizations)
          }
          if (shouldRunProgramBenchContractContinuation(agent, args, contract)) {
            const continuation = await runContractContinuationLoop({
              agent,
              args,
              item,
              workspaceRoot,
              caseRoot,
              benchmarkImage,
              initialContract: contract,
              runnerNormalizations,
            })
            contract = continuation.contract
            if (continuation.errorType) {
              errorType = `${errorType ? `${errorType}; ` : ''}${continuation.errorType}`
            }
          }
          const completionControl = classifyProgramBenchCompletionControl({
            contract,
            responseText: await latestProgramBenchResponseText(args.portfolioDir, caseRoot, responsePath),
          })
          await writeFile(join(caseRoot, 'submission-contract.json'), `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
          await writeSubmissionContractGate(args, caseRoot, contract, completionControl)
          if (completionControl.action === 'stop_no_progress' && completionControl.classification !== 'contract_satisfied') {
            errorType = `${errorType ? `${errorType}; ` : ''}completion_control_failure:${completionControl.classification}`
            status = 'submitted'
            throw new ProgramBenchControlledStop(errorType)
          }
          let compileProbe = await writeProgramBenchCompileProbe(args, workspaceRoot, caseRoot, benchmarkImage)
          let compileRepairControl = await writeProgramBenchCompileRepairGate(args, item, workspaceRoot, caseRoot, contract, compileProbe)
          if (shouldRunProgramBenchCompileRepair(args, compileRepairControl)) {
            const compileRepair = await runCompileRepairLoop({
              agent,
              args,
              item,
              workspaceRoot,
              caseRoot,
              benchmarkImage,
              initialContract: contract,
              initialCompileProbe: compileProbe,
              initialControl: compileRepairControl,
              runnerNormalizations,
            })
            contract = compileRepair.contract
            compileProbe = compileRepair.compileProbe
            compileRepairControl = compileRepair.control
            if (compileRepair.errorType) {
              errorType = `${errorType ? `${errorType}; ` : ''}${compileRepair.errorType}`
            }
            await writeFile(join(caseRoot, 'submission-contract.json'), `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
            const postCompileRepairCompletionControl = classifyProgramBenchCompletionControl({
              contract,
              responseText: await latestProgramBenchResponseText(args.portfolioDir, caseRoot, responsePath),
            })
            await writeSubmissionContractGate(args, caseRoot, contract, postCompileRepairCompletionControl)
            if (postCompileRepairCompletionControl.action === 'stop_no_progress' && postCompileRepairCompletionControl.classification !== 'contract_satisfied') {
              errorType = `${errorType ? `${errorType}; ` : ''}completion_control_failure:${postCompileRepairCompletionControl.classification}`
              status = 'submitted'
              throw new ProgramBenchControlledStop(errorType)
            }
          }
          await packageSubmission(workspaceRoot, join(submissionDir, 'submission.tar.gz'), caseRoot)
          status = errorType ? 'not_run' : 'submitted'
          await runNativeEval(args, item, agent, runRoot, caseRoot)
          const scored = await readNativeScore(item, submissionDir, caseRoot)
          status = 'scored'
          score = scored.score
          official = true
          scorer = scored.scorer
        } catch (err: unknown) {
          if (err instanceof ProgramBenchControlledStop) {
            status = 'submitted'
            errorType = err.message
            await writeFile(join(caseRoot, 'controlled-stop.txt'), `${errorType}\n`, 'utf8')
          } else {
            status = 'error'
            errorType = err instanceof Error ? err.message : String(err)
            await writeFile(join(caseRoot, 'error.txt'), `${errorType}\n`, 'utf8')
          }
        }
      }
      const contractPath = join(caseRoot, 'submission-contract.json')
      const submissionContract = existsSync(contractPath)
        ? JSON.parse(await readFile(contractPath, 'utf8')) as ProgramBenchSubmissionContract
        : undefined
      const completionControl = submissionContract
        ? classifyProgramBenchCompletionControl({
            contract: submissionContract,
            responseText: await latestProgramBenchResponseText(args.portfolioDir, caseRoot, responsePath),
          })
        : undefined
      const compileProbePath = join(caseRoot, 'compile-probe.json')
      const compileProbe = existsSync(compileProbePath)
        ? JSON.parse(await readFile(compileProbePath, 'utf8')) as ProgramBenchCompileProbe
        : undefined
      const compileRepairPath = join(caseRoot, 'compile-repair-gate.json')
      const compileRepairControl = existsSync(compileRepairPath)
        ? JSON.parse(await readFile(compileRepairPath, 'utf8')).compile_repair_control as ProgramBenchCompileRepairControl
        : undefined
      const artifactRefs = [
        relativeToPortfolio(args.portfolioDir, promptPath),
        relativeToPortfolio(args.portfolioDir, caseJsonPath),
        relativeToPortfolio(args.portfolioDir, manifestPath),
        relativeToPortfolio(args.portfolioDir, join(submissionDir, 'submission.tar.gz')),
      ]
      if (submissionContract) artifactRefs.push(relativeToPortfolio(args.portfolioDir, contractPath))
      for (const extra of ['skipped.txt', 'agent-error.txt', 'controlled-stop.txt', 'error.txt', 'isolation-warning.txt', 'native-score.json', 'native-eval-timeout.json', 'compile-probe.json', 'compile-repair-gate.json', 'compile-repair-prompt.txt', 'compile-repair-summary.json', 'submission-contract.initial.json', 'submission-contract.json', 'submission-contract-gate.json', 'submission-contract-normalization.initial.json', 'submission-contract-normalization.repair.json', 'contract-repair-prompt.txt', 'contract-repair-response.txt', 'contract-repair-error.txt', 'contract-continuation-summary.json']) {
        const extraPath = join(caseRoot, extra)
        if (existsSync(extraPath)) artifactRefs.push(relativeToPortfolio(args.portfolioDir, extraPath))
      }
      for (const extraPath of await collectContractContinuationArtifacts(caseRoot)) {
        artifactRefs.push(relativeToPortfolio(args.portfolioDir, extraPath))
      }
      for (const extraPath of await collectCompileRepairArtifacts(caseRoot)) {
        artifactRefs.push(relativeToPortfolio(args.portfolioDir, extraPath))
      }
      results.push({
        benchmark: 'program-bench',
        instance_id: item.instance_id,
        agent,
        model: args.model,
        status,
        score,
        official,
        scorer,
        error_type: errorType,
        artifact_refs: artifactRefs,
        submission_contract: submissionContract,
        completion_control: completionControl,
        completion_control_failure: completionControl && completionControl.classification !== 'contract_satisfied'
          ? `completion_control_failure:${completionControl.classification}`
          : null,
        compile_probe: compileProbe,
        compile_probe_failure: compileProbe && !compileProbe.ok
          ? `compile_probe_failure:${compileProbe.reason_codes[0] ?? compileProbe.status}`
          : null,
        compile_repair_control: compileRepairControl,
      })
      progress.current = undefined
      if (!args.dryRun && !errorType?.startsWith('stop_gate:')) {
        if (status === 'error' || errorType) stats.errors += 1
        if (submissionContract && (!submissionContract.ok || completionControl?.classification === 'implementation_write_through_failure')) stats.contractFailures += 1
      }
    }
    if (!args.dryRun && !stopReasonBeforeCase) {
      stats.stopReason = benchmarkStopReason(args, stats)
    }
  }
  progress.current = undefined

  await writeOutputs(args, runRoot, cases, results, stats)
}

function installInterruptedRunSummaryHandlers(progress: RunProgress): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      try {
        writeInterruptedRunSummarySync(progress, signal)
      } finally {
        process.exit(signal === 'SIGINT' ? 130 : 143)
      }
    })
  }
}

function writeInterruptedRunSummarySync(progress: RunProgress, signal: NodeJS.Signals): void {
  const summary = {
    schema_version: 1,
    benchmark: 'program-bench',
    run_id: progress.args.runId,
    status: 'interrupted',
    signal,
    reporting_boundary: 'interrupted run only; not a completed pairwise score, not headline ProgramBench evidence, not readiness for 5-case pilot',
    model: progress.args.model,
    current: progress.current ?? null,
    attempted_agent_runs: progress.stats.attemptedAgentRuns,
    completed_result_rows: progress.results.length,
    stop_reason: progress.stats.stopReason ?? null,
    result_rows: progress.results.map((row) => ({
      instance_id: row.instance_id,
      agent: row.agent,
      status: row.status,
      official: row.official,
      score: row.score,
      error_type: row.error_type,
      contract_ok: row.submission_contract?.ok ?? null,
      artifact_refs: row.artifact_refs,
    })),
  }
  mkdirSync(progress.runRoot, { recursive: true })
  writeFileSync(join(progress.runRoot, 'interrupted-run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(join(progress.runRoot, 'interrupted-run-summary.md'), renderInterruptedRunSummary(summary), 'utf8')
}

function renderInterruptedRunSummary(summary: {
  run_id: string
  status: string
  signal: string
  reporting_boundary: string
  attempted_agent_runs: number
  completed_result_rows: number
  current: unknown
}): string {
  return [
    '# ProgramBench Interrupted Run Summary',
    '',
    `Run: \`${summary.run_id}\``,
    `Status: \`${summary.status}\``,
    `Signal: \`${summary.signal}\``,
    '',
    summary.reporting_boundary,
    '',
    `Attempted agent runs: \`${summary.attempted_agent_runs}\``,
    `Completed result rows: \`${summary.completed_result_rows}\``,
    `Current item: \`${JSON.stringify(summary.current)}\``,
    '',
  ].join('\n')
}

function printHelp(): void {
  process.stdout.write(`Usage: pnpm --filter @agent-kernel/host exec tsx bin/run-programbench-portfolio.ts [options]

Options:
  --portfolio-dir <path>              Portfolio root (default: experiments/evals/2026-07-agent-benchmark-comparison)
  --cases <path>                      JSONL case file (default: planning/programbench/pilot-cases.jsonl)
  --agents <list>                     Comma-separated agents: agent-runlab,claude-code
  --run-id <id>                       Output run id
  --model <id>                        Model id (default: ANTHROPIC_MODEL from env file, then claude-sonnet-4-6)
  --base-url <url>                    Anthropic-compatible base URL
  --timeout-ms <n>                    Per-agent timeout
  --claude-inactivity-timeout-ms <n>   Abort Claude Code if SDK emits no messages for this long
  --agent-runlab-inactivity-timeout-ms <n> Abort Agent RunLab if the host loop emits no events for this long
  --native-eval-timeout-ms <n>        Per-case native ProgramBench eval timeout (default: 2700000)
  --max-turns <n>                     Main run max turns
  --repair-max-turns <n>              Contract continuation max turns per attempt
  --agent-runlab-max-output-tokens <n> Agent RunLab max output tokens for ProgramBench source generation (default: 32000)
  --contract-continuation-attempts <n> Bounded contract continuation attempts after the main run (default: 2)
  --compile-repair-attempts <n>       Bounded compile repair attempts after artifact contract passes (default: 1)
  --max-agent-runs <n>                Stop after this many main agent-case attempts
  --stop-after-errors <n>             Stop broadening after errors
  --stop-after-contract-failures <n>  Stop broadening after contract failures
  --case-id <id>                      Include a specific case id; repeatable
  --limit <n>                         Limit selected cases
  --offset <n>                        Skip selected cases
  --dry-run                           Prepare prompts/manifests only; no model/scorer calls
  --no-repair-contract                Disable contract continuation pass
  --no-normalize-compile-sh-executable Disable chmod-only compile.sh normalization
  --no-bootstrap-submission-skeleton  Disable shared ProgramBench compile.sh/source skeleton bootstrap
  -h, --help                          Print this help and exit
`)
}

async function maybeNormalizeCompileShExecutable(
  args: Args,
  workspaceRoot: string,
  contract: ProgramBenchSubmissionContract,
): Promise<{ applied: boolean; reason: string }> {
  return maybeNormalizeProgramBenchCompileShExecutable(workspaceRoot, contract, args.normalizeCompileShExecutable)
}

type ContractContinuationLoopOptions = {
  agent: AgentName
  args: Args
  item: ProgramBenchCase
  workspaceRoot: string
  caseRoot: string
  benchmarkImage: string
  initialContract: ProgramBenchSubmissionContract
  runnerNormalizations: ProgramBenchSubmissionContractNormalization[]
}

type ContractContinuationAttemptSummary = {
  attempt: number
  prompt: string
  response: string
  before: {
    ok: boolean
    reason_codes: readonly string[]
    source_file_count: number
    source_files: readonly string[]
    implementation_file_count: number
    implementation_files: readonly string[]
  }
  after: {
    ok: boolean
    reason_codes: readonly string[]
    source_file_count: number
    source_files: readonly string[]
    implementation_file_count: number
    implementation_files: readonly string[]
  }
  progress: ProgramBenchSubmissionContractProgress
  completion_control?: ProgramBenchCompletionControl
  error: string | null
  normalization?: ProgramBenchSubmissionContractNormalization
}

async function runContractContinuationLoop(options: ContractContinuationLoopOptions): Promise<{
  contract: ProgramBenchSubmissionContract
  errorType: string | null
}> {
  let contract = options.initialContract
  let errorType: string | null = null
  const attempts: ContractContinuationAttemptSummary[] = []
  const maxAttempts = Math.max(0, options.args.contractContinuationAttempts)

  for (let attempt = 1; attempt <= maxAttempts && !contract.ok; attempt++) {
    const legacyFirstAttempt = attempt === 1
    const promptPath = join(options.caseRoot, legacyFirstAttempt ? 'contract-repair-prompt.txt' : `contract-continuation-${attempt}-prompt.txt`)
    const responsePath = join(options.caseRoot, legacyFirstAttempt ? 'contract-repair-response.txt' : `contract-continuation-${attempt}-response.txt`)
    const errorPath = join(options.caseRoot, legacyFirstAttempt ? 'contract-repair-error.txt' : `contract-continuation-${attempt}-error.txt`)
    const before = contract
    await writeFile(promptPath, buildProgramBenchContractRepairPrompt(options.item, options.workspaceRoot, before), 'utf8')

    let attemptError: string | null = null
    try {
      await runAgent(options.agent, options.args, promptPath, options.workspaceRoot, options.caseRoot, {
        responsePath,
        sessionLogPath: join(options.caseRoot, legacyFirstAttempt ? 'agent-runlab-contract-repair-session.jsonl' : `agent-runlab-contract-continuation-${attempt}-session.jsonl`),
        metadataPath: join(options.caseRoot, legacyFirstAttempt ? 'agent-runlab-contract-repair-metadata.json' : `agent-runlab-contract-continuation-${attempt}-metadata.json`),
        sessionsDir: join(options.caseRoot, legacyFirstAttempt ? 'contract-repair-sessions' : `contract-continuation-${attempt}-sessions`),
        artifactsDir: options.agent === 'agent-runlab'
          ? join(options.caseRoot, legacyFirstAttempt ? 'contract-repair-artifacts' : `contract-continuation-${attempt}-artifacts`)
          : join(options.caseRoot, legacyFirstAttempt ? 'claude-code-contract-repair-artifacts' : `claude-code-contract-continuation-${attempt}-artifacts`),
        maxTurns: options.args.repairMaxTurns,
      }, options.benchmarkImage)
    } catch (err: unknown) {
      attemptError = err instanceof Error ? err.message : String(err)
      await writeFile(errorPath, `${attemptError}\n`, 'utf8')
    }

    contract = await inspectProgramBenchSubmissionContract(options.workspaceRoot, options.runnerNormalizations)
    const normalization = await maybeNormalizeCompileShExecutable(options.args, options.workspaceRoot, contract)
    let normalizationEntry: ProgramBenchSubmissionContractNormalization | undefined
    if (normalization.applied) {
      normalizationEntry = { kind: 'chmod_compile_sh_executable', ...normalization }
      options.runnerNormalizations.push(normalizationEntry)
      await writeFile(
        join(options.caseRoot, legacyFirstAttempt ? 'submission-contract-normalization.repair.json' : `submission-contract-normalization.continuation-${attempt}.json`),
        `${JSON.stringify(normalizationEntry, null, 2)}\n`,
        'utf8',
      )
      contract = await inspectProgramBenchSubmissionContract(options.workspaceRoot, options.runnerNormalizations)
    }
    const progress = compareProgramBenchSubmissionContracts(before, contract)
    const responseText = await readFile(responsePath, 'utf8').catch(() => '')
    const completionControl = classifyProgramBenchCompletionControl({ contract, progress, responseText })

    attempts.push({
      attempt,
      prompt: relativeToPortfolio(options.args.portfolioDir, promptPath),
      response: relativeToPortfolio(options.args.portfolioDir, responsePath),
      before: summarizeContractForContinuation(before),
      after: summarizeContractForContinuation(contract),
      progress,
      completion_control: completionControl,
      error: attemptError,
      normalization: normalizationEntry,
    })
    if (!contract.ok && completionControl.action === 'stop_no_progress') break
  }

  const exhausted = !contract.ok && maxAttempts > 0 && attempts.length >= maxAttempts
  if (attempts.some((attempt) => attempt.error)) {
    const errors = attempts
      .filter((attempt) => attempt.error)
      .map((attempt) => `attempt ${attempt.attempt}: ${attempt.error}`)
      .join('; ')
    errorType = `${errorType ? `${errorType}; ` : ''}contract continuation runner errors: ${errors}`
  }

  await writeFile(join(options.caseRoot, 'contract-continuation-summary.json'), `${JSON.stringify({
    schema_version: 1,
    enabled: options.args.repairContract,
    max_attempts: maxAttempts,
    repair_max_turns: options.args.repairMaxTurns,
    attempted: attempts.length,
    exhausted,
    final_ok: contract.ok,
    final_reason_codes: contract.reason_codes,
    stopped_after_no_progress: attempts.length > 0 && attempts.at(-1)?.completion_control?.action === 'stop_no_progress',
    final_progress_classification: attempts.at(-1)?.progress.classification ?? null,
    final_completion_control: attempts.at(-1)?.completion_control ?? null,
    attempts,
  }, null, 2)}\n`, 'utf8')

  return { contract, errorType }
}

function summarizeContractForContinuation(contract: ProgramBenchSubmissionContract): {
  ok: boolean
  reason_codes: readonly string[]
  source_file_count: number
  source_files: readonly string[]
  implementation_file_count: number
  implementation_files: readonly string[]
} {
  return {
    ok: contract.ok,
    reason_codes: contract.reason_codes,
    source_file_count: contract.source_file_count,
    source_files: contract.source_files,
    implementation_file_count: contract.implementation_file_count,
    implementation_files: contract.implementation_files,
  }
}

type CompileRepairLoopOptions = {
  agent: AgentName
  args: Args
  item: ProgramBenchCase
  workspaceRoot: string
  caseRoot: string
  benchmarkImage: string
  initialContract: ProgramBenchSubmissionContract
  initialCompileProbe: ProgramBenchCompileProbe
  initialControl: ProgramBenchCompileRepairControl
  runnerNormalizations: ProgramBenchSubmissionContractNormalization[]
}

type CompileRepairAttemptSummary = {
  attempt: number
  prompt: string
  response: string
  before: {
    contract: ReturnType<typeof summarizeContractForContinuation>
    compile_probe: ReturnType<typeof summarizeCompileProbeForRepair>
    control: ProgramBenchCompileRepairControl
    source_fingerprint: string
  }
  after: {
    contract: ReturnType<typeof summarizeContractForContinuation>
    compile_probe: ReturnType<typeof summarizeCompileProbeForRepair>
    control: ProgramBenchCompileRepairControl
    source_fingerprint: string
  }
  error: string | null
  normalization?: ProgramBenchSubmissionContractNormalization
}

async function runCompileRepairLoop(options: CompileRepairLoopOptions): Promise<{
  contract: ProgramBenchSubmissionContract
  compileProbe: ProgramBenchCompileProbe
  control: ProgramBenchCompileRepairControl
  errorType: string | null
}> {
  let contract = options.initialContract
  let compileProbe = options.initialCompileProbe
  let control = options.initialControl
  let errorType: string | null = null
  const attempts: CompileRepairAttemptSummary[] = []
  const maxAttempts = Math.max(0, options.args.compileRepairAttempts)
  let stoppedAfterNoProgress = false

  for (let attempt = 1; attempt <= maxAttempts && control.action === 'continue_compile_repair'; attempt++) {
    const promptPath = join(options.caseRoot, `compile-repair-${attempt}-prompt.txt`)
    const responsePath = join(options.caseRoot, `compile-repair-${attempt}-response.txt`)
    const errorPath = join(options.caseRoot, `compile-repair-${attempt}-error.txt`)
    const beforeContract = contract
    const beforeProbe = compileProbe
    const beforeControl = control
    const beforeFingerprint = await programBenchSourceFingerprint(options.workspaceRoot)
    await writeFile(promptPath, buildProgramBenchCompileRepairPrompt({
      item: options.item,
      workspaceRoot: options.workspaceRoot,
      contract: beforeContract,
      compileProbe: beforeProbe,
    }), 'utf8')

    let attemptError: string | null = null
    try {
      await runAgent(options.agent, options.args, promptPath, options.workspaceRoot, options.caseRoot, {
        responsePath,
        sessionLogPath: join(options.caseRoot, `agent-runlab-compile-repair-${attempt}-session.jsonl`),
        metadataPath: join(options.caseRoot, `agent-runlab-compile-repair-${attempt}-metadata.json`),
        sessionsDir: join(options.caseRoot, `compile-repair-${attempt}-sessions`),
        artifactsDir: options.agent === 'agent-runlab'
          ? join(options.caseRoot, `compile-repair-${attempt}-artifacts`)
          : join(options.caseRoot, `claude-code-compile-repair-${attempt}-artifacts`),
        maxTurns: options.args.repairMaxTurns,
      }, options.benchmarkImage)
    } catch (err: unknown) {
      attemptError = err instanceof Error ? err.message : String(err)
      await writeFile(errorPath, `${attemptError}\n`, 'utf8')
    }

    contract = await inspectProgramBenchSubmissionContract(options.workspaceRoot, options.runnerNormalizations)
    const normalization = await maybeNormalizeCompileShExecutable(options.args, options.workspaceRoot, contract)
    let normalizationEntry: ProgramBenchSubmissionContractNormalization | undefined
    if (normalization.applied) {
      normalizationEntry = { kind: 'chmod_compile_sh_executable', ...normalization }
      options.runnerNormalizations.push(normalizationEntry)
      await writeFile(
        join(options.caseRoot, `submission-contract-normalization.compile-repair-${attempt}.json`),
        `${JSON.stringify(normalizationEntry, null, 2)}\n`,
        'utf8',
      )
      contract = await inspectProgramBenchSubmissionContract(options.workspaceRoot, options.runnerNormalizations)
    }
    compileProbe = await writeProgramBenchCompileProbe(options.args, options.workspaceRoot, options.caseRoot, options.benchmarkImage)
    control = await writeProgramBenchCompileRepairGate(options.args, options.item, options.workspaceRoot, options.caseRoot, contract, compileProbe)
    const afterFingerprint = await programBenchSourceFingerprint(options.workspaceRoot)
    attempts.push({
      attempt,
      prompt: relativeToPortfolio(options.args.portfolioDir, promptPath),
      response: relativeToPortfolio(options.args.portfolioDir, responsePath),
      before: {
        contract: summarizeContractForContinuation(beforeContract),
        compile_probe: summarizeCompileProbeForRepair(beforeProbe),
        control: beforeControl,
        source_fingerprint: beforeFingerprint,
      },
      after: {
        contract: summarizeContractForContinuation(contract),
        compile_probe: summarizeCompileProbeForRepair(compileProbe),
        control,
        source_fingerprint: afterFingerprint,
      },
      error: attemptError,
      normalization: normalizationEntry,
    })

    if (compileProbe.ok) break
    if (!contract.ok) break
    if (attemptError) break
    const noProgress = beforeFingerprint === afterFingerprint && sameCompileRepairState(beforeContract, contract, beforeProbe, compileProbe)
    if (noProgress) {
      stoppedAfterNoProgress = true
      break
    }
  }

  if (attempts.some((attempt) => attempt.error)) {
    const errors = attempts
      .filter((attempt) => attempt.error)
      .map((attempt) => `attempt ${attempt.attempt}: ${attempt.error}`)
      .join('; ')
    errorType = `${errorType ? `${errorType}; ` : ''}compile repair runner errors: ${errors}`
  }

  await writeFile(join(options.caseRoot, 'compile-repair-summary.json'), `${JSON.stringify({
    schema_version: 1,
    enabled: maxAttempts > 0,
    max_attempts: maxAttempts,
    repair_max_turns: options.args.repairMaxTurns,
    attempted: attempts.length,
    exhausted: control.action === 'continue_compile_repair' && attempts.length >= maxAttempts,
    final_compile_ok: compileProbe.ok,
    final_contract_ok: contract.ok,
    final_compile_probe: summarizeCompileProbeForRepair(compileProbe),
    final_compile_repair_control: control,
    stopped_after_no_progress: stoppedAfterNoProgress,
    attempts,
  }, null, 2)}\n`, 'utf8')

  return { contract, compileProbe, control, errorType }
}

async function programBenchSourceFingerprint(workspaceRoot: string): Promise<string> {
  const files = await collectProgramBenchSourceFiles(workspaceRoot)
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(relativeToPortfolio(workspaceRoot, file))
    hash.update('\0')
    hash.update(await readFile(file).catch(() => Buffer.alloc(0)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function summarizeCompileProbeForRepair(probe: ProgramBenchCompileProbe): {
  ok: boolean
  status: ProgramBenchCompileProbe['status']
  reason_codes: readonly string[]
  exit_code: number | null
  signal: string | null
  duration_ms: number
} {
  return {
    ok: probe.ok,
    status: probe.status,
    reason_codes: probe.reason_codes,
    exit_code: probe.exit_code,
    signal: probe.signal,
    duration_ms: probe.duration_ms,
  }
}

function sameCompileRepairState(
  beforeContract: ProgramBenchSubmissionContract,
  afterContract: ProgramBenchSubmissionContract,
  beforeProbe: ProgramBenchCompileProbe,
  afterProbe: ProgramBenchCompileProbe,
): boolean {
  return beforeContract.ok === afterContract.ok
    && beforeContract.source_file_count === afterContract.source_file_count
    && beforeContract.reason_codes.join('\0') === afterContract.reason_codes.join('\0')
    && beforeProbe.status === afterProbe.status
    && beforeProbe.exit_code === afterProbe.exit_code
    && beforeProbe.reason_codes.join('\0') === afterProbe.reason_codes.join('\0')
    && beforeProbe.stderr.trim() === afterProbe.stderr.trim()
}

async function detectOutOfScopeProgramBenchAccess(
  caseRoot: string,
  workspaceRoot: string,
  runRoot: string,
): Promise<string[]> {
  const files = await collectTextFiles(caseRoot)
  const currentRun = normalizePathForSearch(runRoot)
  const currentWorkspace = normalizePathForSearch(workspaceRoot)
  const marker = 'experiments/evals/2026-07-agent-benchmark-comparison/artifacts/program-bench/'
  const warnings = new Set<string>()
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (!text.includes(marker)) continue
    for (const raw of text.split(/\s|"|'|`|\\n/)) {
      if (!raw.includes(marker)) continue
      const token = normalizePathForSearch(raw.replace(/[),;]+$/g, ''))
      if (token.endsWith('/...')) continue
      if (token.includes(currentWorkspace) || token.includes(currentRun)) continue
      warnings.add(token)
    }
  }
  return [...warnings].sort().slice(0, 20)
}

async function collectTextFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'workspace' || entry.name === 'submissions') continue
        await visit(path)
      } else if (/\.(txt|log|json|jsonl|md)$/.test(entry.name)) {
        if (entry.name === 'prompt.txt' || entry.name === 'run-manifest.json' || entry.name === 'system-prompt.txt') continue
        out.push(path)
      }
    }
  }
  await visit(root)
  return out
}

function normalizePathForSearch(value: string): string {
  return value.replaceAll('\\', '/').replace(/^.*?(?=rl\/experiments\/2026-07-agent-benchmark-comparison\/artifacts\/program-bench\/)/, '')
}

async function runAgent(
  agent: AgentName,
  args: Args,
  promptPath: string,
  workspaceRoot: string,
  caseRoot: string,
  options: RunAgentOptions,
  benchmarkImage: string,
): Promise<void> {
  const runnerTimeoutMs = programBenchAgentRunnerTimeoutMs(args.timeoutMs)
  if (agent === 'agent-runlab') {
    await runCommand('pnpm', programBenchAgentRunlabCommandArgs(args, promptPath, workspaceRoot, caseRoot, options, benchmarkImage), caseRoot, {
      ANTHROPIC_BASE_URL: args.baseUrl,
      ANTHROPIC_MODEL: args.model,
      ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
      HOST_MODEL: args.model,
    }, undefined, { timeoutMs: runnerTimeoutMs })
    return
  }
  await runCommand('pnpm', [
    '--filter', '@agent-kernel/host', 'exec', 'tsx', 'bin/run-claude-code-prompt.ts',
    '--prompt-file', promptPath,
    '--cwd', workspaceRoot,
    '--response-file', options.responsePath,
    '--artifacts-dir', options.artifactsDir,
    ...explicitBaseUrlArg(args),
    '--model', args.model,
    '--small-fast-model', args.smallFastModel,
    '--timeout-ms', String(args.timeoutMs),
    ...(args.claudeInactivityTimeoutMs !== undefined ? ['--inactivity-timeout-ms', String(args.claudeInactivityTimeoutMs)] : []),
    '--max-turns', String(options.maxTurns),
    '--disable-web-tools',
    '--bash-docker-image', benchmarkImage,
  ], caseRoot, {
    ANTHROPIC_BASE_URL: args.baseUrl,
    ANTHROPIC_MODEL: args.model,
    ANTHROPIC_SMALL_FAST_MODEL: args.smallFastModel,
  }, undefined, { timeoutMs: runnerTimeoutMs })
}

export function programBenchAgentRunlabCommandArgs(
  args: Pick<Args, 'model' | 'timeoutMs' | 'repairMaxTurns' | 'repairContract' | 'contractContinuationAttempts' | 'agentRunlabMaxOutputTokens' | 'agentRunlabInactivityTimeoutMs'>,
  promptPath: string,
  workspaceRoot: string,
  caseRoot: string,
  options: RunAgentOptions,
  benchmarkImage: string,
): string[] {
  return [
    '--filter', '@agent-kernel/host', 'exec', 'tsx', 'bin/run-agent-runlab-prompt.ts',
    '--prompt-file', promptPath,
    '--cwd', workspaceRoot,
    '--response-file', options.responsePath,
    '--session-log', options.sessionLogPath ?? join(caseRoot, 'agent-runlab-session.jsonl'),
    '--metadata-file', options.metadataPath ?? join(caseRoot, 'agent-runlab-metadata.json'),
    '--sessions-dir', options.sessionsDir ?? join(caseRoot, 'sessions'),
    '--artifacts-dir', options.artifactsDir,
    '--model', args.model,
    '--system-prompt-preset', 'codex',
    '--timeout-ms', String(args.timeoutMs),
    ...(args.agentRunlabInactivityTimeoutMs !== undefined ? ['--inactivity-timeout-ms', String(args.agentRunlabInactivityTimeoutMs)] : []),
    '--max-turns', String(options.maxTurns),
    '--continuation-max-turns', String(args.repairMaxTurns),
    '--max-output-tokens', String(args.agentRunlabMaxOutputTokens),
    '--programbench-contract-continuation-attempts', String(args.repairContract ? args.contractContinuationAttempts : 0),
    ...(options.caseJsonPath ? ['--programbench-case-json', options.caseJsonPath] : []),
    '--disable-web-tools',
    '--bash-docker-image', benchmarkImage,
  ]
}

export function programBenchAgentRunnerTimeoutMs(innerTimeoutMs: number): number {
  return innerTimeoutMs + 60_000
}

function explicitBaseUrlArg(args: Pick<Args, 'baseUrl' | 'baseUrlSource'>): string[] {
  return args.baseUrlSource === 'cli' ? ['--base-url', args.baseUrl] : []
}

async function prepareCleanroomWorkspace(
  item: ProgramBenchCase,
  workspaceRoot: string,
  caseRoot: string,
): Promise<void> {
  if (!item.image_name) throw new Error(`missing image_name for ${item.instance_id}`)
  const image = `${item.image_name}:task_cleanroom_v6`
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  await runCommand('docker', [
    'run', '--rm', '--network', 'none', '-w', '/workspace',
    '-v', `${workspaceRoot}:/host-workspace`,
    image,
    'bash', '-lc', `tar --exclude=.git -cf - . | tar -C /host-workspace -xf - && chown -R ${uid}:${gid} /host-workspace`,
  ], caseRoot, {}, 'prepare-cleanroom')
}

export async function bootstrapProgramBenchSubmissionSkeleton(
  item: Pick<ProgramBenchCase, 'language'>,
  workspaceRoot: string,
): Promise<ProgramBenchSubmissionContractNormalization> {
  const sourceName = programBenchBootstrapSourceName(item)
  const sourcePath = join(workspaceRoot, sourceName)
  const compilePath = join(workspaceRoot, 'compile.sh')
  const sourceContent = programBenchBootstrapSourceContent(item, sourceName)
  const compileContent = programBenchBootstrapCompileScript(sourceName)
  if (!existsSync(sourcePath)) await writeFile(sourcePath, sourceContent, 'utf8')
  if (!existsSync(compilePath)) await writeFile(compilePath, compileContent, 'utf8')
  await chmod(compilePath, 0o755)
  return {
    kind: 'runner_bootstrap_submission_skeleton',
    applied: true,
    reason: 'runner created a shared minimal submission skeleton before inference so both agents start past the missing-artifact layer; this is benchmark adapter scaffolding, not agent-authored work',
    files: ['compile.sh', sourceName],
  }
}

function programBenchBootstrapSourceName(item: Pick<ProgramBenchCase, 'language'>): string {
  const language = (item.language ?? '').toLowerCase()
  if (language.includes('go')) return 'main.go'
  if (language.includes('rust')) return 'main.rs'
  if (language.includes('python')) return 'main.py'
  if (language.includes('java')) return 'Main.java'
  if (language.includes('javascript') || language.includes('typescript')) return 'main.js'
  return 'main.c'
}

function programBenchBootstrapSourceContent(item: Pick<ProgramBenchCase, 'language'>, sourceName: string): string {
  const language = (item.language ?? '').toLowerCase()
  if (sourceName === 'main.go' || language.includes('go')) return 'package main\n\nfunc main() {}\n'
  if (sourceName === 'main.rs' || language.includes('rust')) return 'fn main() {}\n'
  if (sourceName === 'main.py' || language.includes('python')) return 'def main():\n    pass\n\nif __name__ == "__main__":\n    main()\n'
  if (sourceName === 'Main.java' || language.includes('java')) return 'public class Main { public static void main(String[] args) { } }\n'
  if (sourceName === 'main.js' || language.includes('javascript') || language.includes('typescript')) return 'process.exit(0)\n'
  return 'int main(int argc, char **argv) { (void)argc; (void)argv; return 0; }\n'
}

function programBenchBootstrapCompileScript(sourceName: string): string {
  if (sourceName === 'main.go') return '#!/usr/bin/env bash\nset -euo pipefail\ngo build -o executable main.go\n'
  if (sourceName === 'main.rs') return '#!/usr/bin/env bash\nset -euo pipefail\nrustc main.rs -O -o executable\n'
  if (sourceName === 'main.py') return '#!/usr/bin/env bash\nset -euo pipefail\ncp main.py executable\nchmod +x executable\n'
  if (sourceName === 'Main.java') return '#!/usr/bin/env bash\nset -euo pipefail\njavac Main.java\nprintf %s "#!/usr/bin/env bash\njava Main \"$@\"\n" > executable\nchmod +x executable\n'
  if (sourceName === 'main.js') return '#!/usr/bin/env bash\nset -euo pipefail\nprintf %s "#!/usr/bin/env bash\nnode main.js \"$@\"\n" > executable\nchmod +x executable\n'
  return '#!/usr/bin/env bash\nset -euo pipefail\ngcc -O2 -o executable main.c -lz -lm\n'
}

async function packageSubmission(workspaceRoot: string, outputPath: string, caseRoot: string): Promise<void> {
  await runCommand('node', [
    join(REPO_ROOT, 'scripts/eval/benchmarks/programbench/package-programbench-submission.mjs'),
    '--workspace', workspaceRoot,
    '--output', outputPath,
  ], caseRoot, {}, 'package-submission')
}

async function writeProgramBenchCompileProbe(
  args: Args,
  workspaceRoot: string,
  caseRoot: string,
  benchmarkImage: string,
): Promise<ProgramBenchCompileProbe> {
  const probe = await runProgramBenchCompileProbe({
    workspaceRoot,
    dockerImage: benchmarkImage,
    timeoutMs: Math.min(args.nativeEvalTimeoutMs, 5 * 60_000),
  })
  await writeFile(join(caseRoot, 'compile-probe.json'), `${JSON.stringify({
    ...probe,
    workspace_root: relativeToPortfolio(args.portfolioDir, workspaceRoot),
  }, null, 2)}\n`, 'utf8')
  return probe
}

async function writeProgramBenchCompileRepairGate(
  args: Args,
  item: ProgramBenchCase,
  workspaceRoot: string,
  caseRoot: string,
  contract: ProgramBenchSubmissionContract,
  compileProbe: ProgramBenchCompileProbe,
): Promise<ProgramBenchCompileRepairControl> {
  const compileRepairControl = classifyProgramBenchCompileRepair({ contract, compileProbe })
  const promptPath = join(caseRoot, 'compile-repair-prompt.txt')
  if (compileRepairControl.action === 'continue_compile_repair') {
    await writeFile(promptPath, buildProgramBenchCompileRepairPrompt({
      item,
      workspaceRoot,
      contract,
      compileProbe,
    }), 'utf8')
  }
  await writeFile(join(caseRoot, 'compile-repair-gate.json'), `${JSON.stringify({
    schema_version: 1,
    gate: 'programbench_compile_repair',
    compile_repair_control: compileRepairControl,
    compile_probe: {
      ok: compileProbe.ok,
      status: compileProbe.status,
      reason_codes: compileProbe.reason_codes,
      exit_code: compileProbe.exit_code,
    },
    prompt: compileRepairControl.action === 'continue_compile_repair'
      ? relativeToPortfolio(args.portfolioDir, promptPath)
      : null,
    next_action: compileRepairControl.action === 'continue_compile_repair'
      ? 'bounded compile repair should run before any broader ProgramBench expansion'
      : compileRepairControl.action,
  }, null, 2)}\n`, 'utf8')
  return compileRepairControl
}

async function runNativeEval(
  args: Args,
  item: ProgramBenchCase,
  agent: AgentName,
  runRoot: string,
  caseRoot: string,
): Promise<void> {
  const containersBefore = await listProgramBenchContainers()
  try {
    await runCommand('uvx', [
      'programbench', 'eval', join(runRoot, 'submissions', agent),
      '--filter', `^${escapeRegex(item.instance_id)}$`,
      '--workers', '1',
      '--branch-workers', '1',
      '--docker-cpus', '2',
      '--force',
    ], caseRoot, {}, 'programbench-eval', { timeoutMs: args.nativeEvalTimeoutMs })
  } catch (err: unknown) {
    if (err instanceof CommandTimeoutError) {
      const containersAfter = await listProgramBenchContainers()
      const newContainers = containersAfter.filter((id) => !containersBefore.includes(id))
      await stopDockerContainers(newContainers, caseRoot)
      await writeFile(join(caseRoot, 'native-eval-timeout.json'), `${JSON.stringify({
        schema_version: 1,
        kind: 'native_eval_timeout',
        benchmark: 'program-bench',
        agent,
        instance_id: item.instance_id,
        timeout_ms: args.nativeEvalTimeoutMs,
        log: relativeToPortfolio(args.portfolioDir, err.logPath),
        stopped_programbench_containers: newContainers,
      }, null, 2)}\n`, 'utf8')
      throw new Error(`native_eval_timeout after ${args.nativeEvalTimeoutMs}ms; see ${err.logPath}`)
    }
    throw err
  }
  await runCommand('uvx', [
    'programbench', 'info', join(runRoot, 'submissions', agent),
  ], caseRoot, {}, 'programbench-info')
}

async function listProgramBenchContainers(): Promise<string[]> {
  const output = await captureCommand('docker', [
    'ps', '-aq', '--no-trunc', '--filter', 'name=programbench',
  ]).catch(() => '')
  return output.split('\n').map((line) => line.trim()).filter(Boolean)
}

async function stopDockerContainers(containerIds: readonly string[], caseRoot: string): Promise<void> {
  for (const id of containerIds) {
    await runCommand('docker', ['stop', id], caseRoot, {}, 'programbench-eval-container-stop').catch(async (err: unknown) => {
      await writeFile(join(caseRoot, `container-stop-${id.slice(0, 12)}.error.txt`), `${err instanceof Error ? err.message : String(err)}\n`, 'utf8')
    })
  }
}

async function readNativeScore(
  item: ProgramBenchCase,
  submissionDir: string,
  caseRoot: string,
): Promise<{ score: number; scorer: string }> {
  const evalJson = join(submissionDir, `${item.instance_id}.eval.json`)
  if (!existsSync(evalJson)) throw new Error(`native eval output missing: ${evalJson}`)
  const scorePath = join(caseRoot, 'native-score.json')
  const script = [
    'from pathlib import Path',
    'import json, sys',
    'from programbench.submission import score_instance',
    'from programbench.utils.load_data import load_all_instances',
    'iid=sys.argv[1]',
    'eval_json=Path(sys.argv[2])',
    'instances={i["instance_id"]: i for i in load_all_instances(include_tests=True)}',
    'score=score_instance(eval_json, instances[iid])',
    'print(json.dumps({"score": score, "scorer": "programbench.eval+score_instance", "eval_json": str(eval_json)}))',
  ].join('\n')
  await runCommand('uvx', ['--from', 'programbench', 'python', '-c', script, item.instance_id, evalJson], caseRoot, {}, 'native-score')
  const logs = await latestLog(caseRoot, 'native-score')
  const raw = await readFile(logs, 'utf8')
  const line = raw.trim().split('\n').reverse().find((entry) => entry.trim().startsWith('{'))
  if (!line) throw new Error(`score JSON not found in ${logs}`)
  await writeFile(scorePath, `${line}\n`, 'utf8')
  const parsed = JSON.parse(line) as { score: number; scorer: string }
  return parsed
}

async function writeSubmissionContractGate(
  args: Args,
  caseRoot: string,
  contract: ProgramBenchSubmissionContract,
  completionControl: ProgramBenchCompletionControl,
): Promise<void> {
  await writeFile(join(caseRoot, 'submission-contract-gate.json'), `${JSON.stringify({
    schema_version: 1,
    gate: 'programbench_submission_contract',
    ok: contract.ok,
    reason_codes: contract.reason_codes,
    required_actions: contract.required_actions,
    source_file_count: contract.source_file_count,
    source_files: contract.source_files,
    implementation_file_count: contract.implementation_file_count,
    implementation_files: contract.implementation_files,
    checks: contract.checks,
    completion_control: completionControl,
    completion_control_failure: completionControl.classification !== 'contract_satisfied'
      ? `completion_control_failure:${completionControl.classification}`
      : null,
    continuation_attempts: args.repairContract ? args.contractContinuationAttempts : 0,
    native_eval_policy: contract.ok
      ? 'contract_satisfied_native_eval_authoritative'
      : 'contract_failed_but_native_eval_still_runs_to_preserve_official_zero_or_error_evidence',
    completion_control_interpretation: contract.ok
      ? 'agent produced the minimum ProgramBench submission artifacts before scoring'
      : 'agent finalization did not produce the minimum ProgramBench submission artifacts; treat as artifact_contract_failure even if native eval also reports compile_failed',
  }, null, 2)}\n`, 'utf8')
}

async function latestProgramBenchResponseText(portfolioDir: string, caseRoot: string, responsePath: string): Promise<string> {
  const continuation = await maybeReadJson<{ attempts?: Array<{ response?: string }> }>(join(caseRoot, 'contract-continuation-summary.json'))
  const latestContinuationResponse = continuation?.attempts?.at(-1)?.response
  const latestPath = latestContinuationResponse
    ? resolveProgramBenchArtifactPath(portfolioDir, caseRoot, latestContinuationResponse)
    : responsePath
  return await readFile(latestPath, 'utf8').catch(() => '')
}

async function maybeReadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

function resolveProgramBenchArtifactPath(portfolioDir: string, caseRoot: string, artifactPath: string): string {
  if (artifactPath.startsWith('/')) return artifactPath
  if (artifactPath.startsWith('artifacts/')) return join(portfolioDir, artifactPath)
  return join(caseRoot, artifactPath)
}

async function latestLog(dir: string, marker: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.includes(marker) && entry.name.endsWith('.log'))
    .map((entry) => join(dir, entry.name))
  if (!candidates.length) throw new Error(`no ${marker} log found in ${dir}`)
  let newest = candidates[0]!
  let newestMtime = 0
  const { stat } = await import('node:fs/promises')
  for (const candidate of candidates) {
    const mtime = (await stat(candidate)).mtimeMs
    if (mtime >= newestMtime) {
      newest = candidate
      newestMtime = mtime
    }
  }
  return newest
}

async function writeOutputs(
  args: Args,
  runRoot: string,
  cases: readonly ProgramBenchCase[],
  results: readonly InstanceResult[],
  stats: RunStats,
): Promise<void> {
  const gradingDir = join(args.portfolioDir, 'artifacts', 'program-bench', 'grading')
  await mkdir(gradingDir, { recursive: true })
  const instanceResults = results.map((row) => JSON.stringify(row)).join('\n') + (results.length ? '\n' : '')
  await writeFile(join(runRoot, 'instance-results.jsonl'), instanceResults, 'utf8')
  const summary = {
    schema_version: 1,
    benchmark: 'program-bench',
    run_id: args.runId,
    status: args.dryRun ? 'dry_run' : results.every((row) => row.status === 'scored') ? 'scored' : 'partial',
    selected_cases: cases.length,
    requested_agent_runs: cases.length * args.agents.length,
    completed_agent_runs: stats.attemptedAgentRuns,
    stop_reason: stats.stopReason,
    stop_gates: {
      max_agent_runs: args.maxAgentRuns,
      stop_after_errors: args.stopAfterErrors,
      stop_after_contract_failures: args.stopAfterContractFailures,
    },
    model: args.model,
    scorer: results.some((row) => row.official) ? 'programbench.eval+score_instance' : 'programbench.eval.pending',
    official: results.length > 0 && results.every((row) => row.official),
    agents: Object.fromEntries(args.agents.map((agent) => {
      const rows = results.filter((row) => row.agent === agent)
      const attemptedRows = rows.filter((row) => !row.error_type?.startsWith('stop_gate:'))
      const scoredRows = rows.filter((row) => row.status === 'scored')
      const completionFailures = rows.filter((row) => row.completion_control_failure)
      return [agent, {
        attempted: attemptedRows.length,
        skipped: rows.filter((row) => row.error_type?.startsWith('stop_gate:')).length,
        prepared: rows.filter((row) => row.status === 'prepared').length,
        submitted: rows.filter((row) => row.status === 'submitted').length,
        scored: scoredRows.length,
        average_score: scoredRows.length ? scoredRows.reduce((sum, row) => sum + row.score, 0) / scoredRows.length : 0,
        errors: rows.filter((row) => row.status === 'error').length,
        completion_control_failures: completionFailures.length,
        compile_repair_attempts: rows.reduce((sum, row) => sum + compileRepairAttemptCount(args.portfolioDir, row.artifact_refs), 0),
      }]
    })),
    run_root: relativeToPortfolio(args.portfolioDir, runRoot),
  }
  await writeFile(join(runRoot, 'score-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  const updateHeadline = !args.dryRun && shouldUpdateProgramBenchHeadline(results)
  if (!args.dryRun) {
    if (!updateHeadline) {
      await writeProgramBenchDiagnostic(args, runRoot, summary, results)
    }
  }
  if (updateHeadline) {
    await writeFile(join(gradingDir, 'instance-results.jsonl'), instanceResults, 'utf8')
    await writeFile(join(gradingDir, 'score-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    await mkdir(join(args.portfolioDir, 'reports', 'programbench'), { recursive: true })
    await writeFile(join(args.portfolioDir, 'reports', 'programbench', 'latest-run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  }
  await writePairwise(args, runRoot, results)
}

function shouldUpdateProgramBenchHeadline(results: readonly InstanceResult[]): boolean {
  const byInstance = new Map<string, Set<AgentName>>()
  for (const row of results) {
    if (row.status !== 'scored' || row.official !== true) continue
    const agents = byInstance.get(row.instance_id) ?? new Set<AgentName>()
    agents.add(row.agent)
    byInstance.set(row.instance_id, agents)
  }
  return [...byInstance.values()].some((agents) => agents.has('agent-runlab') && agents.has('claude-code'))
}

async function writeProgramBenchDiagnostic(
  args: Args,
  runRoot: string,
  summary: Record<string, unknown>,
  results: readonly InstanceResult[],
): Promise<void> {
  const diagnosticsDir = join(args.portfolioDir, 'diagnostics', 'programbench')
  await mkdir(diagnosticsDir, { recursive: true })
  const modelConfigErrors = results.filter((row) => row.error_type?.includes('model_not_found'))
  const report = {
    schema_version: 1,
    generated_by: 'packages/host/bin/run-programbench-portfolio.ts',
    benchmark: 'program-bench',
    run_id: args.runId,
    status: 'not_comparable_partial_run',
    classification: modelConfigErrors.length > 0 ? 'model_config_error' : 'partial_non_comparable_run',
    run_root: relativeToPortfolio(args.portfolioDir, runRoot),
    reason: 'This run did not produce at least one official Agent RunLab / Claude Code scored pair, so it was kept run-scoped and did not replace ProgramBench headline latest/grading outputs.',
    summary,
    error_types: results.map((row) => ({ agent: row.agent, instance_id: row.instance_id, status: row.status, error_type: row.error_type })),
  }
  await writeFile(join(runRoot, 'non-comparable-run-diagnostic.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(join(diagnosticsDir, `${args.runId}.non-comparable-run.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

async function writePairwise(args: Args, runRoot: string, results: readonly InstanceResult[]): Promise<void> {
  const root = join(args.portfolioDir, 'artifacts', 'program-bench')
  const byKey = new Map(results.map((row) => [`${row.instance_id}:${row.agent}`, row]))
  const ids = [...new Set(results.map((row) => row.instance_id))].sort()
  const rows = []
  for (const id of ids) {
    const agent = byKey.get(`${id}:agent-runlab`)
    const claude = byKey.get(`${id}:claude-code`)
    rows.push({
      benchmark: 'program-bench',
      instance_id: id,
      task_type: 'cleanroom_program_reconstruction',
      model: args.model,
      agent_runlab_status: agent?.status ?? 'not_run',
      claude_code_status: claude?.status ?? 'not_run',
      agent_runlab_score: String(agent?.score ?? 0),
      claude_code_score: String(claude?.score ?? 0),
      agent_runlab_completion_control: agent?.completion_control?.classification ?? '',
      claude_code_completion_control: claude?.completion_control?.classification ?? '',
      agent_runlab_completion_failure: agent?.completion_control_failure ?? '',
      claude_code_completion_failure: claude?.completion_control_failure ?? '',
      agent_runlab_compile_probe: agent?.compile_probe?.status ?? '',
      claude_code_compile_probe: claude?.compile_probe?.status ?? '',
      agent_runlab_compile_failure: agent?.compile_probe_failure ?? '',
      claude_code_compile_failure: claude?.compile_probe_failure ?? '',
      winner: pairwiseWinner(agent, claude),
      agent_artifact: agent?.artifact_refs.join(';') ?? '',
      claude_artifact: claude?.artifact_refs.join(';') ?? '',
      grader_report: 'artifacts/program-bench/grading/instance-results.jsonl',
      failure_category: args.dryRun ? '' : await pairwiseFailureCategory(runRoot, id, agent, claude),
      notes: args.dryRun ? 'dry run only; no agent, packaging, or native eval executed' : pairwiseNotes(agent, claude),
    })
  }
  const header = Object.keys(rows[0] ?? {
    benchmark: '', instance_id: '', task_type: '', model: '', agent_runlab_status: '', claude_code_status: '',
    agent_runlab_score: '', claude_code_score: '', agent_runlab_completion_control: '', claude_code_completion_control: '',
    agent_runlab_completion_failure: '', claude_code_completion_failure: '', agent_runlab_compile_probe: '', claude_code_compile_probe: '',
    agent_runlab_compile_failure: '', claude_code_compile_failure: '', winner: '', agent_artifact: '', claude_artifact: '', grader_report: '', failure_category: '', notes: '',
  })
  const csv = [header.join(','), ...rows.map((row) => header.map((key) => csvCell(String(row[key as keyof typeof row]))).join(','))].join('\n') + '\n'
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
  if (!args.dryRun && shouldUpdateProgramBenchHeadline(results)) {
    const reportRoot = join(args.portfolioDir, 'reports', 'programbench')
    await mkdir(reportRoot, { recursive: true })
    await writeFile(join(reportRoot, 'pairwise-comparison.csv'), csv, 'utf8')
    await writeFile(join(reportRoot, 'pairwise-comparison.jsonl'), jsonl, 'utf8')
  }
  await writeFile(join(runRoot, 'pairwise-comparison.csv'), csv, 'utf8')
  await writeFile(join(runRoot, 'pairwise-comparison.jsonl'), jsonl, 'utf8')
}

async function collectContractContinuationArtifacts(caseRoot: string): Promise<string[]> {
  const entries = await readdir(caseRoot, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(caseRoot, entry.name))
    .filter((entryPath) => {
      const name = basename(entryPath)
      return /^contract-continuation-\d+-(prompt|response|error)\.txt$/.test(name)
        || /^submission-contract-normalization\.continuation-\d+\.json$/.test(name)
    })
    .sort()
}

async function collectCompileRepairArtifacts(caseRoot: string): Promise<string[]> {
  const entries = await readdir(caseRoot, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(caseRoot, entry.name))
    .filter((entryPath) => {
      const name = basename(entryPath)
      return /^compile-repair-\d+-(prompt|response|error)\.txt$/.test(name)
        || /^submission-contract-normalization\.compile-repair-\d+\.json$/.test(name)
    })
    .sort()
}

function compileRepairAttemptCount(portfolioDir: string, artifactRefs: readonly string[]): number {
  void portfolioDir
  return artifactRefs.filter((ref) => /(^|\/)compile-repair-\d+-prompt\.txt$/.test(ref)).length
}

function pairwiseWinner(agent?: InstanceResult, claude?: InstanceResult): string {
  if (!agent || !claude) return 'not_comparable'
  if (!agent.official || !claude.official) return 'not_comparable'
  if (agent.score > claude.score) return 'agent-runlab'
  if (claude.score > agent.score) return 'claude-code'
  return 'tie'
}

function pairwiseNotes(agent?: InstanceResult, claude?: InstanceResult): string {
  if (!agent || !claude) return 'missing one side of pairwise comparison'
  if (agent.status === 'error' || claude.status === 'error') return 'one or both runs ended in infrastructure error'
  if (!agent.official || !claude.official) return 'native eval pending for one or both systems'
  return 'native ProgramBench eval completed for both systems'
}

async function pairwiseFailureCategory(
  runRoot: string,
  instanceId: string,
  agent?: InstanceResult,
  claude?: InstanceResult,
): Promise<string> {
  const categories = new Set<string>()
  for (const row of [agent, claude]) {
    if (!row) {
      categories.add('not_comparable')
      continue
    }
    if (row.error_type?.includes('out-of-scope workspace access detected')) {
      categories.add('workspace_isolation_failure')
      continue
    }
    if (row.error_type?.includes('native_eval_timeout')) {
      categories.add('native_eval_timeout')
      continue
    }
    if (row.status === 'error') {
      categories.add('runner_infrastructure_error')
      continue
    }
    if (row.submission_contract && !row.submission_contract.ok) {
      categories.add('artifact_contract_failure')
    }
    if (row.completion_control_failure) {
      categories.add(row.completion_control_failure)
    }
    if (row.compile_probe_failure) {
      const reason = row.compile_probe?.reason_codes?.[0]
      if (reason === 'compile_failed') categories.add('compile_failed')
      else if (reason === 'compile_timeout') categories.add('compile_timeout')
      else categories.add(row.compile_probe_failure)
    }
    if (row.error_type?.includes('max_turns') || row.error_type?.includes('maximum number of turns')) {
      categories.add('incomplete_execution')
    }
    const nativeError = row.official ? await nativeEvalErrorCode(runRoot, row.agent, instanceId) : null
    if (nativeError === 'compile_failed') categories.add('compile_failed')
    else if (nativeError) categories.add('test_failed')
    else if (row.official && row.score === 0) categories.add('unresolved')
  }
  if (categories.has('workspace_isolation_failure')) return 'workspace_isolation_failure'
  if (categories.has('native_eval_timeout')) return 'native_eval_timeout'
  if (categories.has('runner_infrastructure_error')) return 'runner_infrastructure_error'
  if (categories.has('artifact_contract_failure')) return 'artifact_contract_failure'
  if (categories.has('completion_control_failure:implementation_write_through_failure')) return 'implementation_write_through_failure'
  if ([...categories].some((category) => category.startsWith('completion_control_failure:'))) return [...categories].find((category) => category.startsWith('completion_control_failure:')) ?? 'completion_control_failure'
  if (categories.has('compile_timeout')) return 'compile_timeout'
  if (categories.has('compile_failed')) return 'compile_failed'
  if (categories.has('incomplete_execution')) return 'incomplete_execution'
  if (categories.has('test_failed')) return 'test_failed'
  if (categories.has('unresolved')) return 'unresolved'
  if (categories.has('not_comparable')) return 'not_comparable'
  return ''
}

async function nativeEvalErrorCode(runRoot: string, agent: AgentName, instanceId: string): Promise<string | null> {
  const evalPath = join(runRoot, 'submissions', agent, instanceId, `${instanceId}.eval.json`)
  if (!existsSync(evalPath)) return null
  const raw = await readFile(evalPath, 'utf8').catch(() => '')
  if (!raw) return null
  const parsed = JSON.parse(raw) as { error_code?: string; test_results?: Array<{ extra?: { error_code?: string }; status?: string }> }
  if (typeof parsed.error_code === 'string') return parsed.error_code
  return parsed.test_results?.find((result) => typeof result.extra?.error_code === 'string')?.extra?.error_code ?? null
}

async function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
  logLabel?: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await mkdir(cwd, { recursive: true })
  const logPath = join(cwd, `${basename(logLabel ?? args[4] ?? cmd)}-${createHash('sha1').update(args.join('\0')).digest('hex').slice(0, 8)}.log`)
  await writeFile(logPath, `$ ${cmd} ${args.join(' ')}\n`, 'utf8')
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    let timeoutTimer: NodeJS.Timeout | undefined
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.timeoutMs !== undefined && process.platform !== 'win32',
    })
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      fn()
    }
    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        void append(logPath, `\n[programbench-runner] timeout after ${options.timeoutMs}ms; terminating process group\n`)
        terminateProcess(child.pid, 'SIGTERM')
        killTimer = setTimeout(() => {
          void append(logPath, '[programbench-runner] SIGTERM grace period elapsed; sending SIGKILL\n')
          terminateProcess(child.pid, 'SIGKILL')
        }, 5000)
      }, options.timeoutMs)
      timeoutTimer.unref?.()
    }
    child.stdout.on('data', (chunk) => void append(logPath, chunk))
    child.stderr.on('data', (chunk) => void append(logPath, chunk))
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) reject(new CommandTimeoutError(cmd, args, options.timeoutMs ?? 0, logPath))
        else if (code === 0) resolvePromise()
        else reject(new Error(`${cmd} exited with ${code}; see ${logPath}`))
      })
    })
  })
}

class CommandTimeoutError extends Error {
  readonly logPath: string
  readonly timeoutMs: number

  constructor(cmd: string, args: readonly string[], timeoutMs: number, logPath: string) {
    super(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms; see ${logPath}`)
    this.name = 'CommandTimeoutError'
    this.logPath = logPath
    this.timeoutMs = timeoutMs
  }
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal)
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Process already exited.
    }
  }
}

async function captureCommand(
  cmd: string,
  args: readonly string[],
  envOverrides: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`))
    })
  })
}

async function append(path: string, chunk: Buffer | string): Promise<void> {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path, chunk)
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)
}

function selectCases(allCases: readonly ProgramBenchCase[], args: Args): ProgramBenchCase[] {
  let selected = [...allCases]
  if (args.caseIds.length) {
    const byId = new Map(selected.map((item) => [item.instance_id, item]))
    selected = args.caseIds.map((id) => {
      const item = byId.get(id)
      if (!item) throw new Error(`case id not found in ${args.casesPath}: ${id}`)
      return item
    })
  } else {
    selected = selected.slice(args.offset)
  }
  if (args.limit !== undefined) selected = selected.slice(0, args.limit)
  return selected
}

function parseArgs(argv: readonly string[]): Args {
  loadEnvFile(value(argv, '--env-file') ?? defaultBenchmarkEnvPath(REPO_ROOT), { override: true, sourceName: 'env-file' })
  const portfolioDir = resolve(REPO_ROOT, value(argv, '--portfolio-dir') ?? 'experiments/evals/2026-07-agent-benchmark-comparison')
  const anthropicDefaults = loadAnthropicCliDefaults()
  const baseUrl = requireAnthropicBaseUrl({ explicit: value(argv, '--base-url'), defaults: anthropicDefaults })
  const model = value(argv, '--model') ?? anthropicDefaults.model ?? 'claude-sonnet-4-6'
  const agents = (value(argv, '--agents') ?? 'agent-runlab,claude-code')
    .split(',')
    .map((agent) => agent.trim())
    .filter(Boolean) as AgentName[]
  for (const agent of agents) {
    if (agent !== 'agent-runlab' && agent !== 'claude-code') throw new Error(`unknown agent: ${agent}`)
  }
  const casesPath = resolve(value(argv, '--cases') ?? join(portfolioDir, 'planning/programbench/pilot-cases.jsonl'))
  if (!existsSync(casesPath)) throw new Error(`cases file not found: ${casesPath}`)
  return {
    portfolioDir,
    casesPath,
    agents,
    model,
    baseUrl: baseUrl.baseUrl,
    baseUrlSource: baseUrl.source,
    smallFastModel: value(argv, '--small-fast-model') ?? anthropicDefaults.smallFastModel ?? 'claude-haiku-4-5',
    timeoutMs: numberValue(argv, '--timeout-ms') ?? 30 * 60_000,
    claudeInactivityTimeoutMs: numberValue(argv, '--claude-inactivity-timeout-ms'),
    agentRunlabInactivityTimeoutMs: numberValue(argv, '--agent-runlab-inactivity-timeout-ms'),
    nativeEvalTimeoutMs: numberValue(argv, '--native-eval-timeout-ms') ?? 45 * 60_000,
    maxTurns: numberValue(argv, '--max-turns') ?? 40,
    repairContract: !hasFlag(argv, '--no-repair-contract'),
    repairMaxTurns: numberValue(argv, '--repair-max-turns') ?? 4,
    agentRunlabMaxOutputTokens: numberValue(argv, '--agent-runlab-max-output-tokens') ?? 32_000,
    contractContinuationAttempts: numberValue(argv, '--contract-continuation-attempts') ?? 2,
    compileRepairAttempts: numberValue(argv, '--compile-repair-attempts', { allowZero: true }) ?? 1,
    normalizeCompileShExecutable: !hasFlag(argv, '--no-normalize-compile-sh-executable'),
    bootstrapSubmissionSkeleton: !hasFlag(argv, '--no-bootstrap-submission-skeleton'),
    maxAgentRuns: numberValue(argv, '--max-agent-runs'),
    stopAfterErrors: numberValue(argv, '--stop-after-errors'),
    stopAfterContractFailures: numberValue(argv, '--stop-after-contract-failures'),
    runId: value(argv, '--run-id') ?? `program-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    dryRun: hasFlag(argv, '--dry-run'),
    caseIds: values(argv, '--case-id'),
    limit: numberValue(argv, '--limit'),
    offset: numberValue(argv, '--offset', { allowZero: true }) ?? 0,
  }
}

function value(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function values(argv: readonly string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name && argv[i + 1]) out.push(argv[i + 1]!)
    else if (arg.startsWith(`${name}=`)) out.push(arg.slice(name.length + 1))
  }
  return out.flatMap((raw) => raw.split(',').map((item) => item.trim()).filter(Boolean))
}

function numberValue(argv: readonly string[], name: string, opts: { allowZero?: boolean } = {}): number | undefined {
  const raw = value(argv, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  const min = opts.allowZero ? 0 : 1
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be ${opts.allowZero ? 'a non-negative' : 'a positive'} number`)
  return n
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

function relativeToPortfolio(portfolioDir: string, path: string): string {
  return normalizeRelative(resolve(portfolioDir), resolve(path))
}

function normalizeRelative(from: string, to: string): string {
  let rel = to.startsWith(from) ? to.slice(from.length).replace(/^\/+/, '') : to
  rel = rel.replaceAll('\\', '/')
  return rel
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}

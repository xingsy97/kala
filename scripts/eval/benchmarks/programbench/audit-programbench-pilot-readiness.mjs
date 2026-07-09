#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const portfolioRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const programRoot = path.join(portfolioRoot, 'artifacts/program-bench')
const programReportRoot = path.join(portfolioRoot, 'reports/programbench')
const programDiagnosisRoot = path.join(portfolioRoot, 'diagnostics/programbench')

async function main() {
  const latest = await readJson(path.join(programReportRoot, 'latest-run-summary.json'))
  const runRoot = path.join(portfolioRoot, latest.run_root)
  const pairwiseRows = await readJsonl(path.join(runRoot, 'pairwise-comparison.jsonl'))
  const scoreSummary = await readJson(path.join(runRoot, 'score-summary.json'))
  const comparableRows = pairwiseRows.filter((row) => row.winner !== 'not_comparable')
  const skippedRows = pairwiseRows.filter((row) => row.winner === 'not_comparable')
  const currentCaseIds = [...new Set(comparableRows.map((row) => row.instance_id))]
  const agentContracts = await readContracts(runRoot, 'agent-runlab', currentCaseIds)
  const claudeContracts = await readContracts(runRoot, 'claude-code', currentCaseIds)
  const agentNativeEval = await readNativeEvalSummaries(runRoot, 'agent-runlab', currentCaseIds)
  const claudeNativeEval = await readNativeEvalSummaries(runRoot, 'claude-code', currentCaseIds)
  const implementationQuality = await readImplementationQuality(runRoot, currentCaseIds)
  const claudeCosts = await readClaudeCosts(runRoot, currentCaseIds)
  const continuationProbe = await readContractContinuationProbe()
  const sameSessionPaidDiagnostic = await readSameSessionPaidDiagnostic()
  const mechanismReadiness = await readMechanismReadiness()
  const gates = buildGates({ latest, scoreSummary, comparableRows, skippedRows, agentContracts, claudeContracts, agentNativeEval, claudeNativeEval, implementationQuality })
  const status = gates.every((gate) => gate.status === 'pass') ? 'ready_for_5case_pilot' : 'not_ready_for_5case_pilot'
  const latestStillMissingSource = [...agentContracts, ...claudeContracts]
    .some((contract) => implementationFiles(contract).length === 0)
  const latestArtifactContractFailed = [...agentContracts, ...claudeContracts]
    .some((contract) => contract?.ok !== true)
  const latestCompileFailed = [...agentNativeEval, ...claudeNativeEval]
    .some((summary) => summary.primary_error_code === 'compile_failed')
  const compileRepairGateReady = [...agentNativeEval, ...claudeNativeEval]
    .some((summary) => summary.compile_repair_gate?.action === 'continue_compile_repair')
  const compileRepairLoopReady = mechanismReadiness.compile_repair_loop_dry_run === true
  const latestScaffoldBaseline = implementationQuality.some((item) => item.blocking === true)
  const nextAllowedStep = status === 'ready_for_5case_pilot'
    ? 'Run a bounded 5-case pilot with explicit max-agent-runs and stop-after gates.'
    : latestArtifactContractFailed
      ? 'Do not expand to the 5-case pilot yet. The latest capped pair still failed the artifact contract before compile repair could apply. The next work is artifact-contract completion control for both systems, preserving max-agent-runs=2 and stop gates; do not broaden until one capped pair satisfies the minimum artifacts or exposes a new diagnosed blocker.'
    : latestScaffoldBaseline
      ? 'Do not expand to the 5-case pilot yet. The latest capped pair passed the minimum artifact contract only because the runner bootstrapped compile.sh/main.c; both systems still ended with promise-like implementation text and an inactivity/abort outcome while the submitted main.c remained the scaffold baseline. The next work is an implementation write-through control that verifies agent-authored source changes after bootstrap. The next paid ProgramBench step, if any, must be exactly one monitored capped pair after that no-model gate is validated.'
    : latestCompileFailed
      ? compileRepairGateReady && compileRepairLoopReady
        ? 'Do not expand to the 5-case pilot yet. The latest capped pair reached native scoring, compile probe and compile-repair gate evidence now exist, and the bounded compile-repair runner loop is dry-run validated. The next paid ProgramBench step should be exactly one monitored capped validation pair with bounded compile repair enabled. Do not broaden until that pair passes artifact and compile gates or exposes a new diagnosed blocker.'
        : compileRepairGateReady
          ? 'Do not expand to the 5-case pilot yet. The latest capped pair reached native scoring, compile probe and compile-repair gate evidence now exist, but the bounded compile-repair runner loop must be dry-run validated before another paid pair.'
        : 'Do not expand to the 5-case pilot yet. The latest capped pair reached native scoring, but native eval reported compile_failed. Add and validate a no-model compile probe before any broader spend; the next paid ProgramBench step should only happen after the runner can classify compile failures separately from artifact presence and feed that evidence into bounded repair.'
    : mechanismReadiness.agent_runlab_same_session_continuation && mechanismReadiness.native_eval_timeout_guard && mechanismReadiness.submission_contract_gate
      ? sameSessionPaidDiagnostic
        ? mechanismReadiness.entrypoint_completion_control
          ? latestStillMissingSource
            ? mechanismReadiness.completion_control_action_check
              ? 'Do not expand to the 5-case pilot yet. Completion-control actions are now no-model validated, so the next paid ProgramBench step is exactly one capped validation pair with max-agent-runs=2, stop-after-errors=1, stop-after-contract-failures=2, and contract-continuation-attempts enabled. Do not broaden until that pair satisfies the minimum artifact contract or produces a new diagnosed blocker.'
              : 'Do not expand to the 5-case pilot yet. The latest capped pair already tested the entrypoint-focused path and still failed the minimum ProgramBench artifact contract. At least one system still produced no source files, so the next step is completion-control work that forces source files and compile.sh before finalization; validate that with no-model checks before any further paid pair.'
            : 'Do not expand to the 5-case pilot yet. The latest capped pair still failed the minimum ProgramBench artifact contract for both systems, but source-file-aware contracts and entrypoint-focused repair prompts are now no-model validated. Next paid step, if cost is accepted, is exactly one capped validation pair with max-agent-runs=2; do not expand until the minimum artifact contract passes.'
          : 'Do not expand to the 5-case pilot yet. The latest capped pair still failed the minimum ProgramBench artifact contract for both systems. Finish source-file-aware entrypoint completion-control dry-run validation before any further paid expansion.'
        : 'Do not expand to the 5-case pilot yet. The next allowed ProgramBench spend is one monitored Agent RunLab / Claude Code pair with same-session Agent RunLab contract continuation, native-eval timeout, and max-agent-runs=2 stop gates.'
      : continuationProbe
        ? 'Do not expand to the 5-case pilot yet. The old bounded contract-aware continuation probe already ran and did not make Agent RunLab produce required artifacts; finish the missing no-model mechanism guards before spending on more ProgramBench cases.'
        : 'Do not expand to the 5-case pilot yet; validate the bounded contract-aware continuation loop on one monitored pair before raising the case cap.'
  const report = {
    schema_version: 1,
    generated_by: 'scripts/eval/benchmarks/programbench/audit-programbench-pilot-readiness.mjs',
    benchmark: 'program-bench',
    status,
    latest_run: {
      run_id: latest.run_id,
      evidence_level: 'official_calibration',
      run_root: latest.run_root,
      selected_cases: latest.selected_cases,
      completed_agent_runs: latest.completed_agent_runs,
      stop_reason: latest.stop_reason,
      stop_gates: latest.stop_gates,
      model: latest.model,
      scorer: latest.scorer,
    },
    evidence_summary: {
      pairwise_rows: pairwiseRows.length,
      comparable_rows: comparableRows.length,
      skipped_rows: skippedRows.length,
      agent_runlab_scores: comparableRows.map((row) => Number(row.agent_runlab_score)),
      claude_code_scores: comparableRows.map((row) => Number(row.claude_code_score)),
      agent_contracts: summarizeContracts(agentContracts),
      claude_contracts: summarizeContracts(claudeContracts),
      agent_native_eval: agentNativeEval,
      claude_native_eval: claudeNativeEval,
      implementation_quality: implementationQuality,
      claude_sdk_cost_usd: claudeCosts,
      latest_contract_continuation_probe: continuationProbe,
      same_session_paid_diagnostic: sameSessionPaidDiagnostic,
      mechanism_readiness: mechanismReadiness,
    },
    gates,
    recommendation: {
      expand_to_5case_pilot: status === 'ready_for_5case_pilot',
      next_allowed_step: nextAllowedStep,
      validated_mechanism_fix: describeValidatedMechanismFix(mechanismReadiness),
      remaining_failure_mode: describeRemainingFailureMode(agentContracts, claudeContracts, agentNativeEval, claudeNativeEval, comparableRows, continuationProbe, mechanismReadiness, sameSessionPaidDiagnostic),
      suggested_command_shape: [
        'pnpm --filter @agent-kernel/host exec tsx bin/run-programbench-portfolio.ts',
        '  --portfolio-dir experiments/evals/2026-07-agent-benchmark-comparison',
        '  --cases experiments/evals/2026-07-agent-benchmark-comparison/planning/programbench/pilot-cases.jsonl',
        '  --agents agent-runlab,claude-code',
        '  --run-id programbench-sonnet-completion-control-validation-1',
        '  --model claude-sonnet-4-6',
        '  --timeout-ms 900000',
        '  --claude-inactivity-timeout-ms 120000',
        '  --max-turns 20',
        '  --repair-max-turns 4',
        '  --contract-continuation-attempts 2',
        '  --compile-repair-attempts 1',
        '  --native-eval-timeout-ms 2700000',
        '  --max-agent-runs 2',
        '  --stop-after-errors 1',
        '  --stop-after-contract-failures 2',
      ].join(' \\\n'),
      env_file: 'experiments/evals/2026-07-agent-benchmark-comparison/.env.local',
    },
  }

  await writeFile(path.join(programDiagnosisRoot, 'pilot-readiness.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(programDiagnosisRoot, 'pilot-readiness.md'), renderMarkdown(report))
  console.log(`ProgramBench pilot readiness: ${status}`)
}

async function readSameSessionPaidDiagnostic() {
  const runId = 'programbench-sonnet-monitored-pair-same-session-continuation-1'
  const runRoot = path.join(programRoot, runId)
  const summaryPath = path.join(runRoot, 'aborted-run-summary.json')
  const summary = await maybeReadJson(summaryPath)
  if (!summary) return null
  return {
    run_id: runId,
    status: summary.status,
    reporting_boundary: summary.reporting_boundary,
    agent_runlab: summary.agent_runlab,
    claude_code: summary.claude_code,
    evidence: path.relative(portfolioRoot, summaryPath),
  }
}

async function readContractContinuationProbe() {
  const runId = 'programbench-sonnet-monitored-pair-contract-continuation-1'
  const runRoot = path.join(programRoot, runId)
  const stoppedNotePath = path.join(runRoot, 'native-eval-stopped.md')
  const agentSummaryPath = path.join(runRoot, 'agent-runlab/lh3__seqtk.94e7070/contract-continuation-summary.json')
  const claudeContractPath = path.join(runRoot, 'claude-code/lh3__seqtk.94e7070/submission-contract.json')
  const claudeSdkPath = path.join(runRoot, 'claude-code/lh3__seqtk.94e7070/claude-code-artifacts/claude-agent-sdk.result.json')
  const [summary, claudeContract, claudeSdk, stoppedNote] = await Promise.all([
    maybeReadJson(agentSummaryPath),
    maybeReadJson(claudeContractPath),
    maybeReadJson(claudeSdkPath),
    fileExists(stoppedNotePath),
  ])
  if (!summary && !claudeContract && !stoppedNote) return null
  return {
    run_id: runId,
    scored_pair_complete: false,
    stopped_native_eval: stoppedNote,
    agent_runlab: summary
      ? {
          continuation_attempted: summary.attempted ?? 0,
          continuation_exhausted: summary.exhausted === true,
          final_ok: summary.final_ok === true,
          final_reason_codes: summary.final_reason_codes ?? [],
          stopped_after_no_progress: summary.stopped_after_no_progress ?? inferStoppedAfterNoProgress(summary),
          final_progress_classification: summary.final_progress_classification ?? inferFinalProgressClassification(summary),
        }
      : null,
    claude_code: claudeContract
      ? {
          contract_ok: claudeContract.ok === true,
          source_file_count: claudeContract.source_file_count ?? 0,
          sdk_terminal_reason: claudeSdk?.result?.terminal_reason ?? claudeSdk?.result?.subtype ?? null,
          sdk_total_cost_usd: Number(claudeSdk?.result?.total_cost_usd ?? 0),
        }
      : null,
    evidence: path.relative(portfolioRoot, stoppedNotePath),
  }
}

async function readMechanismReadiness() {
  const sameSessionManifestPath = path.join(programRoot, 'programbench-dry-run-same-session-continuation-check-2/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const sameSessionManifest = await maybeReadJson(sameSessionManifestPath)
  const currentRunGatePaths = [
    path.join(programRoot, 'programbench-sonnet-monitored-pair-artifact-guard-1/agent-runlab/lh3__seqtk.94e7070/submission-contract-gate.json'),
    path.join(programRoot, 'programbench-sonnet-monitored-pair-artifact-guard-1/claude-code/lh3__seqtk.94e7070/submission-contract-gate.json'),
  ]
  const contractGateFiles = []
  for (const gatePath of currentRunGatePaths) {
    const gate = await maybeReadJson(gatePath)
    contractGateFiles.push({
      path: path.relative(portfolioRoot, gatePath),
      exists: Boolean(gate),
      ok: gate?.ok ?? null,
      native_eval_policy: gate?.native_eval_policy ?? null,
    })
  }
  const nativeEvalTimeoutDryRunPath = path.join(programRoot, 'programbench-dry-run-native-eval-timeout-guard/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const nativeEvalTimeoutDryRun = await maybeReadJson(nativeEvalTimeoutDryRunPath)
  const interruptionGuardDryRunPath = path.join(programRoot, 'programbench-dry-run-interruption-guard-check/claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const interruptionGuardDryRun = await maybeReadJson(interruptionGuardDryRunPath)
  const entrypointCompletionDryRunPath = path.join(programRoot, 'programbench-dry-run-entrypoint-completion-control-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const entrypointCompletionDryRun = await maybeReadJson(entrypointCompletionDryRunPath)
  const resultFieldsDryRunRoot = path.join(programRoot, 'programbench-dry-run-completion-control-result-fields-check')
  const resultFieldsSummaryPath = path.join(resultFieldsDryRunRoot, 'score-summary.json')
  const resultFieldsPairwisePath = path.join(resultFieldsDryRunRoot, 'pairwise-comparison.jsonl')
  const resultFieldsSummary = await maybeReadJson(resultFieldsSummaryPath)
  const resultFieldsPairwise = await maybeReadJsonl(resultFieldsPairwisePath)
  const actionCheckAgentManifestPath = path.join(programRoot, 'programbench-dry-run-completion-control-action-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const actionCheckClaudeManifestPath = path.join(programRoot, 'programbench-dry-run-completion-control-action-check/claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const actionCheckAgentManifest = await maybeReadJson(actionCheckAgentManifestPath)
  const actionCheckClaudeManifest = await maybeReadJson(actionCheckClaudeManifestPath)
  const latestCompletionControlPath = path.join(programDiagnosisRoot, 'latest-completion-control.json')
  const latestCompletionControl = await maybeReadJson(latestCompletionControlPath)
  const promiseLoopGuardEvidence = findPromiseLoopGuardEvidence(latestCompletionControl)
  const compileRepairLoopDryRunRoot = path.join(programRoot, 'programbench-compile-repair-loop-dry-run')
  const compileRepairAgentManifestPath = path.join(compileRepairLoopDryRunRoot, 'agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const compileRepairClaudeManifestPath = path.join(compileRepairLoopDryRunRoot, 'claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const compileRepairSummaryPath = path.join(compileRepairLoopDryRunRoot, 'score-summary.json')
  const compileRepairAgentManifest = await maybeReadJson(compileRepairAgentManifestPath)
  const compileRepairClaudeManifest = await maybeReadJson(compileRepairClaudeManifestPath)
  const compileRepairSummary = await maybeReadJson(compileRepairSummaryPath)
  const continuationBoundaryDryRunRoot = path.join(programRoot, 'programbench-dry-run-single-continuation-boundary-check')
  const continuationBoundaryAgentManifestPath = path.join(continuationBoundaryDryRunRoot, 'agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const continuationBoundaryClaudeManifestPath = path.join(continuationBoundaryDryRunRoot, 'claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const continuationBoundarySummaryPath = path.join(continuationBoundaryDryRunRoot, 'score-summary.json')
  const continuationBoundaryAgentManifest = await maybeReadJson(continuationBoundaryAgentManifestPath)
  const continuationBoundaryClaudeManifest = await maybeReadJson(continuationBoundaryClaudeManifestPath)
  const continuationBoundarySummary = await maybeReadJson(continuationBoundarySummaryPath)
  const outerContractRepairDryRunRoot = path.join(programRoot, 'programbench-dry-run-runlab-outer-contract-repair-check')
  const outerContractRepairAgentManifestPath = path.join(outerContractRepairDryRunRoot, 'agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const outerContractRepairClaudeManifestPath = path.join(outerContractRepairDryRunRoot, 'claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const outerContractRepairSummaryPath = path.join(outerContractRepairDryRunRoot, 'score-summary.json')
  const outerContractRepairAgentManifest = await maybeReadJson(outerContractRepairAgentManifestPath)
  const outerContractRepairClaudeManifest = await maybeReadJson(outerContractRepairClaudeManifestPath)
  const outerContractRepairSummary = await maybeReadJson(outerContractRepairSummaryPath)
  const bootstrapDryRunRoot = path.join(programRoot, 'programbench-dry-run-bootstrap-skeleton-check')
  const bootstrapAgentManifestPath = path.join(bootstrapDryRunRoot, 'agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const bootstrapClaudeManifestPath = path.join(bootstrapDryRunRoot, 'claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const bootstrapSummaryPath = path.join(bootstrapDryRunRoot, 'score-summary.json')
  const bootstrapAgentManifest = await maybeReadJson(bootstrapAgentManifestPath)
  const bootstrapClaudeManifest = await maybeReadJson(bootstrapClaudeManifestPath)
  const bootstrapSummary = await maybeReadJson(bootstrapSummaryPath)
  const nativeEvalStoppedNote = path.join(programRoot, 'programbench-sonnet-monitored-pair-contract-continuation-1/native-eval-stopped.md')
  return {
    agent_runlab_same_session_continuation: sameSessionManifest?.dry_run === true
      && sameSessionManifest?.agent === 'agent-runlab'
      && sameSessionManifest?.contract_repair?.mode === 'same_session'
      && Boolean(sameSessionManifest?.case_json),
    same_session_manifest: sameSessionManifest
      ? {
          path: path.relative(portfolioRoot, sameSessionManifestPath),
          run_id: sameSessionManifest.run_id,
          continuation_attempts: sameSessionManifest.contract_repair?.continuation_attempts ?? null,
          repair_max_turns: sameSessionManifest.contract_repair?.max_turns ?? null,
        }
      : null,
    native_eval_timeout_guard: nativeEvalTimeoutDryRun?.dry_run === true
      && Number(nativeEvalTimeoutDryRun?.native_eval_timeout_ms ?? 0) > 0,
    native_eval_timeout_manifest: nativeEvalTimeoutDryRun
      ? {
          path: path.relative(portfolioRoot, nativeEvalTimeoutDryRunPath),
          timeout_ms: nativeEvalTimeoutDryRun.native_eval_timeout_ms ?? null,
        }
      : null,
    native_eval_stopped_note: await fileExists(nativeEvalStoppedNote) ? path.relative(portfolioRoot, nativeEvalStoppedNote) : null,
    claude_inactivity_timeout_guard: interruptionGuardDryRun?.dry_run === true
      && Number(interruptionGuardDryRun?.claude_inactivity_timeout_ms ?? 0) > 0,
    claude_inactivity_timeout_manifest: interruptionGuardDryRun
      ? {
          path: path.relative(portfolioRoot, interruptionGuardDryRunPath),
          timeout_ms: interruptionGuardDryRun.claude_inactivity_timeout_ms ?? null,
        }
      : null,
    submission_contract_gate: contractGateFiles.every((entry) => entry.exists),
    submission_contract_gate_files: contractGateFiles,
    entrypoint_completion_control: entrypointCompletionDryRun?.dry_run === true
      && entrypointCompletionDryRun?.agent === 'agent-runlab'
      && entrypointCompletionDryRun?.contract_repair?.mode === 'same_session'
      && Number(entrypointCompletionDryRun?.contract_repair?.continuation_attempts ?? 0) > 0,
    entrypoint_completion_manifest: entrypointCompletionDryRun
      ? {
          path: path.relative(portfolioRoot, entrypointCompletionDryRunPath),
          run_id: entrypointCompletionDryRun.run_id,
          continuation_attempts: entrypointCompletionDryRun.contract_repair?.continuation_attempts ?? null,
        }
      : null,
    completion_control_result_fields: resultFieldsSummary?.status === 'dry_run'
      && Array.isArray(resultFieldsPairwise)
      && resultFieldsPairwise.some((row) => Object.hasOwn(row, 'agent_runlab_completion_control'))
      && resultFieldsPairwise.some((row) => Object.hasOwn(row, 'claude_code_completion_control')),
    completion_control_result_fields_manifest: resultFieldsSummary
      ? {
          score_summary: path.relative(portfolioRoot, resultFieldsSummaryPath),
          pairwise: path.relative(portfolioRoot, resultFieldsPairwisePath),
          status: resultFieldsSummary.status ?? null,
          pairwise_rows: resultFieldsPairwise?.length ?? 0,
        }
      : null,
    completion_control_action_check: actionCheckAgentManifest?.dry_run === true
      && actionCheckAgentManifest?.contract_repair?.mode === 'same_session'
      && Number(actionCheckAgentManifest?.contract_repair?.continuation_attempts ?? 0) >= 3
      && actionCheckClaudeManifest?.dry_run === true
      && actionCheckClaudeManifest?.contract_repair?.mode === 'separate_sdk_invocations'
      && Number(actionCheckClaudeManifest?.contract_repair?.continuation_attempts ?? 0) >= 3,
    completion_control_action_manifest: actionCheckAgentManifest
      ? {
          agent_runlab: path.relative(portfolioRoot, actionCheckAgentManifestPath),
          claude_code: path.relative(portfolioRoot, actionCheckClaudeManifestPath),
          agent_runlab_mode: actionCheckAgentManifest.contract_repair?.mode ?? null,
          claude_code_mode: actionCheckClaudeManifest?.contract_repair?.mode ?? null,
          continuation_attempts: actionCheckAgentManifest.contract_repair?.continuation_attempts ?? null,
        }
      : null,
    promise_loop_guard: promiseLoopGuardEvidence.length > 0,
    promise_loop_guard_manifest: latestCompletionControl
      ? {
          path: path.relative(portfolioRoot, latestCompletionControlPath),
          guarded_attempts: promiseLoopGuardEvidence,
        }
      : null,
    compile_repair_loop_dry_run: compileRepairSummary?.status === 'dry_run'
      && compileRepairAgentManifest?.dry_run === true
      && Number(compileRepairAgentManifest?.compile_repair?.attempts ?? 0) > 0
      && compileRepairClaudeManifest?.dry_run === true
      && Number(compileRepairClaudeManifest?.compile_repair?.attempts ?? 0) > 0,
    compile_repair_loop_manifest: compileRepairSummary
      ? {
          score_summary: path.relative(portfolioRoot, compileRepairSummaryPath),
          agent_runlab: path.relative(portfolioRoot, compileRepairAgentManifestPath),
          claude_code: path.relative(portfolioRoot, compileRepairClaudeManifestPath),
          attempts: compileRepairAgentManifest?.compile_repair?.attempts ?? null,
          repair_max_turns: compileRepairAgentManifest?.compile_repair?.max_turns_per_attempt ?? null,
        }
      : null,
    single_continuation_boundary: continuationBoundarySummary?.status === 'dry_run'
      && continuationBoundaryAgentManifest?.dry_run === true
      && continuationBoundaryAgentManifest?.contract_repair?.mode === 'same_session_agent_runlab_prompt_runner'
      && continuationBoundaryClaudeManifest?.dry_run === true
      && continuationBoundaryClaudeManifest?.contract_repair?.mode === 'bounded_claude_code_repair_invocations',
    single_continuation_boundary_manifest: continuationBoundarySummary
      ? {
          score_summary: path.relative(portfolioRoot, continuationBoundarySummaryPath),
          agent_runlab: path.relative(portfolioRoot, continuationBoundaryAgentManifestPath),
          claude_code: path.relative(portfolioRoot, continuationBoundaryClaudeManifestPath),
          agent_runlab_mode: continuationBoundaryAgentManifest?.contract_repair?.mode ?? null,
          claude_code_mode: continuationBoundaryClaudeManifest?.contract_repair?.mode ?? null,
        }
      : null,
    agent_runlab_outer_contract_repair_fallback: outerContractRepairSummary?.status === 'dry_run'
      && outerContractRepairAgentManifest?.dry_run === true
      && outerContractRepairAgentManifest?.contract_repair?.mode === 'bounded_agent_runlab_repair_invocations_after_prompt_runner'
      && Number(outerContractRepairAgentManifest?.contract_repair?.continuation_attempts ?? 0) > 0
      && outerContractRepairClaudeManifest?.dry_run === true
      && outerContractRepairClaudeManifest?.contract_repair?.mode === 'bounded_claude_code_repair_invocations',
    agent_runlab_outer_contract_repair_manifest: outerContractRepairSummary
      ? {
          score_summary: path.relative(portfolioRoot, outerContractRepairSummaryPath),
          agent_runlab: path.relative(portfolioRoot, outerContractRepairAgentManifestPath),
          claude_code: path.relative(portfolioRoot, outerContractRepairClaudeManifestPath),
          agent_runlab_mode: outerContractRepairAgentManifest?.contract_repair?.mode ?? null,
          claude_code_mode: outerContractRepairClaudeManifest?.contract_repair?.mode ?? null,
          continuation_attempts: outerContractRepairAgentManifest?.contract_repair?.continuation_attempts ?? null,
        }
      : null,
    submission_skeleton_bootstrap: bootstrapSummary?.status === 'dry_run'
      && bootstrapAgentManifest?.dry_run === true
      && bootstrapAgentManifest?.runner_bootstrap?.submission_skeleton === true
      && bootstrapClaudeManifest?.dry_run === true
      && bootstrapClaudeManifest?.runner_bootstrap?.submission_skeleton === true,
    submission_skeleton_bootstrap_manifest: bootstrapSummary
      ? {
          score_summary: path.relative(portfolioRoot, bootstrapSummaryPath),
          agent_runlab: path.relative(portfolioRoot, bootstrapAgentManifestPath),
          claude_code: path.relative(portfolioRoot, bootstrapClaudeManifestPath),
          agent_runlab_enabled: bootstrapAgentManifest?.runner_bootstrap?.submission_skeleton ?? null,
          claude_code_enabled: bootstrapClaudeManifest?.runner_bootstrap?.submission_skeleton ?? null,
        }
      : null,
  }
}

function describeValidatedMechanismFix(mechanismReadiness) {
  const fixes = []
  fixes.push('host-path versus /workspace prompt semantics are fixed for the current Docker bash path')
  if (mechanismReadiness.agent_runlab_same_session_continuation) fixes.push('Agent RunLab contract continuation is wired as same-session user-message continuation and no-model dry-run validated')
  if (mechanismReadiness.native_eval_timeout_guard) fixes.push('native ProgramBench eval has a runner-level timeout guard recorded in dry-run manifest')
  if (mechanismReadiness.claude_inactivity_timeout_guard) fixes.push('Claude Code SDK inactivity timeout is wired and recorded in dry-run manifest')
  if (mechanismReadiness.submission_contract_gate) fixes.push('submission-contract gate artifacts exist for the current comparable ProgramBench row')
  if (mechanismReadiness.entrypoint_completion_control) fixes.push('source-file-aware contracts and entrypoint-focused repair prompts are wired and no-model dry-run validated')
  if (mechanismReadiness.completion_control_result_fields) fixes.push('ProgramBench formal result rows now expose completion-control classifications and failure labels')
  if (mechanismReadiness.completion_control_action_check) fixes.push('completion-control actions are dry-run wired to bounded continuation attempts instead of accepting unfinished finalization')
  if (mechanismReadiness.promise_loop_guard) fixes.push('no-progress promise loops are diagnosed and mapped to stop_no_progress instead of another continuation turn')
  if (mechanismReadiness.compile_repair_loop_dry_run) fixes.push('bounded compile-repair runner loop is dry-run validated and recorded in per-agent manifests')
  if (mechanismReadiness.single_continuation_boundary) fixes.push('ProgramBench contract repair has a single continuation boundary: Agent RunLab same-session inside the prompt runner, Claude Code bounded SDK invocations in the portfolio runner')
  if (mechanismReadiness.agent_runlab_outer_contract_repair_fallback) fixes.push('Agent RunLab has a bounded outer contract-repair fallback when the prompt runner exits before satisfying required artifacts')
  if (mechanismReadiness.submission_skeleton_bootstrap) fixes.push('ProgramBench runner records a shared pre-inference submission skeleton bootstrap for both agents so the next capped pair can move past missing compile.sh/source scaffolding')
  return fixes.join('; ')
}

function findPromiseLoopGuardEvidence(report) {
  const evidence = []
  for (const [agent, info] of Object.entries(report?.agents ?? {})) {
    for (const attempt of info.continuation_attempts ?? []) {
      const control = attempt.completion_control ?? {}
      if (control.classification === 'promise_without_artifacts' && control.action === 'stop_no_progress') {
        evidence.push({
          agent,
          attempt: attempt.attempt,
          response: attempt.response,
          progress_classification: attempt.progress?.classification ?? null,
          missing_required_artifacts: control.missing_required_artifacts ?? [],
        })
      }
    }
  }
  return evidence
}

function describeRemainingFailureMode(agentContracts, claudeContracts, agentNativeEval, claudeNativeEval, comparableRows, continuationProbe, mechanismReadiness, sameSessionPaidDiagnostic) {
  const agentCompileFailed = agentNativeEval.some((item) => item.primary_error_code === 'compile_failed')
  const claudeCompileFailed = claudeNativeEval.some((item) => item.primary_error_code === 'compile_failed')
  const agentContractFailed = agentContracts.some((contract) => contract.ok !== true)
  const claudeContractFailed = claudeContracts.some((contract) => contract.ok !== true)
  if (agentContractFailed || claudeContractFailed) {
    return `The latest uninterrupted capped pair reached native scoring, but both systems are still blocked at the artifact contract before compile repair can apply. Agent RunLab contract_ok=${!agentContractFailed} with reason_codes=${agentContracts.flatMap((contract) => contract.reason_codes ?? []).join(',') || 'none'}; Claude Code contract_ok=${!claudeContractFailed} with reason_codes=${claudeContracts.flatMap((contract) => contract.reason_codes ?? []).join(',') || 'none'}. Native eval reports compile_failed downstream, but the actionable readiness blocker is missing minimum artifacts.`
  }
  if (agentCompileFailed || claudeCompileFailed) {
    const agentContractOk = agentContracts.every((contract) => contract.ok === true)
    const claudeContractOk = claudeContracts.every((contract) => contract.ok === true)
    return `The latest uninterrupted capped pair reached native scoring, but ProgramBench reported compile_failed. Agent RunLab contract_ok=${agentContractOk} and compile_failed=${agentCompileFailed}; Claude Code contract_ok=${claudeContractOk} and compile_failed=${claudeCompileFailed}. This is later than the previous missing-artifact failure for Agent RunLab, but it is still not readiness for a 5-case pilot because compile success is not yet a runner/readiness gate.`
  }
  const scaffoldScores = comparableRows.filter((row) => row.failure_category === 'implementation_write_through_failure' || row.failure_category === 'scaffold_baseline_non_informative')
  if (scaffoldScores.length) {
    return `The latest capped pair reached native scoring and compile probes passed, but the score is a scaffold baseline rather than implementation evidence. Pairwise failure_category=${scaffoldScores.map((row) => row.failure_category).join(',')}; scores=${scaffoldScores.map((row) => `${row.instance_id}:agent=${row.agent_runlab_score},claude=${row.claude_code_score}`).join('; ')}. The runner-created compile.sh/main.c got both systems past the missing-artifact layer, but the agents did not write a substantive implementation before inactivity/abort.`
  }
  if (sameSessionPaidDiagnostic) {
    const agent = sameSessionPaidDiagnostic.agent_runlab ?? {}
    const claude = sameSessionPaidDiagnostic.claude_code ?? {}
    const latestAgentFailed = agentContracts.some((contract) => contract.ok !== true)
    const latestClaudeFailed = claudeContracts.some((contract) => contract.ok !== true)
    if (latestAgentFailed && latestClaudeFailed) {
      return `The latest uninterrupted capped pair completed native scoring for both systems, but both still failed the minimum artifact contract before scoring: Agent RunLab source_file_count=${agentContracts[0]?.source_file_count ?? 'unknown'} and Claude Code source_file_count=${claudeContracts[0]?.source_file_count ?? 'unknown'}, both missing compile.sh. The Claude inactivity guard prevented another unbounded stall, but this is still completion-control / entrypoint-production failure, not readiness for a 5-case pilot.`
    }
    return `The same-session paid diagnostic ran and should stay diagnostic only: Agent RunLab improved to source_file_count=${agent.source_file_count ?? 'unknown'} but still failed with ${Array.isArray(agent.contract_final_reason_codes) ? agent.contract_final_reason_codes.join(',') : 'unknown'}; Claude Code had workspace artifacts (${Array.isArray(claude.workspace_artifacts_present_at_abort) ? claude.workspace_artifacts_present_at_abort.join(', ') : 'unknown'}) but the runner was interrupted before packaging/native scoring. The next gate is completion-control work or one uninterrupted capped rerun after adding better interruption/inactivity handling, not a 5-case pilot.`
  }
  if (continuationProbe?.agent_runlab?.final_ok === false) {
    if (mechanismReadiness.agent_runlab_same_session_continuation) {
      return `The old separate-session continuation probe failed the Agent RunLab artifact contract after ${continuationProbe.agent_runlab.continuation_attempted} attempts. Since then, same-session Agent RunLab continuation has been wired and no-model validated, but no paid monitored pair has yet proven that it makes Agent RunLab produce required artifacts. The next gate is one capped same-session mechanism test, not a 5-case pilot.`
    }
    return `Agent RunLab still failed the minimum artifact contract after ${continuationProbe.agent_runlab.continuation_attempted} bounded contract-continuation attempts; Claude Code passed the artifact contract in that probe but native eval was stopped before a completed score. The next gate is mechanism work, not another same-shape paid pair.`
  }
  const agentFailed = agentContracts.some((contract) => contract.ok !== true)
  const claudeFailed = claudeContracts.some((contract) => contract.ok !== true)
  const scores = comparableRows.map((row) => [Number(row.agent_runlab_score), Number(row.claude_code_score)])
  const allZero = scores.length > 0 && scores.every(([agent, claude]) => agent === 0 && claude === 0)
  if (agentFailed && claudeFailed) return 'Both systems still failed the minimum artifact contract on the comparable case. This remains a task-strategy / completion-control failure, not the previous path-semantics failure.'
  if (agentFailed && allZero) return 'Agent RunLab still failed the minimum artifact contract; Claude Code produced the minimum artifacts but the native score remained 0. The next gate is to improve Agent RunLab artifact completion before expanding, while treating Claude Code compile/native-score failure as separate quality evidence.'
  if (allZero) return 'Both systems passed the minimum artifact contract, but native scores remained 0. The next gate is implementation quality, not artifact presence.'
  return 'At least one readiness gate still failed; inspect gate evidence before expanding.'
}

function inferStoppedAfterNoProgress(summary) {
  const last = summary?.attempts?.at?.(-1)
  if (!last) return null
  return inferProgressClassification(last) === 'no_progress'
}

function inferFinalProgressClassification(summary) {
  const last = summary?.attempts?.at?.(-1)
  return last ? inferProgressClassification(last) : null
}

function inferProgressClassification(attempt) {
  if (attempt?.progress?.classification) return attempt.progress.classification
  const before = attempt?.before ?? {}
  const after = attempt?.after ?? {}
  if (after.ok === true) return 'contract_satisfied'
  const beforeReasons = new Set(before.reason_codes ?? [])
  const afterReasons = new Set(after.reason_codes ?? [])
  const resolved = [...beforeReasons].filter((reason) => !afterReasons.has(reason))
  const added = [...afterReasons].filter((reason) => !beforeReasons.has(reason))
  const sourceDelta = Number(after.source_file_count ?? 0) - Number(before.source_file_count ?? 0)
  if (resolved.length || sourceDelta > 0) return 'progress'
  if (added.length || sourceDelta < 0) return 'regression'
  return 'no_progress'
}

function buildGates({ latest, scoreSummary, comparableRows, skippedRows, agentContracts, claudeContracts, agentNativeEval, claudeNativeEval, implementationQuality }) {
  const gates = []
  gates.push(gate(
    'native_scorer_available',
    latest.scorer === 'programbench.eval+score_instance' && comparableRows.length > 0,
    `scorer=${latest.scorer}; comparable_rows=${comparableRows.length}`,
  ))
  gates.push(gate(
    'model_controlled_pair_exists',
    Boolean(latest.model) && comparableRows.length >= 1,
    `model=${latest.model}; comparable_rows=${comparableRows.length}`,
  ))
  gates.push(gate(
    'stop_gates_active',
    Number(latest.stop_gates?.max_agent_runs ?? 0) > 0
      && Number(latest.stop_gates?.stop_after_errors ?? 0) > 0
      && Number(latest.stop_gates?.stop_after_contract_failures ?? 0) > 0,
    `stop_gates=${JSON.stringify(latest.stop_gates)}`,
  ))
  gates.push(gate(
    'run_scope_is_calibration_not_formal_subset',
    latest.status === 'partial' && latest.completed_agent_runs === 2 && skippedRows.length >= 4,
    `status=${latest.status}; completed_agent_runs=${latest.completed_agent_runs}; skipped_rows=${skippedRows.length}`,
  ))
  gates.push(gate(
    'agent_runlab_minimum_artifact_contract',
    agentContracts.length > 0 && agentContracts.every((contract) => contract.ok === true),
    contractDetail(agentContracts),
  ))
  gates.push(gate(
    'claude_code_minimum_artifact_contract',
    claudeContracts.length > 0 && claudeContracts.every((contract) => contract.ok === true),
    contractDetail(claudeContracts),
  ))
  gates.push(gate(
    'agent_runlab_native_compile_passed',
    agentNativeEval.length > 0 && agentNativeEval.every((summary) => compileGatePassed(summary)),
    nativeEvalDetail(agentNativeEval),
  ))
  gates.push(gate(
    'claude_code_native_compile_passed',
    claudeNativeEval.length > 0 && claudeNativeEval.every((summary) => compileGatePassed(summary)),
    nativeEvalDetail(claudeNativeEval),
  ))
  gates.push(gate(
    'implementation_written_through_after_bootstrap',
    implementationQuality.length > 0 && implementationQuality.every((item) => item.blocking !== true),
    implementationQuality.length
      ? implementationQuality.map((item) => `${item.agent}/${item.instance_id}:category=${item.category};bootstrapped=${item.bootstrapped};placeholder=${item.placeholder_implementation};promise=${item.final_response_promises_implementation};inactive=${item.inactivity_or_abort}`).join('; ')
      : 'no implementation quality evidence found',
  ))
  gates.push(gate(
    'native_scores_are_informative_before_expansion',
    comparableRows.some((row) => Number(row.agent_runlab_score) > 0 || Number(row.claude_code_score) > 0)
      && implementationQuality.every((item) => item.blocking !== true),
    `scores=${comparableRows.map((row) => `${row.instance_id}:agent=${row.agent_runlab_score},claude=${row.claude_code_score}`).join('; ') || 'none'}`,
  ))
  gates.push(gate(
    'score_summary_marks_calibration_not_official_subset',
    scoreSummary.status === 'partial' && scoreSummary.official === false,
    `score_summary.status=${scoreSummary.status}; official=${scoreSummary.official}`,
  ))
  return gates
}

async function readImplementationQuality(runRoot, instanceIds) {
  const rows = []
  for (const instanceId of instanceIds) {
    for (const agent of ['agent-runlab', 'claude-code']) {
      const caseRoot = path.join(runRoot, agent, instanceId)
      const contract = await maybeReadJson(path.join(caseRoot, 'submission-contract.json'))
      if (!contract) continue
      const responseText = await readFile(path.join(caseRoot, 'response.txt'), 'utf8').catch(() => '')
      const logText = await readCaseLogs(caseRoot)
      const mainText = await readFile(path.join(caseRoot, 'workspace/main.c'), 'utf8').catch(() => '')
      const bootstrapped = (contract.runner_normalizations ?? []).some((item) => item.kind === 'runner_bootstrap_submission_skeleton' && item.applied === true)
      const placeholder = isPlaceholderMain(mainText) && (contract.implementation_files ?? []).length === 1 && contract.implementation_files?.[0] === 'main.c'
      const promises = promisesImplementation(responseText)
      const inactive = /inactive for \d+ms|inactivityTimedOut"?:\s*true|process aborted by user/i.test(logText)
      const blocking = bootstrapped && placeholder && (promises || inactive)
      rows.push({
        agent,
        instance_id: instanceId,
        bootstrapped,
        placeholder_implementation: placeholder,
        final_response_promises_implementation: promises,
        inactivity_or_abort: inactive,
        category: blocking ? 'implementation_write_through_failure' : 'implementation_evidence_not_blocking',
        blocking,
      })
    }
  }
  return rows
}

async function readCaseLogs(caseRoot) {
  let text = ''
  text += await readFile(path.join(caseRoot, 'agent-error.txt'), 'utf8').catch(() => '')
  for (const entry of await readdir(caseRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith('.log')) text += `\n${await readFile(path.join(caseRoot, entry.name), 'utf8').catch(() => '')}`
  }
  return text
}

function isPlaceholderMain(text) {
  return /int\s+main\s*\([^)]*\)\s*\{\s*\(void\)argc;\s*\(void\)argv;\s*return\s+0;\s*\}/s.test(text)
}

function promisesImplementation(text) {
  return /\b(?:i\s+will|i'll|let\s+me|now\s+(?:i\s+will|let\s+me)|i\s+need\s+to)\b[^.\n]{0,160}\b(?:write|create|implement|reconstruct|add)\b/i.test(text)
    || /\b(?:write|create|implement|reconstruct|add)\b[^.\n]{0,160}\b(?:source|code|implementation|seqtk|program)\b/i.test(text)
}

function compileGatePassed(summary) {
  if (summary.compile_probe) return summary.compile_probe.ok === true
  return summary.primary_error_code !== 'compile_failed'
}

function nativeEvalDetail(summaries) {
  if (!summaries.length) return 'no native eval summaries found'
  return summaries.map((summary) => {
    const codes = Object.entries(summary.error_codes ?? {})
      .map(([code, count]) => `${code}:${count}`)
      .join(',') || 'none'
    const probe = summary.compile_probe
      ? `;compile_probe=${summary.compile_probe.status};compile_probe_reasons=${(summary.compile_probe.reason_codes ?? []).join(',') || 'none'}`
      : ';compile_probe=missing'
    const repair = summary.compile_repair_gate
      ? `;compile_repair=${summary.compile_repair_gate.classification}->${summary.compile_repair_gate.action}`
      : ';compile_repair=missing'
    return `${summary.instance_id}:score=${summary.score};primary_error_code=${summary.primary_error_code ?? 'none'};error_codes=${codes}${probe}${repair}`
  }).join('; ')
}

function gate(name, passed, evidence) {
  return { name, status: passed ? 'pass' : 'fail', evidence }
}

function contractDetail(contracts) {
  if (!contracts.length) return 'no comparable contracts found'
  return contracts.map((contract) => {
    const reasons = (contract.reason_codes ?? []).join(',') || 'none'
    return `${contract.instance_id}:ok=${contract.ok};source_file_count=${contract.source_file_count};implementation_file_count=${implementationFiles(contract).length};reason_codes=${reasons}`
  }).join('; ')
}

function summarizeContracts(contracts) {
  return contracts.map((contract) => ({
    instance_id: contract.instance_id,
    ok: contract.ok,
    compile_sh_exists: contract.checks?.compile_sh_exists ?? false,
    compile_sh_executable: contract.checks?.compile_sh_executable ?? false,
    source_files_present: contract.checks?.source_files_present ?? false,
    source_file_count: contract.source_file_count ?? 0,
    implementation_files_present: implementationFiles(contract).length > 0,
    implementation_file_count: implementationFiles(contract).length,
    implementation_files: implementationFiles(contract),
    reason_codes: contract.reason_codes ?? [],
    runner_normalizations: contract.runner_normalizations ?? [],
  }))
}

function implementationFiles(contract) {
  const explicit = contract?.implementation_files
  if (Array.isArray(explicit)) return explicit
  return (contract?.source_files ?? []).filter((file) => isImplementationFile(String(file)))
}

function isImplementationFile(file) {
  const name = file.split('/').at(-1) ?? file
  if (name === 'Makefile') return true
  return /\.(c|cc|cpp|cxx|go|rs|sh|py|java|js|ts|mk)$/i.test(name)
}

async function readContracts(runRoot, agent, instanceIds) {
  const contracts = []
  for (const instanceId of instanceIds) {
    const contract = await readJson(path.join(runRoot, agent, instanceId, 'submission-contract.json'))
    contracts.push({ instance_id: instanceId, ...contract })
  }
  return contracts
}

async function readNativeEvalSummaries(runRoot, agent, instanceIds) {
  const summaries = []
  for (const instanceId of instanceIds) {
    const nativeScore = await maybeReadJson(path.join(runRoot, agent, instanceId, 'native-score.json'))
    const compileProbe = await maybeReadJson(path.join(runRoot, agent, instanceId, 'compile-probe.json'))
    const compileRepairGate = await maybeReadJson(path.join(runRoot, agent, instanceId, 'compile-repair-gate.json'))
    const evalJsonPath = nativeScore?.eval_json
    const evalJson = evalJsonPath ? await maybeReadJson(evalJsonPath) : null
    const errorCodes = {}
    const statuses = {}
    for (const result of evalJson?.test_results ?? []) {
      const status = result.status ?? 'unknown'
      statuses[status] = (statuses[status] ?? 0) + 1
      const code = result.extra?.error_code
      if (code) errorCodes[code] = (errorCodes[code] ?? 0) + 1
    }
    const primaryErrorCode = Object.entries(errorCodes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    summaries.push({
      instance_id: instanceId,
      score: Number(nativeScore?.score ?? 0),
      scorer: nativeScore?.scorer ?? null,
      eval_json: evalJsonPath ? path.relative(portfolioRoot, evalJsonPath).replaceAll(path.sep, '/') : null,
      primary_error_code: primaryErrorCode,
      error_codes: errorCodes,
      statuses,
      compile_probe: compileProbe
        ? {
            ok: compileProbe.ok === true,
            status: compileProbe.status ?? null,
            reason_codes: compileProbe.reason_codes ?? [],
            exit_code: compileProbe.exit_code ?? null,
        }
        : null,
      compile_repair_gate: compileRepairGate
        ? {
            classification: compileRepairGate.compile_repair_control?.classification ?? null,
            action: compileRepairGate.compile_repair_control?.action ?? null,
            prompt: compileRepairGate.prompt ?? null,
          }
        : null,
    })
  }
  return summaries
}

async function readClaudeCosts(runRoot, instanceIds) {
  const costs = []
  for (const instanceId of instanceIds) {
    for (const relative of [
      path.join('claude-code', instanceId, 'claude-code-artifacts/claude-agent-sdk.result.json'),
      path.join('claude-code', instanceId, 'claude-code-contract-repair-artifacts/claude-agent-sdk.result.json'),
    ]) {
      const result = await maybeReadJson(path.join(runRoot, relative))
      if (!result) continue
      costs.push({
        instance_id: instanceId,
        artifact: relative,
        terminal_reason: result.result?.terminal_reason ?? result.result?.subtype ?? result.terminal_reason ?? result.subtype ?? null,
        num_turns: result.result?.num_turns ?? result.num_turns ?? null,
        total_cost_usd: Number(result.result?.total_cost_usd ?? result.total_cost_usd ?? result.total_cost ?? 0),
      })
    }
  }
  return costs
}

function renderMarkdown(report) {
  const lines = []
  lines.push('# ProgramBench Pilot Readiness')
  lines.push('')
  lines.push(`Status: \`${report.status}\`.`)
  lines.push('')
  lines.push('This audit is intentionally no-model and no-cloud. It decides whether the latest ProgramBench evidence is strong enough to expand beyond the monitored one-pair calibration.')
  lines.push('')
  lines.push('## Latest Evidence')
  lines.push('')
  lines.push(`- Run id: \`${report.latest_run.run_id}\``)
  lines.push(`- Model: \`${report.latest_run.model}\``)
  lines.push(`- Scorer: \`${report.latest_run.scorer}\``)
  lines.push(`- Completed agent runs: \`${report.latest_run.completed_agent_runs}\``)
  lines.push(`- Stop reason: \`${report.latest_run.stop_reason}\``)
  lines.push(`- Comparable rows: \`${report.evidence_summary.comparable_rows}\``)
  lines.push(`- Skipped rows: \`${report.evidence_summary.skipped_rows}\``)
  if (report.evidence_summary.latest_contract_continuation_probe) {
    const probe = report.evidence_summary.latest_contract_continuation_probe
    lines.push(`- Latest contract-continuation probe: \`${probe.run_id}\` (scored pair complete: \`${probe.scored_pair_complete}\`, native eval stopped: \`${probe.stopped_native_eval}\`)`)
  }
  if (report.evidence_summary.same_session_paid_diagnostic) {
    const diag = report.evidence_summary.same_session_paid_diagnostic
    lines.push(`- Same-session paid diagnostic: \`${diag.run_id}\` (${diag.status}; Agent RunLab final ok: \`${diag.agent_runlab?.contract_final_ok}\`; Claude scored: \`${diag.claude_code?.native_scored_by_runner}\`)`)
  }
  if (report.evidence_summary.mechanism_readiness) {
    const readiness = report.evidence_summary.mechanism_readiness
    lines.push(`- Agent RunLab same-session continuation ready: \`${readiness.agent_runlab_same_session_continuation}\``)
    lines.push(`- Native-eval timeout guard ready: \`${readiness.native_eval_timeout_guard}\``)
    lines.push(`- Submission-contract gate artifacts ready: \`${readiness.submission_contract_gate}\``)
    lines.push(`- Entrypoint completion-control ready: \`${readiness.entrypoint_completion_control}\``)
    lines.push(`- Completion-control result fields ready: \`${readiness.completion_control_result_fields}\``)
    lines.push(`- Completion-control action check ready: \`${readiness.completion_control_action_check}\``)
    lines.push(`- No-progress promise-loop guard ready: \`${readiness.promise_loop_guard}\``)
    lines.push(`- Single continuation boundary ready: \`${readiness.single_continuation_boundary}\``)
    lines.push(`- Agent RunLab outer contract-repair fallback ready: \`${readiness.agent_runlab_outer_contract_repair_fallback}\``)
    lines.push(`- Shared submission skeleton bootstrap ready: \`${readiness.submission_skeleton_bootstrap}\``)
  }
  if (report.evidence_summary.agent_native_eval?.length || report.evidence_summary.claude_native_eval?.length) {
    const agentNative = report.evidence_summary.agent_native_eval?.map((item) => `${item.instance_id}:${item.primary_error_code ?? 'none'}`).join(', ') || 'none'
    const claudeNative = report.evidence_summary.claude_native_eval?.map((item) => `${item.instance_id}:${item.primary_error_code ?? 'none'}`).join(', ') || 'none'
    const agentRepair = report.evidence_summary.agent_native_eval?.map((item) => `${item.instance_id}:${item.compile_repair_gate?.classification ?? 'missing'}->${item.compile_repair_gate?.action ?? 'missing'}`).join(', ') || 'none'
    const claudeRepair = report.evidence_summary.claude_native_eval?.map((item) => `${item.instance_id}:${item.compile_repair_gate?.classification ?? 'missing'}->${item.compile_repair_gate?.action ?? 'missing'}`).join(', ') || 'none'
    lines.push(`- Agent RunLab native eval primary errors: \`${agentNative}\``)
    lines.push(`- Claude Code native eval primary errors: \`${claudeNative}\``)
    lines.push(`- Agent RunLab compile repair gates: \`${agentRepair}\``)
    lines.push(`- Claude Code compile repair gates: \`${claudeRepair}\``)
  }
  lines.push('')
  lines.push('## Gates')
  lines.push('')
  lines.push('| Gate | Status | Evidence |')
  lines.push('|---|---:|---|')
  for (const item of report.gates) {
    lines.push(`| \`${item.name}\` | \`${item.status}\` | ${escapePipes(item.evidence)} |`)
  }
  lines.push('')
  lines.push('## Interpretation')
  lines.push('')
  if (report.status === 'ready_for_5case_pilot') {
    lines.push('The latest evidence clears the readiness gates. A bounded 5-case pilot can run next with the same stop gates preserved.')
  } else {
    lines.push('The latest evidence does not clear the readiness gates. The runner and native scorer are mechanically usable, but the evidence is still benchmark-quality insufficient because at least one minimum artifact or informativeness gate failed.')
  }
  lines.push('')
  lines.push('## Recommendation')
  lines.push('')
  lines.push(`- Expand to 5-case pilot: \`${report.recommendation.expand_to_5case_pilot}\``)
  lines.push(`- Next allowed step: ${report.recommendation.next_allowed_step}`)
  lines.push(`- Validated mechanism fix: ${report.recommendation.validated_mechanism_fix}`)
  lines.push(`- Remaining failure mode: ${report.recommendation.remaining_failure_mode}`)
  lines.push('')
  lines.push('Suggested command shape after the failed gates are addressed or explicitly accepted:')
  lines.push('')
  lines.push('```bash')
  lines.push(report.recommendation.suggested_command_shape)
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|')
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function maybeReadJson(filePath) {
  try {
    return await readJson(filePath)
  } catch {
    return null
  }
}

async function maybeReadJsonl(filePath) {
  try {
    return await readJsonl(filePath)
  } catch {
    return null
  }
}

async function fileExists(filePath) {
  try {
    await readFile(filePath, 'utf8')
    return true
  } catch {
    return false
  }
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

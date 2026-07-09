#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runner = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')

async function main() {
  const summary = await readJson('results/benchmark-summary.json')
  const rows = await readJsonl('results/cross-benchmark-pairwise.jsonl')
  const artifactCompleteness = await readJson('results/artifact-completeness.json')
  const objectiveCoverage = await readJson('results/objective-coverage.json')
  const legacy-runnerAnalysis = await readText('legacy-runner-analysis.md')
  const manifest = await readText('manifest.md')
  const nextActions = await readText('next-actions.md')
  const evidenceNotes = await readText('evidence-notes.md')
  const failures = []

  if (summary.schema_version !== 2) failures.push('benchmark-summary.json schema_version must be 2')
  if (summary.status !== 'legacy-runner_in_progress') failures.push('legacy-runner status must be legacy-runner_in_progress until all benchmark subsets are complete')
  if (rows.length < 63) failures.push(`expected at least 63 current pairwise rows, got ${rows.length}`)
  if (artifactCompleteness.schema_version !== 1) failures.push('artifact-completeness.json schema_version must be 1')
  if (artifactCompleteness.status !== 'pass') failures.push(`artifact completeness status must be pass for current headline/latest evidence, got ${artifactCompleteness.status}`)
  for (const benchmark of artifactCompleteness.benchmarks ?? []) {
    if (benchmark.missing !== 0) failures.push(`${benchmark.benchmark} artifact completeness has ${benchmark.missing} missing required artifact(s)`)
  }
  if (objectiveCoverage.schema_version !== 1) failures.push('objective-coverage.json schema_version must be 1')
  if (objectiveCoverage.status !== 'in_progress') failures.push(`objective coverage must remain in_progress until every benchmark is complete, got ${objectiveCoverage.status}`)
  if (!String(objectiveCoverage.legacy-runner?.current_scope ?? '').includes('SWE-Marathon source/no-run calibration')) failures.push('objective coverage must record SWE-Marathon source/no-run calibration as in scope')
  const completedCoverage = new Set(objectiveCoverage.legacy-runner?.completed_benchmarks ?? [])
  if (completedCoverage.size !== 1 || !completedCoverage.has('swebench')) {
    failures.push(`objective coverage completed benchmarks must currently be exactly swebench, got ${[...completedCoverage].join(',')}`)
  }
  for (const requiredIncomplete of ['browsecomp', 'swe-marathon', 'program-bench', 'job-bench']) {
    if (!(objectiveCoverage.legacy-runner?.incomplete_benchmarks ?? []).includes(requiredIncomplete)) {
      failures.push(`objective coverage must mark ${requiredIncomplete} incomplete`)
    }
  }

  const byBenchmark = new Map(summary.benchmarks.map((item) => [item.benchmark, item]))
  expectBenchmark(byBenchmark, failures, 'swebench', 'official_subset', 'completed_existing_package', 30, 30)
  expectBenchmark(byBenchmark, failures, 'browsecomp', 'scored_smoke', 'smoke_scored_not_formal_subset', 1, 1)
  expectBenchmark(byBenchmark, failures, 'swe-marathon', 'source_audited_no_run_calibrated', 'source_audited_no_run_calibrated', 0, 0)
  expectBenchmark(byBenchmark, failures, 'program-bench', 'official_calibration', 'gated_official_pilot_not_formal_subset', 1, 1)
  expectBenchmark(byBenchmark, failures, 'job-bench', 'submitted_unscored', 'one_case_submitted_unscored_not_formal_subset', 1, 0)

  const latestBrowseComp = await readJson('reports/browsecomp/latest-run-summary.json')
  if (latestBrowseComp.status !== 'completed') failures.push(`BrowseComp latest status must be completed, got ${latestBrowseComp.status}`)
  if (latestBrowseComp.stop_reason && latestBrowseComp.stop_reason !== 'max_agent_runs:2') failures.push(`BrowseComp latest must not point at a stopped diagnostic run, got stop_reason=${latestBrowseComp.stop_reason}`)
  if (latestBrowseComp.selected_cases !== 1) failures.push(`BrowseComp current scored-smoke latest should have selected_cases=1, got ${latestBrowseComp.selected_cases}`)

  const browseRows = rows.filter((row) => row.benchmark === 'browsecomp')
  if (browseRows.length !== 1) failures.push(`expected one BrowseComp legacy-runner row, got ${browseRows.length}`)
  const browseRow = browseRows[0]
  if (browseRow) {
    if (browseRow.run_id !== latestBrowseComp.run_id) failures.push(`BrowseComp row run_id must match latest run ${latestBrowseComp.run_id}, got ${browseRow.run_id}`)
    if (browseRow.evidence_level !== 'scored_smoke') failures.push(`BrowseComp row evidence_level must remain scored_smoke, got ${browseRow.evidence_level}`)
    if (browseRow.winner === 'not_comparable') failures.push('BrowseComp headline row must be comparable; partial diagnostics must stay run-scoped')
    if (!['resolved', 'unresolved'].includes(browseRow.agent_runlab_status) || !['resolved', 'unresolved'].includes(browseRow.claude_code_status)) {
      failures.push(`BrowseComp headline row should have both systems judged, got agent=${browseRow.agent_runlab_status}, claude=${browseRow.claude_code_status}`)
    }
  }

  const browsePairwise = await readJsonl('reports/browsecomp/pairwise-comparison.jsonl')
  if (browsePairwise.length !== 1) failures.push(`BrowseComp top-level pairwise should contain one headline row, got ${browsePairwise.length}`)
  if (browsePairwise[0]?.run_id && browsePairwise[0].run_id !== latestBrowseComp.run_id) failures.push('BrowseComp top-level pairwise run id must match latest')
  if (browsePairwise[0]?.winner === 'not_comparable') failures.push('BrowseComp top-level pairwise must not point at a partial diagnostic row')

  const browseGradingSummary = await readJson('artifacts/browsecomp/grading/score-summary.json')
  if (browseGradingSummary.run_id !== latestBrowseComp.run_id) failures.push(`BrowseComp grading summary run_id must match latest run ${latestBrowseComp.run_id}, got ${browseGradingSummary.run_id}`)
  if (browseGradingSummary.status !== 'completed') failures.push(`BrowseComp grading summary status must be completed, got ${browseGradingSummary.status}`)

  const browsePreflight = await readJson('planning/browsecomp/browsecomp-pilot-case-preflight.json')
  const browseReadiness = await readJson('planning/browsecomp/browsecomp-pilot-readiness.json')
  const browseTargetSelected = await readJsonl('planning/browsecomp/browsecomp-target-selected-cases.jsonl')
  const browsePartialDiagnosis = await readJson('diagnostics/browsecomp/latest-partial-run-diagnosis.json')
  const recommended = browsePreflight.recommended_case_ids ?? []
  if (browsePreflight.target_subset_size !== 30) failures.push(`BrowseComp preflight target_subset_size must be 30, got ${browsePreflight.target_subset_size}`)
  if ((browsePreflight.target_case_ids ?? []).length !== 30) failures.push(`BrowseComp preflight target_case_ids must contain 30 rows, got ${(browsePreflight.target_case_ids ?? []).length}`)
  if (browseTargetSelected.length !== 30) failures.push(`BrowseComp target selected cases must contain 30 rows, got ${browseTargetSelected.length}`)
  if (browseTargetSelected.some((row) => Object.hasOwn(row, 'answer') || Object.hasOwn(row, 'canary'))) failures.push('BrowseComp target selected cases must not include answers or canaries')
  if ((browsePreflight.policy ?? {}).formal_subset_is_full_selected_cases !== true) failures.push('BrowseComp preflight must record that the formal subset is the full selected-case set')
  if ((browsePreflight.policy ?? {}).immediate_gate_is_fresh_unrun_prefix !== true && (browsePreflight.policy ?? {}).immediate_gate_is_formal_rerun_prefix !== true) failures.push('BrowseComp preflight must record whether the immediate gate is a fresh prefix or fixed-subset formal rerun prefix')
  const browseReadinessBraked = browseReadiness.status === 'not_ready_for_next_pair'
  const browseFormalRerunMode = browsePreflight.immediate_gate?.mode === 'formal_rerun_prefix'
  const browseAvailableFreshCandidates = (browsePreflight.rows ?? []).filter((row) => row.recommendation === 'candidate').length
  const browseExpectedImmediateCandidates = Math.min(5, browseAvailableFreshCandidates)
  if (!browseReadinessBraked && !browseFormalRerunMode && recommended.length !== browseExpectedImmediateCandidates) {
    failures.push(`BrowseComp preflight should recommend all available fresh pilot cases up to five when readiness is active, got ${recommended.length}, expected ${browseExpectedImmediateCandidates}`)
  }
  if (browseFormalRerunMode) {
    if (browseAvailableFreshCandidates !== 0) failures.push(`BrowseComp formal rerun mode requires no fresh candidates, got ${browseAvailableFreshCandidates}`)
    if (recommended.length < 1) failures.push('BrowseComp formal rerun mode must recommend at least one fixed-subset rerun case')
    for (const recommendedId of recommended) {
      const row = (browsePreflight.rows ?? []).find((item) => item.instance_id === recommendedId)
      if (row?.formal_rerun_needed !== true) failures.push(`BrowseComp formal rerun recommended case ${recommendedId} must have formal_rerun_needed=true`)
    }
  }
  if (browseReadinessBraked && recommended.length < 1) failures.push('BrowseComp braked readiness should still retain at least one mechanical next case for traceability')
  const browsePilotSelected = await readJsonl('planning/browsecomp/browsecomp-pilot-selected-cases.jsonl')
  const browsePilotSelectedIds = browsePilotSelected.map((row) => row.instance_id)
  if (browsePilotSelectedIds.join(',') !== recommended.join(',')) {
    failures.push(`BrowseComp fixed pilot jsonl must match preflight recommendations, got jsonl=${browsePilotSelectedIds.join(',')} preflight=${recommended.join(',')}`)
  }
  for (const recommendedId of recommended) {
    const row = (browsePreflight.rows ?? []).find((item) => item.instance_id === recommendedId)
    if (!browseFormalRerunMode && row?.recommendation !== 'candidate') failures.push(`BrowseComp recommended case ${recommendedId} must be marked candidate`)
    if (!browseFormalRerunMode && row?.reasons) failures.push(`BrowseComp recommended case ${recommendedId} should not have exclusion reasons, got ${row.reasons}`)
    if (!browseFormalRerunMode && row?.prior_runs) failures.push(`BrowseComp recommended case ${recommendedId} should not have prior runs, got ${row.prior_runs}`)
  }
  for (const row of browsePreflight.rows ?? []) {
    if (row.prior_runs && row.recommendation !== 'exclude') failures.push(`BrowseComp preflight should exclude prior-run case ${row.instance_id}`)
  }
  if (!['ready_for_one_pair_pilot', 'not_ready_for_next_pair'].includes(browseReadiness.status)) failures.push(`BrowseComp pilot readiness has unexpected status ${browseReadiness.status}`)
  if (browseReadiness.latest_headline_run?.run_id !== latestBrowseComp.run_id) failures.push(`BrowseComp readiness latest headline must match ${latestBrowseComp.run_id}, got ${browseReadiness.latest_headline_run?.run_id}`)
  if (browseReadiness.target_subset?.size !== 30) failures.push(`BrowseComp readiness target subset size must be 30, got ${browseReadiness.target_subset?.size}`)
  if (browseReadiness.target_subset?.artifact !== 'planning/browsecomp/browsecomp-target-selected-cases.jsonl') failures.push(`BrowseComp readiness target artifact mismatch: ${browseReadiness.target_subset?.artifact}`)
  if ((browseReadiness.recommended_case_ids ?? []).join(',') !== recommended.join(',')) failures.push('BrowseComp readiness recommended cases must match pilot preflight')
  if (browseReadinessBraked) {
    if (!String(browseReadiness.next_allowed_step ?? '').includes('Fix failing no-paid readiness checks')) failures.push('BrowseComp braked readiness must block paid spending')
    const failedChecks = (browseReadiness.checks ?? []).filter((check) => check.status !== 'pass').map((check) => check.name)
    if (!failedChecks.includes('latest_turn_limit_has_newer_strategy_control')) failures.push(`BrowseComp braked readiness must be caused by latest strategy-control gate, got ${failedChecks.join(',')}`)
  } else {
    if (!recommended[0] || !String(browseReadiness.next_allowed_step ?? '').includes(recommended[0])) failures.push(`BrowseComp readiness next step must start with current first fresh case ${recommended[0] ?? '<none>'}`)
    if (!String(browseReadiness.next_allowed_step ?? '').includes('--max-agent-runs 2')) failures.push('BrowseComp readiness next step must preserve max-agent-runs=2 gate')
    for (const check of browseReadiness.checks ?? []) {
      if (check.status !== 'pass') failures.push(`BrowseComp readiness check failed: ${check.name}`)
    }
  }
  const validBrowsePartialStatuses = new Set(['diagnosed_partial_not_formal_subset', 'diagnosed_completed_pair_not_formal_subset'])
  if (!validBrowsePartialStatuses.has(browsePartialDiagnosis.status)) failures.push(`BrowseComp partial diagnosis has unexpected status ${browsePartialDiagnosis.status}`)
  if (browsePartialDiagnosis.latest_partial_run?.status !== 'partial_stopped') failures.push('BrowseComp partial diagnosis must point at a partial_stopped run')
  if (browsePartialDiagnosis.status === 'diagnosed_partial_not_formal_subset') {
    if (browsePartialDiagnosis.pairwise?.winner !== 'not_comparable') failures.push(`BrowseComp partial diagnosis winner must remain not_comparable, got ${browsePartialDiagnosis.pairwise?.winner}`)
    if (!String(browsePartialDiagnosis.next_gate ?? '').includes('query discipline')) failures.push('BrowseComp partial diagnosis next gate must require query discipline improvement')
    if (!(browsePartialDiagnosis.diagnosis ?? []).some((item) => item.category === 'not_comparable_partial_run')) failures.push('BrowseComp partial diagnosis must classify partial run as non-formal evidence')
  } else {
    if (browsePartialDiagnosis.pairwise?.winner === 'not_comparable') failures.push('BrowseComp completed-pair diagnosis must be comparable')
    if (browsePartialDiagnosis.latest_partial_run?.stop_reason !== 'max_agent_runs:2') failures.push(`BrowseComp completed-pair diagnosis must be capped only by max_agent_runs:2, got ${browsePartialDiagnosis.latest_partial_run?.stop_reason}`)
    if (browsePartialDiagnosis.latest_partial_run?.completed_agent_runs !== browsePartialDiagnosis.latest_partial_run?.requested_agent_runs) failures.push('BrowseComp completed-pair diagnosis must have completed all requested agent runs')
    if (!String(browsePartialDiagnosis.next_gate ?? '').includes('next fresh pair')) failures.push('BrowseComp completed-pair diagnosis next gate must require the next fresh pair')
    if (!(browsePartialDiagnosis.diagnosis ?? []).some((item) => item.category === 'completed_comparable_pair_not_formal_subset')) failures.push('BrowseComp completed-pair diagnosis must classify the one-pair scope boundary')
  }

  const sweMarathonBenchmark = byBenchmark.get('swe-marathon')
  if (sweMarathonBenchmark?.executed_cases !== 0) failures.push(`SWE-Marathon must remain unexecuted while deferred, got executed_cases=${sweMarathonBenchmark?.executed_cases}`)
  if (sweMarathonBenchmark?.scored_cases !== 0) failures.push(`SWE-Marathon must remain unscored while deferred, got scored_cases=${sweMarathonBenchmark?.scored_cases}`)
  if (!String(sweMarathonBenchmark?.result_summary ?? '').includes('no_run_template_validated')) failures.push('SWE-Marathon summary must record no-run calibration status')
  if (!String(sweMarathonBenchmark?.result_summary ?? '').includes('job_started=false')) failures.push('SWE-Marathon summary must prove no Harbor/Modal job was started')
  if (!String(sweMarathonBenchmark?.next_gate ?? '').includes('Validate Modal credentials')) failures.push('SWE-Marathon next gate must require Modal credential validation')
  if (!String(sweMarathonBenchmark?.next_gate ?? '').includes('explicit spending controls')) failures.push('SWE-Marathon next gate must require explicit spending controls')
  const sweMarathonSource = await readJson('diagnostics/swe-marathon/source-preflight.json')
  const sweMarathonNoRun = await readJson('diagnostics/swe-marathon/no-run-calibration/preflight-summary.json')
  const sweMarathonConfigText = await readText('diagnostics/swe-marathon/no-run-calibration/stripe-clone-claude-code-sonnet-modal.config.json')
  const sweMarathonReadmeText = await readText('diagnostics/swe-marathon/no-run-calibration/README.md')
  if (sweMarathonSource.selected_cases !== 20) failures.push(`SWE-Marathon source audit must retain 20 selected cases, got ${sweMarathonSource.selected_cases}`)
  if (sweMarathonSource.gpu_cases !== 5) failures.push(`SWE-Marathon source audit must record 5 GPU cases, got ${sweMarathonSource.gpu_cases}`)
  if (sweMarathonSource.internet_restricted_cases !== 7) failures.push(`SWE-Marathon source audit must record 7 internet-restricted cases, got ${sweMarathonSource.internet_restricted_cases}`)
  if (sweMarathonNoRun.status !== 'no_run_template_validated') failures.push(`SWE-Marathon no-run calibration must be validated, got ${sweMarathonNoRun.status}`)
  if (sweMarathonNoRun.task !== 'stripe-clone') failures.push(`SWE-Marathon no-run calibration task must be stripe-clone, got ${sweMarathonNoRun.task}`)
  if (sweMarathonNoRun.job_started !== false) failures.push('SWE-Marathon no-run calibration must prove job_started=false')
  if (sweMarathonNoRun.selected_case?.gpus !== 0) failures.push(`SWE-Marathon first calibration case must be non-GPU, got gpus=${sweMarathonNoRun.selected_case?.gpus}`)
  if (sweMarathonNoRun.modal_credentials_validated !== false) failures.push('SWE-Marathon Modal credentials must remain unvalidated until explicit auth exists')
  if (sweMarathonNoRun.spending_controls_validated !== false) failures.push('SWE-Marathon spending controls must remain false until explicitly validated')
  if ((sweMarathonNoRun.validation?.errors ?? []).length) failures.push(`SWE-Marathon no-run validation errors: ${sweMarathonNoRun.validation.errors.join('; ')}`)
  if (!String(sweMarathonNoRun.print_config_result ?? '').includes('succeeded_without_starting_job')) failures.push(`SWE-Marathon print-config result must prove no-run validation, got ${sweMarathonNoRun.print_config_result}`)
  for (const [fileName, text] of [
    ['diagnostics/swe-marathon/no-run-calibration/preflight-summary.json', JSON.stringify(sweMarathonNoRun)],
    ['diagnostics/swe-marathon/no-run-calibration/stripe-clone-claude-code-sonnet-modal.config.json', sweMarathonConfigText],
    ['diagnostics/swe-marathon/no-run-calibration/README.md', sweMarathonReadmeText],
  ]) {
    if (text.includes('agent-benchmark-comparison-2026-07')) failures.push(`${fileName} must not contain stale old experiment path agent-benchmark-comparison-2026-07`)
  }
  for (const [fileName, text] of [
    ['legacy-runner-analysis.md', legacy-runnerAnalysis],
    ['manifest.md', manifest],
    ['next-actions.md', nextActions],
    ['evidence-notes.md', evidenceNotes],
  ]) {
    if (!text.includes('source_audited_no_run_calibrated')) failures.push(`${fileName} must describe SWE-Marathon as source_audited_no_run_calibrated`)
    if (!text.includes('no_run_template_validated')) failures.push(`${fileName} must describe SWE-Marathon no-run calibration status`)
    if (!text.includes('job_started=false') && !text.includes('Job started: no')) failures.push(`${fileName} must state that no SWE-Marathon job was started`)
    if (!text.includes('Validate Modal credentials')) failures.push(`${fileName} must keep SWE-Marathon live execution behind Modal credential validation`)
  }

  const latestProgramBench = await readJson('reports/programbench/latest-run-summary.json')
  const programReadiness = await readJson('diagnostics/programbench/pilot-readiness.json')
  const programFailureDiagnosis = await readJson('diagnostics/programbench/latest-failure-diagnosis.json')
  const programEntrypointDiagnosis = await readJson('diagnostics/programbench/latest-entrypoint-diagnosis.json')
  const programCompletionControl = await readJson('diagnostics/programbench/latest-completion-control.json')
  const sameSessionDryRunManifest = await readJson('artifacts/program-bench/programbench-dry-run-same-session-continuation-check-2/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const progressGateDryRunManifest = await readJson('artifacts/program-bench/programbench-dry-run-contract-progress-gate-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const interruptionGuardDryRunManifest = await readJson('artifacts/program-bench/programbench-dry-run-interruption-guard-check/claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const entrypointCompletionDryRunManifest = await readJson('artifacts/program-bench/programbench-dry-run-entrypoint-completion-control-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const completionControlResultFieldsSummary = await readJson('artifacts/program-bench/programbench-dry-run-completion-control-result-fields-check/score-summary.json')
  const completionControlResultFieldsRows = await readJsonl('artifacts/program-bench/programbench-dry-run-completion-control-result-fields-check/pairwise-comparison.jsonl')
  const completionControlActionAgentManifest = await readJson('artifacts/program-bench/programbench-dry-run-completion-control-action-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const completionControlActionClaudeManifest = await readJson('artifacts/program-bench/programbench-dry-run-completion-control-action-check/claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const singleContinuationBoundaryAgentManifest = await readJson('artifacts/program-bench/programbench-dry-run-single-continuation-boundary-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const singleContinuationBoundaryClaudeManifest = await readJson('artifacts/program-bench/programbench-dry-run-single-continuation-boundary-check/claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const outerContractRepairAgentManifest = await readJson('artifacts/program-bench/programbench-dry-run-runlab-outer-contract-repair-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const outerContractRepairClaudeManifest = await readJson('artifacts/program-bench/programbench-dry-run-runlab-outer-contract-repair-check/claude-code/lh3__seqtk.94e7070/run-manifest.json')
  const bootstrapSkeletonAgentManifest = await readJson('artifacts/program-bench/programbench-dry-run-bootstrap-skeleton-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json')
  const bootstrapSkeletonClaudeManifest = await readJson('artifacts/program-bench/programbench-dry-run-bootstrap-skeleton-check/claude-code/lh3__seqtk.94e7070/run-manifest.json')
  if (latestProgramBench.status === 'dry_run') failures.push('ProgramBench latest-run-summary.json must not point at a dry-run')
  if (!['scored', 'partial'].includes(latestProgramBench.status)) failures.push(`ProgramBench latest status must be a scored or partial capped validation pair, got ${latestProgramBench.status}`)
  if (latestProgramBench.completed_agent_runs !== 2) failures.push(`ProgramBench latest completed_agent_runs must be 2, got ${latestProgramBench.completed_agent_runs}`)
  if (latestProgramBench.stop_reason !== 'max_agent_runs:2') failures.push(`ProgramBench latest stop_reason must be max_agent_runs:2, got ${latestProgramBench.stop_reason}`)
  if (latestProgramBench.scorer !== 'programbench.eval+score_instance') failures.push(`ProgramBench latest scorer must be programbench.eval+score_instance, got ${latestProgramBench.scorer}`)
  if (programReadiness.status !== 'not_ready_for_5case_pilot') failures.push(`ProgramBench pilot readiness must remain not_ready_for_5case_pilot until gates pass, got ${programReadiness.status}`)
  if (programReadiness.latest_run?.run_id !== latestProgramBench.run_id) failures.push(`ProgramBench readiness run_id must match latest run ${latestProgramBench.run_id}, got ${programReadiness.latest_run?.run_id}`)
  if (programReadiness.recommendation?.expand_to_5case_pilot !== false) failures.push('ProgramBench readiness recommendation must forbid 5-case expansion after the capped validation pair')
  const programNextAllowedStep = String(programReadiness.recommendation?.next_allowed_step ?? '')
  if (!programNextAllowedStep.includes('Do not expand to the 5-case pilot yet')) failures.push('ProgramBench readiness recommendation must explicitly forbid 5-case expansion')
  if (latestProgramBench.run_id === 'programbench-sonnet-two-agent-continuation-validation-1') {
    if (!programNextAllowedStep.includes('compile-repair gate evidence')) failures.push('ProgramBench readiness recommendation must record compile-repair gate evidence for latest run')
    if (!programNextAllowedStep.includes('one monitored capped validation pair')) failures.push('ProgramBench readiness recommendation must require exactly one monitored capped validation pair after compile-repair gate validation')
  } else if (latestProgramBench.run_id === 'programbench-sonnet-entrypoint-validation-1') {
    if (!programNextAllowedStep.includes('Completion-control actions are now no-model validated')) failures.push('ProgramBench readiness recommendation must record completion-control action validation')
    if (!programNextAllowedStep.includes('one capped validation pair')) failures.push('ProgramBench readiness recommendation must require exactly one capped validation pair after completion-control action validation')
    if (!programNextAllowedStep.includes('max-agent-runs=2')) failures.push('ProgramBench readiness recommendation must preserve max-agent-runs=2')
  } else if (latestProgramBench.run_id === 'programbench-sonnet-compile-repair-validation-1') {
    if (!programNextAllowedStep.includes('artifact contract')) failures.push('ProgramBench readiness recommendation must identify artifact contract as the current blocker')
  } else if (!programNextAllowedStep.includes('one monitored capped pair') && !programNextAllowedStep.includes('one capped validation pair') && !programNextAllowedStep.includes('max-agent-runs=2')) {
    failures.push('ProgramBench readiness recommendation must preserve capped validation scope')
  }
  const mechanismReadiness = programReadiness.evidence_summary?.mechanism_readiness
  if (mechanismReadiness?.agent_runlab_same_session_continuation !== true) failures.push('ProgramBench readiness must record Agent RunLab same-session continuation as ready')
  if (mechanismReadiness?.native_eval_timeout_guard !== true) failures.push('ProgramBench readiness must record native-eval timeout guard as ready')
  if (mechanismReadiness?.claude_inactivity_timeout_guard !== true) failures.push('ProgramBench readiness must record Claude Code inactivity timeout guard as ready')
  if (mechanismReadiness?.submission_contract_gate !== true) failures.push('ProgramBench readiness must record submission-contract gate artifacts as ready')
  if (mechanismReadiness?.entrypoint_completion_control !== true) failures.push('ProgramBench readiness must record entrypoint completion-control as ready')
  if (mechanismReadiness?.completion_control_result_fields !== true) failures.push('ProgramBench readiness must record completion-control result fields as ready')
  if (mechanismReadiness?.completion_control_action_check !== true) failures.push('ProgramBench readiness must record completion-control action check as ready')
  if (mechanismReadiness?.single_continuation_boundary !== true) failures.push('ProgramBench readiness must record single continuation boundary dry-run as ready')
  if (mechanismReadiness?.agent_runlab_outer_contract_repair_fallback !== true) failures.push('ProgramBench readiness must record Agent RunLab outer contract-repair fallback dry-run as ready')
  if (mechanismReadiness?.submission_skeleton_bootstrap !== true) failures.push('ProgramBench readiness must record shared submission skeleton bootstrap dry-run as ready')
  const readinessGateByName = new Map((programReadiness.gates ?? []).map((gate) => [gate.name, gate]))
  if (!['pass', 'fail'].includes(readinessGateByName.get('agent_runlab_minimum_artifact_contract')?.status)) failures.push('ProgramBench readiness must record Agent RunLab artifact-contract gate status for current evidence')
  if (readinessGateByName.get('claude_code_minimum_artifact_contract')?.status !== 'pass') failures.push('ProgramBench readiness must record passing Claude Code artifact-contract gate after bootstrap skeleton normalization')
  if (readinessGateByName.get('implementation_written_through_after_bootstrap')?.status !== 'fail') failures.push('ProgramBench readiness must record failing implementation write-through gate for scaffold baseline evidence')
  if (readinessGateByName.get('native_scores_are_informative_before_expansion')?.status !== 'fail') failures.push('ProgramBench readiness must record non-informative native-score gate for current evidence')
  const sameSessionPaidDiagnostic = programReadiness.evidence_summary?.same_session_paid_diagnostic
  if (sameSessionPaidDiagnostic?.status !== 'manually_aborted_diagnostic') failures.push(`ProgramBench same-session paid diagnostic must be recorded as manually_aborted_diagnostic, got ${sameSessionPaidDiagnostic?.status}`)
  if (sameSessionPaidDiagnostic?.agent_runlab?.contract_final_ok !== false) failures.push('ProgramBench same-session paid diagnostic must record Agent RunLab final contract failure')
  if (!sameSessionPaidDiagnostic?.agent_runlab?.contract_final_reason_codes?.includes('missing_compile_sh')) failures.push('ProgramBench same-session paid diagnostic must record missing_compile_sh')
  if (sameSessionPaidDiagnostic?.agent_runlab?.source_file_count !== 1) failures.push(`ProgramBench same-session paid diagnostic must record Agent RunLab source_file_count=1, got ${sameSessionPaidDiagnostic?.agent_runlab?.source_file_count}`)
  if (sameSessionPaidDiagnostic?.claude_code?.native_scored_by_runner !== false) failures.push('ProgramBench same-session paid diagnostic must record Claude Code as not native-scored by the runner')
  for (const requiredArtifact of ['compile.sh', 'seqtk.c']) {
    if (!(sameSessionPaidDiagnostic?.claude_code?.workspace_artifacts_present_at_abort ?? []).includes(requiredArtifact)) {
      failures.push(`ProgramBench same-session paid diagnostic must record Claude Code artifact present at abort: ${requiredArtifact}`)
    }
  }
  if (sameSessionDryRunManifest.dry_run !== true) failures.push('ProgramBench same-session continuation check must remain a dry-run artifact')
  if (sameSessionDryRunManifest.agent !== 'agent-runlab') failures.push(`ProgramBench same-session continuation check must target Agent RunLab, got ${sameSessionDryRunManifest.agent}`)
  if (sameSessionDryRunManifest.contract_repair?.mode !== 'same_session') failures.push(`ProgramBench Agent RunLab contract repair mode must be same_session, got ${sameSessionDryRunManifest.contract_repair?.mode}`)
  if (!sameSessionDryRunManifest.case_json) failures.push('ProgramBench same-session continuation manifest must include case_json')
  if (sameSessionDryRunManifest.contract_repair?.continuation_attempts !== 3) failures.push(`ProgramBench same-session continuation dry-run should record continuation_attempts=3, got ${sameSessionDryRunManifest.contract_repair?.continuation_attempts}`)
  if (progressGateDryRunManifest.dry_run !== true) failures.push('ProgramBench contract-progress gate check must remain a dry-run artifact')
  if (progressGateDryRunManifest.contract_repair?.mode !== 'same_session') failures.push(`ProgramBench contract-progress gate dry-run must keep Agent RunLab same-session mode, got ${progressGateDryRunManifest.contract_repair?.mode}`)
  if (progressGateDryRunManifest.contract_repair?.continuation_attempts !== 2) failures.push(`ProgramBench contract-progress gate dry-run should record continuation_attempts=2, got ${progressGateDryRunManifest.contract_repair?.continuation_attempts}`)
  if (interruptionGuardDryRunManifest.dry_run !== true) failures.push('ProgramBench interruption guard check must remain a dry-run artifact')
  if (interruptionGuardDryRunManifest.claude_inactivity_timeout_ms !== 120000) failures.push(`ProgramBench interruption guard dry-run must record claude_inactivity_timeout_ms=120000, got ${interruptionGuardDryRunManifest.claude_inactivity_timeout_ms}`)
  if (entrypointCompletionDryRunManifest.dry_run !== true) failures.push('ProgramBench entrypoint completion-control check must remain a dry-run artifact')
  if (entrypointCompletionDryRunManifest.contract_repair?.mode !== 'same_session') failures.push(`ProgramBench entrypoint completion-control check must keep same-session repair mode, got ${entrypointCompletionDryRunManifest.contract_repair?.mode}`)
  if (entrypointCompletionDryRunManifest.contract_repair?.continuation_attempts !== 2) failures.push(`ProgramBench entrypoint completion-control dry-run should record continuation_attempts=2, got ${entrypointCompletionDryRunManifest.contract_repair?.continuation_attempts}`)
  if (completionControlResultFieldsSummary.status !== 'dry_run') failures.push(`ProgramBench completion-control result-fields check must remain dry_run, got ${completionControlResultFieldsSummary.status}`)
  if (!completionControlResultFieldsRows.some((row) => Object.hasOwn(row, 'agent_runlab_completion_control') && Object.hasOwn(row, 'claude_code_completion_control'))) {
    failures.push('ProgramBench completion-control result-fields pairwise rows must expose completion-control classifications')
  }
  if (!completionControlResultFieldsRows.some((row) => Object.hasOwn(row, 'agent_runlab_completion_failure') && Object.hasOwn(row, 'claude_code_completion_failure'))) {
    failures.push('ProgramBench completion-control result-fields pairwise rows must expose completion-failure labels')
  }
  if (completionControlActionAgentManifest.dry_run !== true) failures.push('ProgramBench completion-control action check Agent RunLab manifest must remain dry-run')
  if (completionControlActionAgentManifest.contract_repair?.mode !== 'same_session') failures.push(`ProgramBench completion-control action check Agent RunLab mode must be same_session, got ${completionControlActionAgentManifest.contract_repair?.mode}`)
  if (completionControlActionAgentManifest.contract_repair?.continuation_attempts !== 3) failures.push(`ProgramBench completion-control action check Agent RunLab attempts must be 3, got ${completionControlActionAgentManifest.contract_repair?.continuation_attempts}`)
  if (completionControlActionClaudeManifest.dry_run !== true) failures.push('ProgramBench completion-control action check Claude Code manifest must remain dry-run')
  if (completionControlActionClaudeManifest.contract_repair?.mode !== 'separate_sdk_invocations') failures.push(`ProgramBench completion-control action check Claude Code mode must be separate_sdk_invocations, got ${completionControlActionClaudeManifest.contract_repair?.mode}`)
  if (completionControlActionClaudeManifest.contract_repair?.continuation_attempts !== 3) failures.push(`ProgramBench completion-control action check Claude Code attempts must be 3, got ${completionControlActionClaudeManifest.contract_repair?.continuation_attempts}`)
  if (singleContinuationBoundaryAgentManifest.dry_run !== true) failures.push('ProgramBench single-continuation-boundary Agent RunLab manifest must remain dry-run')
  if (singleContinuationBoundaryAgentManifest.contract_repair?.mode !== 'same_session_agent_runlab_prompt_runner') failures.push(`ProgramBench Agent RunLab outer runner must record same-session prompt-runner repair mode, got ${singleContinuationBoundaryAgentManifest.contract_repair?.mode}`)
  if (singleContinuationBoundaryClaudeManifest.dry_run !== true) failures.push('ProgramBench single-continuation-boundary Claude Code manifest must remain dry-run')
  if (singleContinuationBoundaryClaudeManifest.contract_repair?.mode !== 'bounded_claude_code_repair_invocations') failures.push(`ProgramBench Claude Code outer runner must record bounded SDK repair mode, got ${singleContinuationBoundaryClaudeManifest.contract_repair?.mode}`)
  if (outerContractRepairAgentManifest.dry_run !== true) failures.push('ProgramBench Agent RunLab outer contract-repair fallback manifest must remain dry-run')
  if (outerContractRepairAgentManifest.contract_repair?.mode !== 'bounded_agent_runlab_repair_invocations_after_prompt_runner') failures.push(`ProgramBench Agent RunLab fallback repair mode must be bounded_agent_runlab_repair_invocations_after_prompt_runner, got ${outerContractRepairAgentManifest.contract_repair?.mode}`)
  if (outerContractRepairAgentManifest.contract_repair?.continuation_attempts !== 2) failures.push(`ProgramBench Agent RunLab fallback repair attempts must be 2, got ${outerContractRepairAgentManifest.contract_repair?.continuation_attempts}`)
  if (outerContractRepairClaudeManifest.dry_run !== true) failures.push('ProgramBench Claude Code comparator fallback manifest must remain dry-run')
  if (outerContractRepairClaudeManifest.contract_repair?.mode !== 'bounded_claude_code_repair_invocations') failures.push(`ProgramBench Claude Code fallback comparator mode must be bounded_claude_code_repair_invocations, got ${outerContractRepairClaudeManifest.contract_repair?.mode}`)
  if (bootstrapSkeletonAgentManifest.dry_run !== true) failures.push('ProgramBench bootstrap skeleton Agent RunLab manifest must remain dry-run')
  if (bootstrapSkeletonAgentManifest.runner_bootstrap?.submission_skeleton !== true) failures.push('ProgramBench bootstrap skeleton Agent RunLab manifest must enable submission_skeleton')
  if (bootstrapSkeletonClaudeManifest.dry_run !== true) failures.push('ProgramBench bootstrap skeleton Claude Code manifest must remain dry-run')
  if (bootstrapSkeletonClaudeManifest.runner_bootstrap?.submission_skeleton !== true) failures.push('ProgramBench bootstrap skeleton Claude Code manifest must enable submission_skeleton')
  if (programFailureDiagnosis.status !== 'diagnosed_not_ready_for_5case_pilot') failures.push(`ProgramBench failure diagnosis must keep not-ready status, got ${programFailureDiagnosis.status}`)
  if (programFailureDiagnosis.latest_run?.run_id !== latestProgramBench.run_id) failures.push(`ProgramBench failure diagnosis run_id must match latest run ${latestProgramBench.run_id}, got ${programFailureDiagnosis.latest_run?.run_id}`)
  if (programFailureDiagnosis.agents?.['agent-runlab']?.contract_ok !== true) failures.push('ProgramBench failure diagnosis must record Agent RunLab contract_ok=true after bootstrap skeleton normalization')
  if (programFailureDiagnosis.agents?.['claude-code']?.contract_ok !== true) failures.push('ProgramBench failure diagnosis must record Claude Code contract_ok=true after bootstrap skeleton normalization')
  if (!String(programFailureDiagnosis.next_gate ?? '').includes('Do not expand to the 5-case pilot yet')) failures.push('ProgramBench failure diagnosis must forbid 5-case expansion')
  if (programFailureDiagnosis.same_session_paid_diagnostic?.status !== 'manually_aborted_diagnostic') failures.push('ProgramBench failure diagnosis must include the manually aborted same-session paid diagnostic')
  if (!(programFailureDiagnosis.diagnosis ?? []).some((item) => item.category === 'implementation_write_through_failure')) failures.push('ProgramBench failure diagnosis must classify scaffold baseline as implementation_write_through_failure')
  if (!(programFailureDiagnosis.diagnosis ?? []).some((item) => item.category === 'same_session_continuation_partial_improvement')) failures.push('ProgramBench failure diagnosis must classify the same-session continuation partial improvement')
  if (!(programFailureDiagnosis.diagnosis ?? []).some((item) => item.category === 'interrupted_comparator_evidence')) failures.push('ProgramBench failure diagnosis must classify interrupted Claude Code comparator evidence')
  if (latestProgramBench.run_id === 'programbench-sonnet-two-agent-continuation-validation-1') {
    if (!String(programFailureDiagnosis.next_gate ?? '').includes('compile_failed') && !String(programFailureDiagnosis.next_gate ?? '').includes('compile')) failures.push('ProgramBench failure diagnosis next gate must mention compile failure after latest validation pair')
  } else if (latestProgramBench.run_id === 'programbench-sonnet-entrypoint-validation-1') {
    if (!String(programFailureDiagnosis.next_gate ?? '').includes('one capped validation pair')) failures.push('ProgramBench failure diagnosis must require one capped validation pair after completion-control action validation')
    if (!String(programFailureDiagnosis.next_gate ?? '').includes('max-agent-runs=2')) failures.push('ProgramBench failure diagnosis must preserve max-agent-runs=2 after completion-control action validation')
  } else if (latestProgramBench.run_id === 'programbench-sonnet-compile-repair-validation-1') {
    if (!String(programFailureDiagnosis.next_gate ?? '').includes('artifact contract')) failures.push('ProgramBench failure diagnosis next gate must identify artifact contract as current blocker')
  } else if (!String(programFailureDiagnosis.next_gate ?? '').includes('capped')) failures.push('ProgramBench failure diagnosis must preserve capped validation scope')
  if (programFailureDiagnosis.entrypoint_diagnosis?.status !== 'entrypoint_completion_diagnosed') failures.push('ProgramBench failure diagnosis must include latest entrypoint diagnosis summary')
  if (programCompletionControl.status !== 'completion_control_blocking') failures.push(`ProgramBench completion-control diagnosis must be blocking, got ${programCompletionControl.status}`)
  if (programCompletionControl.latest_run?.run_id !== latestProgramBench.run_id) failures.push(`ProgramBench completion-control run_id must match latest run ${latestProgramBench.run_id}, got ${programCompletionControl.latest_run?.run_id}`)
  if (latestProgramBench.run_id === 'programbench-sonnet-entrypoint-validation-1') {
    if (programCompletionControl.agents?.['agent-runlab']?.completion_control?.classification !== 'promise_without_artifacts') failures.push('ProgramBench completion-control diagnosis must classify latest Agent RunLab repair as promise_without_artifacts')
    if (programCompletionControl.agents?.['agent-runlab']?.completion_control?.action !== 'continue_same_session') failures.push(`ProgramBench completion-control diagnosis must require Agent RunLab same-session continuation, got ${programCompletionControl.agents?.['agent-runlab']?.completion_control?.action}`)
    if (!(programCompletionControl.agents?.['agent-runlab']?.completion_control?.missing_required_artifacts ?? []).includes('source_files')) failures.push('ProgramBench completion-control diagnosis must record missing Agent RunLab source_files')
    if (!(programCompletionControl.agents?.['agent-runlab']?.completion_control?.missing_required_artifacts ?? []).includes('compile.sh')) failures.push('ProgramBench completion-control diagnosis must record missing Agent RunLab compile.sh')
    if (programCompletionControl.agents?.['claude-code']?.completion_control?.classification === 'contract_satisfied') failures.push('ProgramBench completion-control diagnosis must not mark latest Claude Code contract as satisfied')
  }
  if (programEntrypointDiagnosis.status !== 'entrypoint_completion_diagnosed') failures.push(`ProgramBench entrypoint diagnosis must be entrypoint_completion_diagnosed, got ${programEntrypointDiagnosis.status}`)
  const programEntrypointAgentSources = programEntrypointDiagnosis.agents?.['agent-runlab']?.source_files ?? []
  const programEntrypointClaudeSources = programEntrypointDiagnosis.agents?.['claude-code']?.source_files ?? []
  const programEntrypointAgents = programEntrypointDiagnosis.agents ?? {}
  for (const agentName of ['agent-runlab', 'claude-code']) {
    const info = programEntrypointAgents[agentName]
    if (!info) failures.push(`ProgramBench entrypoint diagnosis must include ${agentName}`)
    const sourceCount = Number(info?.source_file_count ?? 0)
    const sourceFiles = info?.source_files ?? []
    if (sourceCount !== sourceFiles.length) failures.push(`ProgramBench entrypoint diagnosis ${agentName} source_file_count must match source_files length`)
    const expectedApplicable = sourceFiles.length > 0 && info?.compile_sh_exists !== true
    if (info?.entrypoint_completion_applicable !== expectedApplicable) failures.push(`ProgramBench entrypoint diagnosis ${agentName} entrypoint applicability mismatch`)
  }
  if (programEntrypointAgentSources.length === 0 && !String(programEntrypointDiagnosis.conclusion ?? '').includes('lack')) failures.push('ProgramBench entrypoint diagnosis must explain missing Agent RunLab source files when none are recorded')
  if (programEntrypointClaudeSources.length === 0 && !String(programEntrypointDiagnosis.conclusion ?? '').includes('lack')) failures.push('ProgramBench entrypoint diagnosis must explain missing Claude Code source files when none are recorded')

  const programRows = rows.filter((row) => row.benchmark === 'program-bench')
  const programRunRows = programRows.filter((row) => row.run_id === latestProgramBench.run_id)
  const expectedProgramRows = latestProgramBench.selected_cases === 1 ? 1 : 5
  const expectedSkippedProgramRows = expectedProgramRows - 1
  if (programRunRows.length !== expectedProgramRows) failures.push(`expected ${expectedProgramRows} ProgramBench row(s) from current capped run, got ${programRunRows.length}`)
  const comparableProgramRows = programRunRows.filter((row) => row.winner !== 'not_comparable')
  if (comparableProgramRows.length !== 1) failures.push(`expected one comparable ProgramBench row, got ${comparableProgramRows.length}`)
  const skippedProgramRows = programRunRows.filter((row) => row.winner === 'not_comparable')
  if (skippedProgramRows.length !== expectedSkippedProgramRows) failures.push(`expected ${expectedSkippedProgramRows} skipped ProgramBench row(s) for current capped run, got ${skippedProgramRows.length}`)
  for (const row of skippedProgramRows) {
    if (!String(row.agent_artifact).includes('skipped.txt')) failures.push(`ProgramBench skipped agent artifact must include skipped.txt for ${row.instance_id}`)
    if (!String(row.claude_artifact).includes('skipped.txt')) failures.push(`ProgramBench skipped Claude artifact must include skipped.txt for ${row.instance_id}`)
  }
  const programRow = comparableProgramRows[0]
  if (programRow) {
    if (programRow.run_id !== latestProgramBench.run_id) failures.push(`ProgramBench row run_id must match latest run ${latestProgramBench.run_id}, got ${programRow.run_id}`)
    if (programRow.evidence_level !== 'official_calibration') failures.push('ProgramBench row must remain official_calibration')
    if (programRow.failure_category !== 'implementation_write_through_failure') failures.push(`ProgramBench failure category must be implementation_write_through_failure for scaffold baseline evidence, got ${programRow.failure_category}`)
    if (programRow.winner !== 'tie') failures.push(`ProgramBench comparable row winner must be tie for latest Docker MCP bash pilot, got ${programRow.winner}`)
    if (programRow.agent_runlab_score !== 0.08158508158508158) failures.push(`ProgramBench Agent RunLab score must be scaffold baseline 0.08158508158508158, got ${programRow.agent_runlab_score}`)
    if (programRow.claude_code_score !== 0.08158508158508158) failures.push(`ProgramBench Claude Code score must be scaffold baseline 0.08158508158508158, got ${programRow.claude_code_score}`)
    if (!String(programRow.agent_artifact).includes('submission-contract.json')) failures.push('ProgramBench agent artifact must include submission-contract.json')
    if (!String(programRow.claude_artifact).includes('submission-contract.json')) failures.push('ProgramBench Claude artifact must include submission-contract.json')
    if (!String(programRow.agent_artifact).includes('submission-contract-gate.json')) failures.push('ProgramBench agent artifact must include submission-contract-gate.json')
    if (!String(programRow.claude_artifact).includes('submission-contract-gate.json')) failures.push('ProgramBench Claude artifact must include submission-contract-gate.json')
    if (!String(programRow.agent_artifact).includes('submission-contract.initial.json')) failures.push('ProgramBench agent artifact must include submission-contract.initial.json')
    if (!String(programRow.claude_artifact).includes('submission-contract.initial.json')) failures.push('ProgramBench Claude artifact must include submission-contract.initial.json')
  }

  const jobJudgePreflight = await readJson('artifacts/job-bench/judge-preflight/preflight-summary.json')
  const jobSmokeDiagnosis = await readJson('diagnostics/jobbench/latest-submitted-smoke-diagnosis.json')
  if (jobJudgePreflight.status !== 'blocked_missing_judge_key' && jobJudgePreflight.status !== 'ready_for_one_case_judge_smoke') {
    failures.push(`JobBench judge preflight has unexpected status ${jobJudgePreflight.status}`)
  }
  if (jobJudgePreflight.dataset?.rubric_count !== 9) failures.push(`JobBench judge preflight rubric_count must be 9, got ${jobJudgePreflight.dataset?.rubric_count}`)
  if ((jobJudgePreflight.dataset?.model_outputs ?? []).length !== 2) failures.push('JobBench judge preflight must include two model output directories')
  if (!jobJudgePreflight.invalid_attempts?.some((attempt) => String(attempt.first_invalid_reason).includes('No judge API key'))) {
    failures.push('JobBench judge preflight must preserve the no-API-key invalid attempt')
  }
  for (const attempt of jobJudgePreflight.invalid_attempts ?? []) {
    if (attempt.validator_version !== 2) failures.push(`JobBench invalid attempt must be validated by validator_version=2, got ${attempt.validator_version}`)
    if (attempt.valid !== false) failures.push(`JobBench invalid attempt must remain invalid, got valid=${attempt.valid}`)
  }
  if (jobSmokeDiagnosis.status !== 'diagnosed_submitted_unscored_not_ready_for_scored_subset') failures.push(`JobBench smoke diagnosis has unexpected status ${jobSmokeDiagnosis.status}`)
  if (jobSmokeDiagnosis.latest_run?.run_id !== 'jobbench-easy-1case-unscored-smoke-1') failures.push(`JobBench smoke diagnosis run_id must point at submitted smoke, got ${jobSmokeDiagnosis.latest_run?.run_id}`)
  if (jobSmokeDiagnosis.pairwise?.winner !== 'not_comparable') failures.push(`JobBench smoke diagnosis pairwise winner must remain not_comparable, got ${jobSmokeDiagnosis.pairwise?.winner}`)
  if (jobSmokeDiagnosis.pairwise?.agent_runlab_score !== null || jobSmokeDiagnosis.pairwise?.claude_code_score !== null) failures.push('JobBench smoke diagnosis scores must stay null until valid judge results exist')
  if (jobSmokeDiagnosis.agents?.['agent-runlab']?.deliverable_count !== 3) failures.push(`JobBench smoke diagnosis must record three Agent RunLab deliverables, got ${jobSmokeDiagnosis.agents?.['agent-runlab']?.deliverable_count}`)
  if (jobSmokeDiagnosis.agents?.['claude-code']?.deliverable_count !== 2) failures.push(`JobBench smoke diagnosis must record two Claude Code deliverables, got ${jobSmokeDiagnosis.agents?.['claude-code']?.deliverable_count}`)
  if (jobSmokeDiagnosis.judge_preflight?.valid_score_present !== false) failures.push('JobBench smoke diagnosis must record valid_score_present=false')
  if (jobSmokeDiagnosis.judge_preflight?.invalid_attempt_count !== (jobJudgePreflight.invalid_attempts ?? []).length) failures.push('JobBench smoke diagnosis invalid attempt count must match judge preflight')
  if (!String(jobSmokeDiagnosis.next_gate ?? '').includes('one official judged smoke')) failures.push('JobBench smoke diagnosis next gate must require one official judged smoke')
  if (!(jobSmokeDiagnosis.diagnosis ?? []).some((item) => item.category === 'invalid_infrastructure_attempts')) failures.push('JobBench smoke diagnosis must explicitly classify invalid judge attempts as non-score evidence')

  const narrativeExpectations = [
    ['django__django-11815', ['__name__', '__qualname__', 'agent-runlab']],
    ['astropy__astropy-14365', ['re.IGNORECASE', 'tie_unresolved']],
    ['browsecomp-000', ['UFC 219: Cyborg vs. Holm', 'tie_unresolved']],
    ['lh3__seqtk.94e7070', ['implementation_write_through_failure', '0.08158508158508158']],
    ['easy:bookkeeping_accounting_and_auditing_clerks__task1', ['submitted_unscored', 'pending_judge']],
  ]
  for (const [caseId, requiredTexts] of narrativeExpectations) {
    for (const [fileName, text] of [
      ['legacy-runner-analysis.md', legacy-runnerAnalysis],
      ['evidence-notes.md', evidenceNotes],
    ]) {
      if (!text.includes(caseId)) failures.push(`${fileName} must include case-level narrative for ${caseId}`)
      for (const requiredText of requiredTexts) {
        if (!text.includes(requiredText)) failures.push(`${fileName} narrative for ${caseId} must include ${requiredText}`)
      }
    }
  }

  for (const [fileName, text] of [
    ['legacy-runner-analysis.md', legacy-runnerAnalysis],
    ['manifest.md', manifest],
    ['next-actions.md', nextActions],
    ['evidence-notes.md', evidenceNotes],
  ]) {
    for (const requiredText of [
      'browsecomp-000-goal-capped-pair-1',
      'programbench-sonnet-bootstrap-skeleton-validation-1',
      'jobbench-easy-1case-unscored-smoke-1',
      'official_subset',
      'scored_smoke',
      'official_calibration',
      'submitted_unscored',
    ]) {
      if (!text.includes(requiredText)) failures.push(`${fileName} must include current evidence marker ${requiredText}`)
    }
  }

  for (const required of [
    'results/benchmark-summary.csv',
    'results/cross-benchmark-pairwise.csv',
    'results/failure-taxonomy.json',
    'results/artifact-completeness.json',
    'results/artifact-completeness.md',
    'results/objective-coverage.json',
    'results/objective-coverage.md',
    'planning/browsecomp/browsecomp-pilot-case-preflight.json',
    'planning/browsecomp/browsecomp-pilot-case-preflight.csv',
    'planning/browsecomp/browsecomp-pilot-case-preflight.md',
    'planning/browsecomp/browsecomp-pilot-selected-cases.jsonl',
    'planning/browsecomp/browsecomp-target-selected-cases.jsonl',
    'planning/browsecomp/browsecomp-pilot-readiness.json',
    'planning/browsecomp/browsecomp-pilot-readiness.md',
    'diagnostics/browsecomp/latest-partial-run-diagnosis.json',
    'diagnostics/browsecomp/latest-partial-run-diagnosis.md',
    'artifacts/job-bench/judge-preflight/preflight-summary.json',
    'artifacts/job-bench/judge-preflight/README.md',
    'diagnostics/jobbench/latest-submitted-smoke-diagnosis.json',
    'diagnostics/jobbench/latest-submitted-smoke-diagnosis.md',
    'diagnostics/swe-marathon/no-run-calibration/preflight-summary.json',
    'diagnostics/swe-marathon/no-run-calibration/README.md',
    'diagnostics/programbench/pilot-readiness.json',
    'diagnostics/programbench/pilot-readiness.md',
    'diagnostics/programbench/latest-failure-diagnosis.json',
    'diagnostics/programbench/latest-failure-diagnosis.md',
    'diagnostics/programbench/latest-completion-control.json',
    'diagnostics/programbench/latest-completion-control.md',
    'artifacts/program-bench/programbench-dry-run-same-session-continuation-check-2/agent-runlab/lh3__seqtk.94e7070/run-manifest.json',
    'artifacts/program-bench/programbench-dry-run-contract-progress-gate-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json',
    'artifacts/program-bench/programbench-dry-run-interruption-guard-check/claude-code/lh3__seqtk.94e7070/run-manifest.json',
    'artifacts/program-bench/programbench-dry-run-completion-control-result-fields-check/score-summary.json',
    'artifacts/program-bench/programbench-dry-run-completion-control-result-fields-check/pairwise-comparison.jsonl',
    'artifacts/program-bench/programbench-dry-run-completion-control-action-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json',
    'artifacts/program-bench/programbench-dry-run-completion-control-action-check/claude-code/lh3__seqtk.94e7070/run-manifest.json',
    'artifacts/program-bench/programbench-dry-run-single-continuation-boundary-check/agent-runlab/lh3__seqtk.94e7070/run-manifest.json',
    'artifacts/program-bench/programbench-dry-run-single-continuation-boundary-check/claude-code/lh3__seqtk.94e7070/run-manifest.json',
    'legacy-runner-analysis.md',
    'evidence-notes.md',
    'benchmark-source-audit.md',
  ]) {
    if (!existsSync(path.join(legacy-runner, required))) failures.push(`missing required legacy-runner file: ${required}`)
  }

  const reportDirByBenchmark = {
    swebench: 'swebench',
    browsecomp: 'browsecomp',
    'swe-marathon': 'swe-marathon',
    'program-bench': 'programbench',
    'job-bench': 'jobbench',
  }

  for (const benchmark of ['swebench', 'browsecomp', 'swe-marathon', 'program-bench', 'job-bench']) {
    for (const required of ['runbook.md', 'command-log.md', 'failure-analysis.md', 'pairwise-comparison.csv', 'pairwise-comparison.jsonl']) {
      const relative = `reports/${reportDirByBenchmark[benchmark]}/${required}`
      if (!existsSync(path.join(legacy-runner, relative))) failures.push(`missing per-benchmark report file: ${relative}`)
    }
  }

  for (const benchmark of ['swebench', 'browsecomp', 'swe-marathon', 'program-bench', 'job-bench']) {
    const relative = `reports/${reportDirByBenchmark[benchmark]}/benchmark-summary.json`
    if (!existsSync(path.join(legacy-runner, relative))) failures.push(`missing per-benchmark summary: ${relative}`)
  }

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('benchmark legacy-runner invariants ok')
}

function expectBenchmark(byBenchmark, failures, benchmark, evidenceLevel, status, executedCases, scoredCases) {
  const item = byBenchmark.get(benchmark)
  if (!item) {
    failures.push(`missing benchmark summary row: ${benchmark}`)
    return
  }
  if (item.evidence_level !== evidenceLevel) failures.push(`${benchmark} evidence_level expected ${evidenceLevel}, got ${item.evidence_level}`)
  if (item.status !== status) failures.push(`${benchmark} status expected ${status}, got ${item.status}`)
  if (item.executed_cases !== executedCases) failures.push(`${benchmark} executed_cases expected ${executedCases}, got ${item.executed_cases}`)
  if (item.scored_cases !== scoredCases) failures.push(`${benchmark} scored_cases expected ${scoredCases}, got ${item.scored_cases}`)
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(legacy-runner, relativePath), 'utf8'))
}

async function readJsonl(relativePath) {
  const text = await readFile(path.join(legacy-runner, relativePath), 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function readText(relativePath) {
  return readFile(path.join(legacy-runner, relativePath), 'utf8')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

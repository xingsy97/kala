#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const portfolioRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison');
const resultsRoot = path.join(portfolioRoot, 'results');

const REPORT_DIR_BY_ARTIFACT_DIR = {
  browsecomp: 'browsecomp',
  'program-bench': 'programbench',
  'job-bench': 'jobbench',
  'swe-marathon': 'swe-marathon',
  swebench: 'swebench',
};

function rel(...parts) {
  return path.join(...parts).replaceAll(path.sep, '/');
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

async function readJsonl(relativePath) {
  const text = await readFile(path.join(root, relativePath), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function pathExists(relativePath) {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

function csvEscape(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows, fields) {
  return [fields.join(','), ...rows.map((row) => fields.map((field) => csvEscape(row[field])).join(','))].join('\n') + '\n';
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWinner(winner) {
  if (winner === 'agent') return 'agent-runlab';
  if (winner === 'claude') return 'claude-code';
  return winner || 'unknown';
}

function winnerFromScores(agentScore, claudeScore, agentStatus, claudeStatus) {
  if (agentScore > claudeScore) return 'agent-runlab';
  if (claudeScore > agentScore) return 'claude-code';
  if (agentStatus === 'resolved' && claudeStatus === 'resolved') return 'tie_resolved';
  if (agentStatus === 'unresolved' && claudeStatus === 'unresolved') return 'tie_unresolved';
  return 'tie';
}

function formatReasonCodes(codes) {
  const values = Array.isArray(codes) ? codes.filter(Boolean) : [];
  return values.length ? values.join('+') : 'unknown_contract_failure';
}

function programBenchNextGate(programLatest, programFailureDiagnosis) {
  const agent = programFailureDiagnosis?.agents?.['agent-runlab'] || {};
  const claude = programFailureDiagnosis?.agents?.['claude-code'] || {};
  const agentReasons = formatReasonCodes(agent.contract_reason_codes);
  const claudeReasons = formatReasonCodes(claude.contract_reason_codes);
  const implementationQuality = Array.isArray(programFailureDiagnosis?.implementation_quality) ? programFailureDiagnosis.implementation_quality : [];
  if (implementationQuality.some((item) => item?.category === 'implementation_write_through_failure' && item?.blocking === true)) {
    return 'Do not expand ProgramBench by raising --max-agent-runs yet. The latest capped comparable pair passed artifact and compile probes only through runner bootstrap scaffolding, then stopped with placeholder implementation still present. The implementation write-through guard is implemented and no-model validated; next paid step, if cost is accepted, is exactly one monitored capped pair with that guard active, max-agent-runs=2, stop-after-errors=1, and stop-after-contract-failures=2.';
  }
  if (agent.contract_ok !== true || claude.contract_ok !== true) {
    return `Do not expand ProgramBench by raising --max-agent-runs yet. The latest capped comparable pair still failed the minimum artifact contract before compile repair could apply: Agent RunLab contract_ok=${agent.contract_ok === true}, reason_codes=${agentReasons}; Claude Code contract_ok=${claude.contract_ok === true}, reason_codes=${claudeReasons}. Next work is artifact-contract completion control under the same max-agent-runs=2 capped validation shape, not broader subset expansion.`;
  }
  const agentPrimaryError = agent.native_eval_summary?.primary_error_code || null;
  const claudePrimaryError = claude.native_eval_summary?.primary_error_code || null;
  if (agentPrimaryError === 'compile_failed' || claudePrimaryError === 'compile_failed') {
    const agentRepair = agent.compile_repair_gate?.action || 'missing';
    const claudeRepair = claude.compile_repair_gate?.action || 'missing';
    const repairReady = agentRepair === 'continue_compile_repair' || claudeRepair === 'continue_compile_repair';
    return repairReady
      ? `Do not expand ProgramBench by raising --max-agent-runs yet. The latest capped comparable pair reached native scoring and compile-repair gate evidence exists: Agent RunLab contract_ok=${agent.contract_ok === true}, primary_error=${agentPrimaryError || 'none'}, repair_action=${agentRepair}; Claude Code contract_ok=${claude.contract_ok === true}, primary_error=${claudePrimaryError || 'none'}, repair_action=${claudeRepair}. Next paid step is exactly one monitored capped pair with bounded compile repair enabled.`
      : `Do not expand ProgramBench by raising --max-agent-runs yet. The latest capped comparable pair reached native scoring, but compile_failed remains blocking: Agent RunLab contract_ok=${agent.contract_ok === true}, primary_error=${agentPrimaryError || 'none'}; Claude Code contract_ok=${claude.contract_ok === true}, primary_error=${claudePrimaryError || 'none'}. Add/validate a compile probe and bounded compile-repair path before another paid expansion.`;
  }
  return `Do not expand ProgramBench by raising --max-agent-runs yet. The latest capped comparable pair still failed the minimum artifact contract: Agent RunLab reason_codes=${agentReasons}; Claude Code reason_codes=${claudeReasons}; both scored 0.0. Completion-control actions and the corrected two-agent bounded contract-continuation policy are now no-model validated; next paid step, if cost is accepted, is exactly one capped validation pair with max-agent-runs=2, stop-after-errors=1, stop-after-contract-failures=2, claude-inactivity-timeout-ms=120000, and contract-continuation-attempts=2 enabled.`;
}

function browseCompNextGate(readiness, partialDiagnosis) {
  if (readiness?.status === 'not_ready_for_next_pair') {
    return readiness.next_allowed_step || 'Fix failing no-paid readiness checks before any BrowseComp spending.';
  }
  const nextCase = Array.isArray(readiness?.recommended_case_ids) ? readiness.recommended_case_ids[0] : undefined;
  const nextPair = nextCase
    ? `The next mechanical fresh case is ${nextCase}; run exactly one capped pair with --max-agent-runs 2, --stop-after-turn-limits 1, and --stop-after-errors 1 before expanding.`
    : readiness?.next_allowed_step;
  const latest = partialDiagnosis?.latest_partial_run;
  const runId = typeof latest?.run_id === 'string' ? latest.run_id : '';
  const stopReason = typeof latest?.stop_reason === 'string' ? latest.stop_reason : '';
  const agent = partialDiagnosis?.agent_runlab || {};
  if (runId && stopReason === 'stop_after_turn_limits:1' && agent.turn_limit_hit === true) {
    return `Latest diagnostic ${runId} hit the Agent RunLab turn-limit gate and is not comparable. Keep it diagnostic only. ${nextPair || 'Pause blind BrowseComp spending until the next fresh-case plan is refreshed.'}`;
  }
  return nextPair || 'Run the next fresh BrowseComp pair with strict stop gates; do not let diagnostics replace headline rows.';
}

function classifyEvidence({ benchmark, runStatus, scorer, official, row }) {
  if (benchmark === 'swebench') return 'official_subset';
  if (benchmark === 'browsecomp' && runStatus === 'completed' && row?.winner !== 'not_comparable') return 'scored_smoke';
  if (
    benchmark === 'program-bench' &&
    official &&
    scorer === 'programbench.eval+score_instance' &&
    row?.winner !== 'not_comparable' &&
    row?.agent_runlab_status === 'scored' &&
    row?.claude_code_status === 'scored'
  ) {
    return 'official_calibration';
  }
  if (benchmark === 'job-bench' && runStatus === 'submitted_unscored') return 'submitted_unscored';
  if (scorer?.includes('not_run') || row?.winner === 'not_comparable') return 'not_scored';
  return 'unknown';
}

function summarizeRows(rows) {
  const comparable = rows.filter((row) => !['not_comparable', 'not_scored'].includes(row.winner));
  const scored = comparable.filter((row) => row.agent_runlab_score !== null && row.claude_code_score !== null);
  return {
    rows: rows.length,
    comparable_rows: comparable.length,
    scored_rows: scored.length,
    both_passed: rows.filter((row) => ['tie_resolved', 'tie_correct'].includes(row.winner)).length,
    agent_only: rows.filter((row) => row.winner === 'agent-runlab').length,
    claude_only: rows.filter((row) => row.winner === 'claude-code').length,
    neither: rows.filter((row) => ['tie_unresolved', 'tie_failed', 'tie'].includes(row.winner)).length,
    not_comparable: rows.filter((row) => row.winner === 'not_comparable').length,
    agent_avg_score: scored.length ? scored.reduce((sum, row) => sum + row.agent_runlab_score, 0) / scored.length : null,
    claude_avg_score: scored.length ? scored.reduce((sum, row) => sum + row.claude_code_score, 0) / scored.length : null,
  };
}

function inferSwebenchFailureCategory(row) {
  if (row.agent_runlab_resolved && row.claude_code_resolved) return '';
  if (row.agent_runlab_status === 'empty_patch' || row.claude_code_status === 'empty_patch') return 'incomplete_execution';
  if (row.agent_inference_status === 'failed' || row.claude_inference_status === 'failed') return 'incomplete_execution';
  if (!row.agent_runlab_resolved || !row.claude_code_resolved) return 'verification_gap';
  return '';
}

async function loadSwebenchRows() {
  const rows = await readJsonl('experiments/evals/2026-07-17-swebench-agent-vs-claude/model-controlled-comparison.jsonl');
  return rows.map((row) => ({
    benchmark: 'swebench',
    evidence_level: 'official_subset',
    run_id: `${row.agent_runlab_run_id}__vs__${row.claude_code_run_id}`,
    instance_id: row.instance_id,
    task_type: row.repo,
    model: row.model,
    scorer: 'official-swebench-harness',
    official: true,
    agent_runlab_status: row.agent_runlab_status,
    claude_code_status: row.claude_code_status,
    agent_runlab_score: row.agent_runlab_resolved ? 1 : 0,
    claude_code_score: row.claude_code_resolved ? 1 : 0,
    winner: normalizeWinner(row.winner),
    agent_artifact: row.agent_patch,
    claude_artifact: row.claude_patch,
    grader_report: `agent=${row.agent_harness_report}; claude=${row.claude_harness_report}`,
    failure_category: inferSwebenchFailureCategory(row),
    notes: 'Imported from existing SWE-bench model-controlled comparison.',
  }));
}

async function loadArtifactBenchmarkRows(benchmark, artifactDir) {
  const reportDir = REPORT_DIR_BY_ARTIFACT_DIR[artifactDir] || artifactDir;
  const summaryPath = `experiments/evals/2026-07-agent-benchmark-comparison/reports/${reportDir}/latest-run-summary.json`;
  const summary = await readJson(summaryPath);
  let rows;
  const runScopedPairwisePath = `experiments/evals/2026-07-agent-benchmark-comparison/${summary.run_root}/pairwise-comparison.jsonl`;
  const topLevelPairwisePath = `experiments/evals/2026-07-agent-benchmark-comparison/reports/${reportDir}/pairwise-comparison.jsonl`;
  if (await pathExists(runScopedPairwisePath)) {
    rows = await readJsonl(runScopedPairwisePath);
  } else if (benchmark === 'browsecomp') {
    rows = await loadBrowseCompRowsFromLatestRun(summary);
  } else {
    rows = await readJsonl(topLevelPairwisePath);
  }
  const programFailureDiagnosis = benchmark === 'program-bench'
    ? await readOptionalJson('experiments/evals/2026-07-agent-benchmark-comparison/diagnostics/programbench/latest-failure-diagnosis.json')
    : null;
  return rows.map((row) => {
    const official = Boolean(summary.official) || benchmark === 'program-bench' || benchmark === 'browsecomp';
    const evidenceLevel = classifyEvidence({
      benchmark,
      runStatus: summary.status,
      scorer: summary.scorer,
      official,
      row,
    });
    return {
      benchmark,
      evidence_level: evidenceLevel,
      run_id: summary.run_id || '',
      instance_id: row.instance_id,
      task_type: row.task_type || row.split || '',
      model: row.model || summary.model || '',
      scorer: summary.scorer || row.scorer || '',
      official,
      agent_runlab_status: row.agent_runlab_status || '',
      claude_code_status: row.claude_code_status || '',
      agent_runlab_score: evidenceLevel === 'submitted_unscored' ? null : numberOrNull(row.agent_runlab_score),
      claude_code_score: evidenceLevel === 'submitted_unscored' ? null : numberOrNull(row.claude_code_score),
      winner: normalizeWinner(row.winner),
      agent_artifact: row.agent_artifact || '',
      claude_artifact: row.claude_artifact || '',
      grader_report: row.grader_report || '',
      failure_category: row.failure_category || inferredProgramBenchFailureCategory(benchmark, row, programFailureDiagnosis),
      notes: row.notes || '',
    };
  });
}

function inferredProgramBenchFailureCategory(benchmark, row, diagnosis) {
  if (benchmark !== 'program-bench' || row?.winner === 'not_comparable') return '';
  const categories = new Set((diagnosis?.diagnosis ?? []).map((item) => item.category).filter(Boolean));
  if (categories.has('artifact_contract_failure')) return 'artifact_contract_failure';
  if (categories.has('compile_failure_after_artifact_contract')) return 'compile_failure_after_artifact_contract';
  if (categories.has('implementation_write_through_failure')) return 'implementation_write_through_failure';
  return '';
}

async function readOptionalJson(relativePath) {
  try {
    return await readJson(relativePath);
  } catch {
    return null;
  }
}

async function loadBrowseCompRowsFromLatestRun(summary) {
  const runRoot = `experiments/evals/2026-07-agent-benchmark-comparison/${summary.run_root}`;
  const agentDir = `${runRoot}/agent-runlab`;
  const caseIds = (await readdir(path.join(root, agentDir))).sort();
  const rows = [];
  for (const instanceId of caseIds) {
    const agentResultPath = `${summary.run_root}/agent-runlab/${instanceId}/result.json`;
    const claudeResultPath = `${summary.run_root}/claude-code/${instanceId}/result.json`;
    const agentResult = await readJson(`experiments/evals/2026-07-agent-benchmark-comparison/${agentResultPath}`);
    const claudeResult = await readJson(`experiments/evals/2026-07-agent-benchmark-comparison/${claudeResultPath}`);
    const agentScore = numberOrNull(agentResult.score) ?? 0;
    const claudeScore = numberOrNull(claudeResult.score) ?? 0;
    rows.push({
      benchmark: 'browsecomp',
      instance_id: instanceId,
      task_type: 'web_research_exact_answer',
      model: agentResult.model || claudeResult.model || summary.model,
      agent_runlab_status: agentResult.status,
      claude_code_status: claudeResult.status,
      agent_runlab_score: String(agentScore),
      claude_code_score: String(claudeScore),
      winner: winnerFromScores(agentScore, claudeScore, agentResult.status, claudeResult.status),
      agent_artifact: agentResult.artifact_refs?.join(';') || '',
      claude_artifact: claudeResult.artifact_refs?.join(';') || '',
      grader_report: `${agentResultPath};${claudeResultPath}`,
      failure_category: '',
      notes: 'Reconstructed from latest BrowseComp run result.json files because this older completed run did not emit run-scoped pairwise-comparison.jsonl.',
    });
  }
  return rows;
}

async function buildBenchmarkSummary(allRows) {
  const sweSummary = await readJson('experiments/evals/2026-07-17-swebench-agent-vs-claude/model-controlled-run-summary.json');
  const browseSelection = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/reports/browsecomp/benchmark-summary.json');
  const browseLatest = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/reports/browsecomp/latest-run-summary.json');
  const browseReadiness = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/planning/browsecomp/browsecomp-pilot-readiness.json');
  const browsePartialDiagnosis = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/diagnostics/browsecomp/latest-partial-run-diagnosis.json');
  const sweMarathonSelection = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/reports/swe-marathon/benchmark-summary.json');
  const sweMarathonSourcePreflight = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/diagnostics/swe-marathon/source-preflight.json');
  const sweMarathonNoRun = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/diagnostics/swe-marathon/no-run-calibration/preflight-summary.json');
  const programSelection = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/reports/programbench/benchmark-summary.json');
  const programLatest = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/reports/programbench/latest-run-summary.json');
  const programFailureDiagnosis = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/diagnostics/programbench/latest-failure-diagnosis.json');
  const jobSelection = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/reports/jobbench/benchmark-summary.json');
  const jobLatest = await readJson('experiments/evals/2026-07-agent-benchmark-comparison/reports/jobbench/latest-run-summary.json');

  const rowsByBenchmark = new Map();
  for (const row of allRows) {
    if (!rowsByBenchmark.has(row.benchmark)) rowsByBenchmark.set(row.benchmark, []);
    rowsByBenchmark.get(row.benchmark).push(row);
  }
  const programRows = rowsByBenchmark.get('program-bench') || [];
  const programRowSummary = summarizeRows(programRows);
  const browseRowSummary = summarizeRows(rowsByBenchmark.get('browsecomp') || []);

  const benchmarkSummaries = [
    {
      benchmark: 'swebench',
      capability: 'real_repo_bug_fixing',
      status: 'completed_existing_package',
      evidence_level: 'official_subset',
      target_subset: 30,
      selected_cases: sweSummary.selected_cases,
      executed_cases: 30,
      scored_cases: 30,
      model_controlled: true,
      scorer: sweSummary.grading_authority,
      official: true,
      result_summary: 'Sonnet: Agent RunLab 18/30, Claude Code 19/30. Opus: Agent RunLab 20/30, Claude Code 19/30.',
      next_gate: 'Optional: replace coarse unresolved-row categories with deeper manually reviewed SWE-bench failure labels for representative cases.',
      row_summary: summarizeRows(rowsByBenchmark.get('swebench') || []),
    },
    {
      benchmark: 'browsecomp',
      capability: 'web_browsing_retrieval_evidence_synthesis',
      status: 'smoke_scored_not_formal_subset',
      evidence_level: 'scored_smoke',
      target_subset: 30,
      selected_cases: browseSelection.selected_cases,
      executed_cases: browseLatest.selected_cases,
      scored_cases: browseLatest.selected_cases,
      model_controlled: true,
      scorer: browseLatest.scorer,
      official: true,
      result_summary: `Latest one-pair BrowseComp smoke ${browseLatest.run_id}: Agent RunLab average ${browseRowSummary.agent_avg_score}, Claude Code average ${browseRowSummary.claude_avg_score} over ${browseRowSummary.scored_rows} comparable row(s). Not a formal 30-case subset result.`,
      next_gate: browseCompNextGate(browseReadiness, browsePartialDiagnosis),
      row_summary: browseRowSummary,
    },
    {
      benchmark: 'swe-marathon',
      capability: 'long_horizon_software_engineering',
      status: 'source_audited_no_run_calibrated',
      evidence_level: 'source_audited_no_run_calibrated',
      target_subset: sweMarathonSelection.target_subset ?? 20,
      selected_cases: sweMarathonSelection.selected_cases ?? 0,
      executed_cases: 0,
      scored_cases: 0,
      model_controlled: false,
      scorer: '',
      official: false,
      result_summary: `Source audit covers ${sweMarathonSelection.selected_cases ?? 0} tasks. No-run Harbor calibration template ${sweMarathonNoRun.task || 'unknown'} is ${sweMarathonNoRun.status}; job_started=${sweMarathonNoRun.job_started}. Modal credentials validated=${sweMarathonNoRun.modal_credentials_validated}; spending controls validated=${sweMarathonNoRun.spending_controls_validated}. GPU cases=${sweMarathonSourcePreflight.gpu_cases}; internet-restricted cases=${sweMarathonSourcePreflight.internet_restricted_cases}.`,
      next_gate: 'Validate Modal credentials and explicit spending controls, then run exactly one non-GPU public-network SWE-Marathon calibration task. Do not run GPU, internet-restricted, or multi-agent subsets until that first calibration is scored and audited.',
      row_summary: summarizeRows([]),
    },
    {
      benchmark: 'program-bench',
      capability: 'program_reconstruction_executable_validation',
      status: programLatest.stop_reason ? 'gated_official_pilot_not_formal_subset' : 'official_calibration_not_formal_subset',
      evidence_level: 'official_calibration',
      target_subset: programSelection.selected_cases,
      selected_cases: programSelection.selected_cases,
      executed_cases: programLatest.completed_agent_runs ? Math.floor(programLatest.completed_agent_runs / 2) : programLatest.selected_cases,
      scored_cases: programRowSummary.scored_rows,
      model_controlled: true,
      scorer: programLatest.scorer,
      official: true,
      result_summary: programRowSummary.scored_rows
        ? `Latest gated official pilot ${programLatest.run_id}: Agent RunLab average ${programRowSummary.agent_avg_score}, Claude Code average ${programRowSummary.claude_avg_score} over ${programRowSummary.scored_rows} comparable row(s). Stop reason: ${programLatest.stop_reason || 'none'}.`
        : 'ProgramBench native scorer is wired, but latest run has no comparable scored rows.',
      next_gate: programBenchNextGate(programLatest, programFailureDiagnosis),
      row_summary: programRowSummary,
    },
    {
      benchmark: 'job-bench',
      capability: 'workplace_file_task_delivery',
      status: 'one_case_submitted_unscored_not_formal_subset',
      evidence_level: 'submitted_unscored',
      target_subset: jobSelection.selected_cases,
      selected_cases: jobSelection.selected_cases,
      executed_cases: jobLatest.selected_cases,
      scored_cases: 0,
      model_controlled: true,
      scorer: jobLatest.scorer,
      official: false,
      result_summary: 'One real dual-agent smoke submitted deliverables for both systems; official judge dataset prepared; no valid judge score because no judge API key is available.',
      next_gate: 'Run one valid official JobBench judge smoke for both systems, validate result JSON, then start a 10-case judged subset.',
      row_summary: summarizeRows(rowsByBenchmark.get('job-bench') || []),
    },
  ];

  return {
    schema_version: 2,
    generated_by: 'scripts/eval/benchmarks/core/aggregate-agent-benchmark-comparison.mjs',
    status: 'portfolio_in_progress',
    warning: 'Only SWE-bench is benchmark-scale official evidence. Non-SWE-bench rows are smoke, calibration, submitted-unscored, or source-audit evidence unless marked otherwise.',
    benchmarks: benchmarkSummaries,
  };
}

async function main() {
  await mkdir(resultsRoot, { recursive: true });
  const rows = [
    ...(await loadSwebenchRows()),
    ...(await loadArtifactBenchmarkRows('browsecomp', 'browsecomp')),
    ...(await loadArtifactBenchmarkRows('program-bench', 'program-bench')),
    ...(await loadArtifactBenchmarkRows('job-bench', 'job-bench')),
  ];

  const fields = [
    'benchmark',
    'evidence_level',
    'run_id',
    'instance_id',
    'task_type',
    'model',
    'scorer',
    'official',
    'agent_runlab_status',
    'claude_code_status',
    'agent_runlab_score',
    'claude_code_score',
    'winner',
    'agent_artifact',
    'claude_artifact',
    'grader_report',
    'failure_category',
    'notes',
  ];

  const summary = await buildBenchmarkSummary(rows);
  await writeFile(path.join(resultsRoot, 'cross-benchmark-pairwise.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(path.join(resultsRoot, 'cross-benchmark-pairwise.csv'), toCsv(rows, fields));
  await writePerBenchmarkPairwise(rows, fields);
  await writeFile(path.join(resultsRoot, 'benchmark-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(
    path.join(resultsRoot, 'benchmark-summary.csv'),
    toCsv(summary.benchmarks, [
      'benchmark',
      'capability',
      'status',
      'evidence_level',
      'target_subset',
      'selected_cases',
      'executed_cases',
      'scored_cases',
      'model_controlled',
      'scorer',
      'official',
      'result_summary',
      'next_gate',
    ]),
  );
  await writeFile(path.join(resultsRoot, 'failure-taxonomy.json'), JSON.stringify(buildFailureTaxonomy(), null, 2) + '\n');

  console.log(`Wrote ${rows.length} pairwise rows to ${rel('experiments/evals/2026-07-agent-benchmark-comparison/results')}`);
}

function buildFailureTaxonomy() {
  return [
    { id: 'wrong_hypothesis', description: 'The agent pursued an incorrect explanation or ownership boundary.' },
    { id: 'incomplete_execution', description: 'The agent found a plausible direction but did not finish enough work to satisfy the scorer.' },
    { id: 'tool_use_failure', description: 'The failure was caused by incorrect, missing, or ineffective tool use.' },
    { id: 'context_loss', description: 'Important prior information was lost, ignored, or overwritten during a long trajectory.' },
    { id: 'retrieval_failure', description: 'The agent failed to find required external or local evidence.' },
    { id: 'verification_gap', description: 'The agent did not run an adequate validation or used a non-equivalent check.' },
    { id: 'over_broad_change', description: 'The agent changed too much or introduced behavior outside the required scope.' },
    { id: 'format_error', description: 'The content may be correct but does not match the required answer or submission format.' },
    { id: 'environment_error', description: 'The run was blocked by infrastructure, dependency, authentication, or sandbox issues.' },
    { id: 'browser_navigation_failure', description: 'The agent failed to use browser/search tools effectively on web tasks.' },
    { id: 'long_horizon_planning_failure', description: 'The agent failed because of planning, decomposition, or sustained execution over a long task.' },
    { id: 'scorer_mismatch', description: "The submitted output did not align with the benchmark scorer's rubric or expected artifacts." },
    { id: 'artifact_contract_failure', description: 'The agent did not produce the required files, folder layout, or submission package expected by the benchmark.' },
    { id: 'implementation_write_through_failure', description: 'The runner-provided scaffold or placeholder satisfied superficial artifact checks, but the agent did not write substantive task implementation before scoring or stopping.' },
    { id: 'compile_failed', description: 'The benchmark-native build or compile step failed. This may be the scorer-level symptom of a deeper artifact-contract or implementation failure.' },
  ];
}

async function writePerBenchmarkPairwise(rows, fields) {
  for (const benchmark of ['swebench', 'swe-marathon']) {
    const benchmarkRows = rows.filter((row) => row.benchmark === benchmark);
    const reportRoot = path.join(portfolioRoot, 'reports', benchmark);
    await mkdir(reportRoot, { recursive: true });
    await writeFile(path.join(reportRoot, 'pairwise-comparison.jsonl'), benchmarkRows.map((row) => JSON.stringify(row)).join('\n') + (benchmarkRows.length ? '\n' : ''));
    await writeFile(path.join(reportRoot, 'pairwise-comparison.csv'), toCsv(benchmarkRows, fields));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

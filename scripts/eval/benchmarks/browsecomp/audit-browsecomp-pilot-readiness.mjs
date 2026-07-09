#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runnerRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const browseRoot = path.join(legacy-runnerRoot, 'artifacts/browsecomp')
const reportRoot = path.join(legacy-runnerRoot, 'reports/browsecomp')
const planningRoot = path.join(legacy-runnerRoot, 'planning/browsecomp')
const diagnosisRoot = path.join(legacy-runnerRoot, 'diagnostics/browsecomp')
const readinessPath = path.join(planningRoot, 'browsecomp-pilot-readiness.json')

async function main() {
  const latest = await readJson(path.join(reportRoot, 'latest-run-summary.json'))
  const headlineRows = await readJsonl(path.join(reportRoot, 'pairwise-comparison.jsonl'))
  const plan = await readJson(path.join(planningRoot, 'browsecomp-pilot-case-preflight.json'))
  const selectedPilotRows = await readJsonl(path.join(planningRoot, 'browsecomp-pilot-selected-cases.jsonl'))
  const targetRows = await readJsonl(path.join(planningRoot, 'browsecomp-target-selected-cases.jsonl'))
  const runnerSource = await readFile(path.join(root, 'packages/host/bin/run-browsecomp-legacy-runner.ts'), 'utf8')
  const runnerSourcePath = path.join(root, 'packages/host/bin/run-browsecomp-legacy-runner.ts')
  const runnerSourceStat = await stat(runnerSourcePath)
  const claudeRunnerSource = await readFile(path.join(root, 'packages/host/bin/run-claude-code-prompt.ts'), 'utf8')
  const benchmarkWebSource = await readFile(path.join(root, 'packages/host/bin/run-benchmark-web.ts'), 'utf8')
  const latestPartial = await maybeReadJson(path.join(diagnosisRoot, 'latest-partial-run-diagnosis.json'))
  const envPreflight = await maybeReadJson(path.join(legacy-runnerRoot, 'results/benchmark-env-preflight.json'))
  const latestPartialSummaryPath = latestPartial?.latest_partial_run?.run_id
    ? path.join(browseRoot, latestPartial.latest_partial_run.run_id, 'score-summary.json')
    : null
  const latestPartialSummaryStat = latestPartialSummaryPath ? await maybeStat(latestPartialSummaryPath) : null
  const envPreflightStat = await maybeStat(path.join(legacy-runnerRoot, 'results/benchmark-env-preflight.json'))
  const checks = buildChecks({ latest, headlineRows, plan, selectedPilotRows, targetRows, runnerSource, runnerSourceStat, latestPartial, latestPartialSummaryStat, claudeRunnerSource, benchmarkWebSource, envPreflight, envPreflightStat })
  const failed = checks.filter((check) => check.status !== 'pass')
  const recommendedCaseIds = plan.recommended_case_ids ?? []
  const report = {
    schema_version: 1,
    benchmark: 'browsecomp',
    generated_by: 'scripts/eval/benchmarks/browsecomp/audit-browsecomp-pilot-readiness.mjs',
    status: failed.length ? 'not_ready_for_next_pair' : 'ready_for_one_pair_pilot',
    latest_headline_run: {
      run_id: latest.run_id,
      status: latest.status,
      selected_cases: latest.selected_cases,
      scorer: latest.scorer,
      model: latest.model,
      judge_model: latest.judge_model,
    },
    recommended_case_ids: recommendedCaseIds,
    target_subset: {
      size: plan.target_subset_size ?? targetRows.length,
      artifact: 'planning/browsecomp/browsecomp-target-selected-cases.jsonl',
      execution_policy: 'The formal BrowseComp result requires the full fixed target subset to run paired under the same model/scorer protocol; the immediate gate is only the next spending checkpoint.',
    },
    next_allowed_step: failed.length
      ? 'Fix failing no-paid readiness checks before any BrowseComp spending.'
      : `Run exactly the first recommended pair (${recommendedCaseIds[0]}) with --max-agent-runs 2, --stop-after-turn-limits 1, and --stop-after-errors 1 before expanding to the remaining pilot cases.`,
    expansion_policy: 'Do not report diagnostics, dry-runs, partial_stopped runs, or single-agent runs as formal BrowseComp subset evidence. Keep headline files pinned to the completed scored smoke until a completed comparable pilot supersedes it.',
    required_command_flags: [
      '--agents agent-runlab,claude-code',
      '--case-id <fresh-case-id>',
      '--max-agent-runs 2',
      '--stop-after-turn-limits 1',
      '--stop-after-errors 1',
      '--max-turns 18',
      '--max-web-tool-calls 12',
    ],
    checks,
  }
  await mkdir(planningRoot, { recursive: true })
  await writeFile(readinessPath, JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(planningRoot, 'browsecomp-pilot-readiness.md'), renderMarkdown(report))
  console.log(`BrowseComp pilot readiness ${report.status}`)
}

function buildChecks({ latest, headlineRows, plan, selectedPilotRows, targetRows, runnerSource, runnerSourceStat, latestPartial, latestPartialSummaryStat, claudeRunnerSource, benchmarkWebSource, envPreflight, envPreflightStat }) {
  const checks = []
  const recommended = plan.recommended_case_ids ?? []
  const selectedIds = selectedPilotRows.map((row) => row.instance_id)
  const formalRerunMode = plan.immediate_gate?.mode === 'formal_rerun_prefix'
  checks.push(check('headline_completed_smoke', latest.status === 'completed', `latest=${latest.run_id}:${latest.status}`))
  checks.push(check('headline_one_comparable_row', headlineRows.length === 1 && headlineRows[0]?.winner !== 'not_comparable', `rows=${headlineRows.length}, winner=${headlineRows[0]?.winner}`))
  checks.push(check('headline_both_systems_scored', ['resolved', 'unresolved'].includes(headlineRows[0]?.agent_runlab_status) && ['resolved', 'unresolved'].includes(headlineRows[0]?.claude_code_status), `agent=${headlineRows[0]?.agent_runlab_status}, claude=${headlineRows[0]?.claude_code_status}`))
  checks.push(check('planning_no_model_or_judge_calls', plan.policy?.no_model_or_judge_calls === true, `no_model_or_judge_calls=${plan.policy?.no_model_or_judge_calls}`))
  const availableFreshCandidates = (plan.rows ?? []).filter((row) => row.recommendation === 'candidate').length
  const expectedImmediateCandidates = Math.min(5, availableFreshCandidates)
  checks.push(check('planning_recommends_available_fresh_cases', formalRerunMode || (recommended.length === expectedImmediateCandidates && recommended.length > 0), `recommended=${recommended.join(',')}; available_fresh=${availableFreshCandidates}; expected=${expectedImmediateCandidates}; mode=${plan.immediate_gate?.mode ?? 'missing'}`))
  checks.push(check('planning_has_formal_rerun_fallback', !formalRerunMode || (availableFreshCandidates === 0 && recommended.length > 0 && recommended.every((id) => (plan.rows ?? []).find((row) => row.instance_id === id)?.formal_rerun_needed === true)), `mode=${plan.immediate_gate?.mode ?? 'missing'}; recommended=${recommended.join(',')}; available_fresh=${availableFreshCandidates}`))
  checks.push(check('target_subset_has_30_cases', Number(plan.target_subset_size ?? 0) === 30 && targetRows.length === 30, `target_subset_size=${plan.target_subset_size}; target_rows=${targetRows.length}`))
  checks.push(check('immediate_gate_distinct_from_target_subset', recommended.length < targetRows.length && plan.immediate_gate?.first_case_id === recommended[0], `immediate=${recommended.length}; target=${targetRows.length}; first=${plan.immediate_gate?.first_case_id}`))
  checks.push(check('selected_jsonl_matches_recommendations', selectedIds.join(',') === recommended.join(','), `jsonl=${selectedIds.join(',')}`))
  checks.push(check('recommended_cases_are_fresh', formalRerunMode || (plan.rows ?? []).filter((row) => recommended.includes(row.instance_id)).every((row) => row.recommendation === 'candidate' && !row.reasons && !row.prior_runs), 'recommended cases have no prior run history unless formal rerun fallback is active'))
  checks.push(check('known_diagnostics_excluded', ['browsecomp-000', 'browsecomp-001', 'browsecomp-002', 'browsecomp-003', 'browsecomp-004', 'browsecomp-005', 'browsecomp-006', 'browsecomp-007', 'browsecomp-008', 'browsecomp-009', 'browsecomp-011'].every((id) => (plan.rows ?? []).find((row) => row.instance_id === id)?.recommendation === 'exclude'), 'archived diagnostic/smoke cases excluded'))
  checks.push(check('runner_has_cost_gates', ['--max-agent-runs', '--stop-after-errors', '--stop-after-turn-limits', '--stop-after-unresolved'].every((flag) => runnerSource.includes(flag)), 'runner exposes stop gates'))
  checks.push(check('agent_runlab_has_hard_web_tool_budget', runnerSource.includes("'--max-web-tool-calls'") && runnerSource.includes('maxWebToolCalls'), 'BrowseComp runner passes a hard web evidence-call budget to Agent RunLab'))
  checks.push(check('partial_runs_do_not_update_headline', runnerSource.includes('const shouldUpdateLatest = args.updateLatest && !args.dryRun && completedRequestedRun'), 'latest files update only when all requested agent runs completed'))
  checks.push(check('claude_uses_shared_web_tools', runnerSource.includes("'--shared-web-tools'") && claudeRunnerSource.includes('Benchmark web access is provided through the local command') && claudeRunnerSource.includes('disallowedTools: CLAUDE_CODE_WEB_TOOLS'), 'Claude runner is invoked with shared web helper and disables native WebSearch/WebFetch'))
  checks.push(check('benchmark_web_supports_search_and_fetch', benchmarkWebSource.includes('search --query') && benchmarkWebSource.includes('fetch --url'), 'benchmark-web exposes search/fetch'))
  checks.push(check('serper_search_preflight_passes', envPreflight?.web_search?.probe_status === 'ok' && envPreflight?.web_search?.organic_count > 0, `serper_probe=${envPreflight?.web_search?.probe_status ?? 'missing'}; organic_count=${envPreflight?.web_search?.organic_count ?? 0}`))
  checks.push(check('answer_key_not_in_agent_prompt', !runnerSource.includes('answer.answer)\n          await writeFile(promptPath') && runnerSource.includes('const prompt = QUERY_TEMPLATE.replace'), 'agent prompt is built from question template; answer key used for judge prompt'))
  checks.push(check('query_prompt_has_candidate_ledger', runnerSource.includes('candidate evidence ledger') && runnerSource.includes('supporting facets') && runnerSource.includes('contradicted facets'), 'prompt forces candidate/facet evidence tracking'))
  checks.push(check('query_prompt_has_answer_type_lock', runnerSource.includes('expected answer type') && runnerSource.includes('Every candidate and query must be judged against that answer type'), 'prompt forces answer-type-aware query planning'))
  checks.push(check('query_prompt_has_clue_chain_plan', runnerSource.includes('Treat multi-hop questions as a clue chain') && runnerSource.includes('numbered hop plan'), 'prompt forces multi-hop clue decomposition before search'))
  checks.push(check('query_prompt_limits_upstream_hop_spend', runnerSource.includes('Do not spend more than two searches on one upstream hop') && runnerSource.includes('fallback reverse-search query'), 'prompt limits repeated searches on a blocked upstream hop'))
  checks.push(check('query_prompt_limits_candidate_switching', runnerSource.includes('Do not open a third candidate') && runnerSource.includes('answer-type-specific verification query'), 'prompt limits candidate branching before verification'))
  checks.push(check('query_prompt_handles_biography_fields', runnerSource.includes('person birth name') && runnerSource.includes('birth name, born as, real name, pseudonym, spouse, children, discography, and first album'), 'prompt targets biographical field verification for identity clues'))
  checks.push(check('query_prompt_has_turn_checkpoints', runnerSource.includes('Every 4 assistant turns') && runnerSource.includes('After 14 assistant turns'), 'prompt forces periodic convergence and late-run finalization'))
  checks.push(check('query_prompt_has_checkpoint_elimination', runnerSource.includes('eliminate at least one candidate') && runnerSource.includes('Do not merely add broader candidates at a checkpoint'), 'prompt requires checkpoint elimination or focused verification'))
  checks.push(check('query_prompt_has_reverse_pivot', runnerSource.includes('mark each hop as solved, blocked, or bypassed') && runnerSource.includes('try one reverse query from the downstream clue'), 'prompt forces reverse pivoting when upstream hops stall'))
  checks.push(check('query_prompt_forbids_continue_plan', runnerSource.includes('Never finish with a plan') && runnerSource.includes('best-supported exact answer'), 'prompt forbids ending with a search plan'))
  const latestTurnLimit = latestPartial?.latest_partial_run?.stop_reason === 'stop_after_turn_limits:1'
    && latestPartial?.agent_runlab?.turn_limit_hit === true
  const serperProbeNewerThanLatestFailure = envPreflight?.web_search?.probe_status === 'ok'
    && (envPreflightStat?.mtimeMs ?? 0) > (latestPartialSummaryStat?.mtimeMs ?? Number.POSITIVE_INFINITY)
  const strategyNewerThanLatestFailure = !latestTurnLimit
    || (runnerSourceStat?.mtimeMs ?? 0) > (latestPartialSummaryStat?.mtimeMs ?? Number.POSITIVE_INFINITY)
    || serperProbeNewerThanLatestFailure
  checks.push(check('latest_turn_limit_has_newer_strategy_control', strategyNewerThanLatestFailure, latestTurnLimit
    ? `latest_partial=${latestPartial.latest_partial_run.run_id}; runner_mtime=${Math.round(runnerSourceStat?.mtimeMs ?? 0)}; serper_preflight_mtime=${Math.round(envPreflightStat?.mtimeMs ?? 0)}; failure_mtime=${Math.round(latestPartialSummaryStat?.mtimeMs ?? 0)}`
    : 'latest partial is not an Agent RunLab turn-limit stop'))
  return checks
}

function check(name, condition, evidence) {
  return { name, status: condition ? 'pass' : 'fail', evidence }
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

async function maybeStat(filePath) {
  try {
    return await stat(filePath)
  } catch {
    return null
  }
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function renderMarkdown(report) {
  const lines = [
    '# BrowseComp Pilot Readiness',
    '',
    `Status: \`${report.status}\``,
    '',
    `Latest headline run: \`${report.latest_headline_run.run_id}\` (${report.latest_headline_run.status})`,
    '',
    '## Recommended Fresh Cases',
    '',
    ...(report.recommended_case_ids.length ? report.recommended_case_ids.map((id, index) => `${index + 1}. \`${id}\``) : ['- none']),
    '',
    '## Formal Target Subset',
    '',
    `- Size: \`${report.target_subset.size}\``,
    `- Artifact: \`${report.target_subset.artifact}\``,
    `- Policy: ${report.target_subset.execution_policy}`,
    '',
    '## Next Allowed Step',
    '',
    report.next_allowed_step,
    '',
    '## Expansion Policy',
    '',
    report.expansion_policy,
    '',
    '## Required Command Flags',
    '',
    ...report.required_command_flags.map((flag) => `- \`${flag}\``),
    '',
    '## Checks',
    '',
    '| Check | Status | Evidence |',
    '|---|---|---|',
  ]
  for (const check of report.checks) lines.push(`| \`${check.name}\` | ${check.status} | ${String(check.evidence).replaceAll('|', '\\|')} |`)
  lines.push('')
  return lines.join('\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

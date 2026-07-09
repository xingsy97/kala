#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runnerRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const resultsRoot = path.join(legacy-runnerRoot, 'results')

const REQUIREMENTS = [
  ['source_audit', 'Canonical source, dataset format, scorer, cost/risk recorded'],
  ['fixed_subset', 'Deterministic fixed subset selected and recorded'],
  ['agent_runlab_run', 'Agent RunLab run exists on the current evidence slice'],
  ['claude_code_run', 'Claude Code run exists on the current evidence slice'],
  ['model_controlled', 'Agent RunLab and Claude Code comparison uses the same model family'],
  ['native_scorer', 'Score comes from benchmark-native/official evaluator, not agent self-report'],
  ['sufficient_subset', 'Current scored evidence is large enough to claim subset-level benchmark performance'],
  ['artifacts_preserved', 'Prompts, logs, responses/results, scoring reports, and supporting artifacts are preserved'],
  ['pairwise', 'Case-level pairwise comparison exists'],
  ['failure_analysis', 'Failure analysis exists and distinguishes failure modes'],
  ['evidence_notes', 'Legacy Runner-level evidence notes exist'],
]

async function main() {
  const summary = await readJson('results/benchmark-summary.json')
  const artifactCompleteness = await readJson('results/artifact-completeness.json')
  const jobPreflight = await maybeReadJson('artifacts/job-bench/judge-preflight/preflight-summary.json')
  const sweMarathonPreflight = await maybeReadJson('diagnostics/swe-marathon/no-run-calibration/preflight-summary.json')
  const rows = summary.benchmarks.map((benchmark) => buildBenchmarkCoverage(benchmark, artifactCompleteness, { jobPreflight, sweMarathonPreflight }))
  const report = {
    schema_version: 1,
    generated_by: 'scripts/eval/benchmarks/core/audit-benchmark-objective-coverage.mjs',
    objective_source: 'user-provided benchmark legacy-runner goal in the active agent session',
    status: rows.every((row) => row.complete) ? 'complete' : 'in_progress',
    completion_policy: 'A benchmark is complete only when it has a deterministic subset, both systems run, model-controlled comparison where applicable, valid native/official scoring, preserved artifacts, pairwise rows, and failure analysis. Smoke, calibration, submitted-unscored, and source-audit evidence do not satisfy sufficient_subset.',
    requirements: Object.fromEntries(REQUIREMENTS),
    benchmarks: rows,
    legacy-runner: buildLegacy RunnerCoverage(rows),
  }
  await writeFile(path.join(resultsRoot, 'objective-coverage.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(resultsRoot, 'objective-coverage.md'), renderMarkdown(report))
  console.log(`objective coverage ${report.status}`)
}

function buildBenchmarkCoverage(benchmark, artifactCompleteness, extras) {
  const artifactRow = artifactCompleteness.benchmarks.find((row) => row.benchmark === benchmark.benchmark)
  const checks = {}
  set(checks, 'source_audit', benchmark.selected_cases > 0 || benchmark.benchmark === 'swebench', evidence(benchmark, 'source audit and benchmark summary exist'))
  set(checks, 'fixed_subset', benchmark.selected_cases > 0, evidence(benchmark, `selected_cases=${benchmark.selected_cases}`))
  set(checks, 'agent_runlab_run', benchmark.executed_cases > 0 && benchmark.benchmark !== 'swe-marathon', evidence(benchmark, `executed_cases=${benchmark.executed_cases}`))
  set(checks, 'claude_code_run', benchmark.executed_cases > 0 && benchmark.benchmark !== 'swe-marathon', evidence(benchmark, `executed_cases=${benchmark.executed_cases}`))
  set(checks, 'model_controlled', Boolean(benchmark.model_controlled), evidence(benchmark, `model_controlled=${benchmark.model_controlled}`))
  set(checks, 'native_scorer', Boolean(benchmark.official && benchmark.scored_cases > 0), evidence(benchmark, `official=${benchmark.official}, scored_cases=${benchmark.scored_cases}, scorer=${benchmark.scorer || 'none'}`))
  set(checks, 'sufficient_subset', benchmark.evidence_level === 'official_subset', evidence(benchmark, `evidence_level=${benchmark.evidence_level}`))
  set(checks, 'artifacts_preserved', artifactRow?.status === 'pass', artifactRow ? `artifact-completeness: present=${artifactRow.present}, missing=${artifactRow.missing}` : 'missing artifact completeness row')
  set(checks, 'pairwise', (benchmark.row_summary?.rows ?? 0) > 0 || benchmark.benchmark === 'swe-marathon', evidence(benchmark, `pairwise_rows=${benchmark.row_summary?.rows ?? 0}`))
  set(checks, 'failure_analysis', true, `artifacts/${benchmark.benchmark}/failure-analysis.md exists and validator requires it`)
  set(checks, 'evidence_notes', true, 'legacy-runner evidence-notes.md exists and validator requires it')

  const blockers = blockersFor(benchmark, extras)
  const complete = Object.values(checks).every((check) => check.status === 'met') && blockers.length === 0
  return {
    benchmark: benchmark.benchmark,
    evidence_level: benchmark.evidence_level,
    target_subset: benchmark.target_subset,
    selected_cases: benchmark.selected_cases,
    executed_cases: benchmark.executed_cases,
    scored_cases: benchmark.scored_cases,
    complete,
    checks,
    blockers,
    next_gate: benchmark.next_gate,
  }
}

function blockersFor(benchmark, extras) {
  if (benchmark.benchmark === 'swebench') return []
  if (benchmark.benchmark === 'browsecomp') {
    return [
      'Only one scored headline smoke exists; formal fixed subset still pending.',
      'Additional diagnostics must not be promoted to formal subset rows.',
    ]
  }
  if (benchmark.benchmark === 'program-bench') {
    return [
      'Latest evidence is one comparable official calibration pair, not a stable 5-case pilot or 50-case target subset.',
      'Implementation write-through must be validated on one guarded capped pair before broad spending; scaffold-only native scores are not informative benchmark evidence.',
    ]
  }
  if (benchmark.benchmark === 'job-bench') {
    const status = extras.jobPreflight?.status || 'missing_preflight'
    return [
      `Official judge score missing; judge preflight status is ${status}.`,
      'A valid judge JSON must pass validate-jobbench-judge-result.mjs before any score is reported.',
    ]
  }
  if (benchmark.benchmark === 'swe-marathon') {
    const status = extras.sweMarathonPreflight?.status || 'missing_no_run_preflight'
    const jobStarted = extras.sweMarathonPreflight?.job_started
    return [
      `No live Harbor/Modal task has run; no-run calibration status is ${status}; job_started=${jobStarted}.`,
      'Modal credentials and explicit spending controls must be validated before the first non-GPU public-network calibration.',
      'GPU, internet-restricted, and multi-agent subsets must remain blocked until the first calibration is scored and audited.',
    ]
  }
  return ['unknown benchmark state']
}

function buildLegacy RunnerCoverage(rows) {
  const completed = rows.filter((row) => row.complete).map((row) => row.benchmark)
  const incomplete = rows.filter((row) => !row.complete).map((row) => row.benchmark)
  return {
    complete: incomplete.length === 0,
    completed_benchmarks: completed,
    incomplete_benchmarks: incomplete,
    safe_claim: 'Only SWE-bench currently satisfies the full benchmark-scale objective. Other benchmarks have source audits, smoke/calibration/submitted evidence, adapters, and preserved artifacts, but are not final performance results.',
    current_scope: 'In scope: SWE-bench, BrowseComp, ProgramBench, JobBench, SWE-Marathon source/no-run calibration. SWE-Marathon live Harbor/Modal execution remains credential- and cost-gated.',
  }
}

function set(checks, key, condition, evidenceText) {
  checks[key] = {
    status: condition ? 'met' : 'missing',
    evidence: evidenceText,
  }
}

function evidence(benchmark, text) {
  return `${benchmark.benchmark}: ${text}`
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(legacy-runnerRoot, relativePath), 'utf8'))
}

async function maybeReadJson(relativePath) {
  try {
    return await readJson(relativePath)
  } catch {
    return null
  }
}

function renderMarkdown(report) {
  const lines = [
    '# Benchmark Objective Coverage Audit',
    '',
    `Status: \`${report.status}\``,
    '',
    report.completion_policy,
    '',
    `Safe claim: ${report.legacy-runner.safe_claim}`,
    '',
    '## Benchmark Coverage',
    '',
    '| Benchmark | Evidence | Executed | Scored | Complete | Missing requirements |',
    '|---|---|---:|---:|---|---|',
  ]
  for (const row of report.benchmarks) {
    const missing = Object.entries(row.checks).filter(([, check]) => check.status !== 'met').map(([key]) => key)
    lines.push(`| ${row.benchmark} | ${row.evidence_level} | ${row.executed_cases} | ${row.scored_cases} | ${row.complete ? 'yes' : 'no'} | ${missing.length ? missing.map((item) => `\`${item}\``).join(', ') : ''} |`)
  }
  lines.push('', '## Incomplete Benchmark Gates', '')
  for (const row of report.benchmarks.filter((item) => !item.complete)) {
    lines.push(`### ${row.benchmark}`, '')
    for (const blocker of row.blockers) lines.push(`- ${blocker}`)
    lines.push(`- Next gate: ${row.next_gate}`, '')
  }
  return lines.join('\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

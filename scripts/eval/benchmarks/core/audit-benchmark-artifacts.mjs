#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runnerRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const resultsRoot = path.join(legacy-runnerRoot, 'results')

const REPORT_DIR_BY_BENCHMARK = {
  browsecomp: 'browsecomp',
  'program-bench': 'programbench',
  'job-bench': 'jobbench',
  'swe-marathon': 'swe-marathon',
  swebench: 'swebench',
}

const REQUIRED_RESULT_FILES = [
  'results/benchmark-summary.json',
  'results/benchmark-summary.csv',
  'results/cross-benchmark-pairwise.jsonl',
  'results/cross-benchmark-pairwise.csv',
  'results/failure-taxonomy.json',
]

async function main() {
  const summary = await readJson(path.join(legacy-runnerRoot, 'results/benchmark-summary.json'))
  const benchmarks = []
  for (const benchmark of summary.benchmarks) {
    benchmarks.push(await auditBenchmark(benchmark))
  }
  const report = {
    schema_version: 1,
    generated_by: 'scripts/eval/benchmarks/core/audit-benchmark-artifacts.mjs',
    scope: 'Audits current legacy-runner headline/latest evidence and required legacy-runner files. It does not scan every historical diagnostic run.',
    status: benchmarks.every((item) => item.status === 'pass' || item.status === 'not_applicable') ? 'pass' : 'attention_required',
    legacy-runner_files: await auditLegacy RunnerFiles(),
    benchmarks,
  }
  await writeFile(path.join(resultsRoot, 'artifact-completeness.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(resultsRoot, 'artifact-completeness.md'), renderMarkdown(report))
  console.log(`artifact completeness ${report.status}`)
}

async function auditLegacy RunnerFiles() {
  const rows = []
  for (const relative of REQUIRED_RESULT_FILES) {
    rows.push(await fileCheck(relative, path.join(legacy-runnerRoot, relative)))
  }
  return rows
}

async function auditBenchmark(benchmark) {
  if (benchmark.benchmark === 'swebench') return auditSwebench(benchmark)
  if (benchmark.benchmark === 'swe-marathon') return auditSweMarathon(benchmark)
  const artifactRoot = path.join(legacy-runnerRoot, 'artifacts', benchmark.benchmark)
  const reportRoot = path.join(legacy-runnerRoot, 'reports', REPORT_DIR_BY_BENCHMARK[benchmark.benchmark] ?? benchmark.benchmark)
  const latestPath = path.join(reportRoot, 'latest-run-summary.json')
  const latest = await maybeReadJson(latestPath)
  const checks = [
    await fileCheck('reports/runbook.md', path.join(reportRoot, 'runbook.md')),
    await fileCheck('reports/command-log.md', path.join(reportRoot, 'command-log.md')),
    await fileCheck('reports/failure-analysis.md', path.join(reportRoot, 'failure-analysis.md')),
    await fileCheck('reports/benchmark-summary.json', path.join(reportRoot, 'benchmark-summary.json')),
    await fileCheck('reports/pairwise-comparison.jsonl', path.join(reportRoot, 'pairwise-comparison.jsonl')),
    await fileCheck('reports/pairwise-comparison.csv', path.join(reportRoot, 'pairwise-comparison.csv')),
    await fileCheck('latest-run-summary.json', latestPath),
  ]
  if (benchmark.benchmark === 'browsecomp') {
    checks.push(await fileCheck('diagnostics/latest-partial-run-diagnosis.json', path.join(legacy-runnerRoot, 'diagnostics/browsecomp/latest-partial-run-diagnosis.json')))
    checks.push(await fileCheck('diagnostics/latest-partial-run-diagnosis.md', path.join(legacy-runnerRoot, 'diagnostics/browsecomp/latest-partial-run-diagnosis.md')))
  }
  if (benchmark.benchmark === 'program-bench') {
    checks.push(await fileCheck('diagnostics/latest-failure-diagnosis.json', path.join(legacy-runnerRoot, 'diagnostics/programbench/latest-failure-diagnosis.json')))
    checks.push(await fileCheck('diagnostics/latest-failure-diagnosis.md', path.join(legacy-runnerRoot, 'diagnostics/programbench/latest-failure-diagnosis.md')))
  }
  if (benchmark.benchmark === 'job-bench') {
    checks.push(await fileCheck('diagnostics/latest-submitted-smoke-diagnosis.json', path.join(legacy-runnerRoot, 'diagnostics/jobbench/latest-submitted-smoke-diagnosis.json')))
    checks.push(await fileCheck('diagnostics/latest-submitted-smoke-diagnosis.md', path.join(legacy-runnerRoot, 'diagnostics/jobbench/latest-submitted-smoke-diagnosis.md')))
  }
  const runRoot = latest?.run_root ? path.join(legacy-runnerRoot, latest.run_root) : null
  const runChecks = runRoot ? await auditRunRoot(benchmark.benchmark, runRoot, latest) : []
  return summarizeBenchmark({
    benchmark: benchmark.benchmark,
    evidence_level: benchmark.evidence_level,
    headline_run_id: latest?.run_id || '',
    checks: [...checks, ...runChecks],
  })
}

async function auditSwebench(benchmark) {
  const sweRoot = path.join(root, 'experiments/evals/2026-07-17-swebench-agent-vs-claude')
  const checks = []
  for (const relative of [
    'selected-cases.jsonl',
    'agent-runlab-results.jsonl',
    'claude-code-results.jsonl',
    'model-controlled-run-summary.json',
    'model-controlled-comparison.jsonl',
    'model-controlled-comparison.csv',
    'pairwise-comparison.jsonl',
    'pairwise-comparison.csv',
    'failure-analysis.md',
    'command-log.md',
    'manifest.md',
    'runbook.md',
  ]) {
    checks.push(await fileCheck(relative, path.join(sweRoot, relative)))
  }
  for (const relative of [
    'artifacts/agent-runlab',
    'artifacts/claude-code',
    'artifacts/harness',
    'artifacts/raw',
  ]) {
    checks.push(await dirCheck(relative, path.join(sweRoot, relative)))
  }
  return summarizeBenchmark({
    benchmark: benchmark.benchmark,
    evidence_level: benchmark.evidence_level,
    headline_run_id: '2026-07-17-swebench-agent-vs-claude',
    checks,
  })
}

async function auditSweMarathon(benchmark) {
  const reportRoot = path.join(legacy-runnerRoot, 'reports/swe-marathon')
  const planningRoot = path.join(legacy-runnerRoot, 'planning/swe-marathon')
  const diagnosticsRoot = path.join(legacy-runnerRoot, 'diagnostics/swe-marathon')
  const checks = []
  for (const relative of ['benchmark-summary.json', 'runbook.md', 'command-log.md', 'failure-analysis.md', 'pairwise-comparison.jsonl', 'pairwise-comparison.csv']) checks.push(await fileCheck(`reports/${relative}`, path.join(reportRoot, relative)))
  for (const relative of ['selected-cases.jsonl', 'selected-cases.csv']) checks.push(await fileCheck(`planning/${relative}`, path.join(planningRoot, relative)))
  for (const relative of ['source-preflight.json', 'source-preflight.md', 'no-run-calibration/README.md', 'no-run-calibration/stripe-clone-claude-code-sonnet-modal.config.json', 'no-run-calibration/print-config-output.json', 'no-run-calibration/preflight-summary.json']) checks.push(await fileCheck(`diagnostics/${relative}`, path.join(diagnosticsRoot, relative)))
  checks.push(await dirCheck('references/swe-marathon', path.join(legacy-runnerRoot, 'references/swe-marathon')))
  return summarizeBenchmark({
    benchmark: benchmark.benchmark,
    evidence_level: benchmark.evidence_level,
    headline_run_id: 'source-audit',
    checks,
  })
}

async function auditRunRoot(benchmark, runRoot, latest) {
  const checks = [
    await dirCheck('run_root', runRoot),
    await fileCheck('run_root/score-summary.json', path.join(runRoot, 'score-summary.json')),
    await fileCheck('run_root/instance-results.jsonl', path.join(runRoot, 'instance-results.jsonl'), { optional: benchmark === 'browsecomp' && latest.status === 'completed' }),
    await fileCheck('run_root/pairwise-comparison.jsonl', path.join(runRoot, 'pairwise-comparison.jsonl'), { optional: benchmark === 'browsecomp' && latest.status === 'completed' }),
    await fileCheck('run_root/pairwise-comparison.csv', path.join(runRoot, 'pairwise-comparison.csv'), { optional: benchmark === 'browsecomp' && latest.status === 'completed' }),
  ]
  const instanceRows = await maybeReadJsonl(path.join(runRoot, 'instance-results.jsonl'))
  const rowByAgentCase = new Map(instanceRows.map((row) => [`${row.agent}:${row.instance_id}`, row]))
  const agents = Object.keys(latest.agents || {})
  for (const agent of agents) {
    const agentDir = path.join(runRoot, agent)
    checks.push(await dirCheck(`run_root/${agent}`, agentDir))
    const caseDirs = await listDirs(agentDir)
    if (!caseDirs.length) {
      checks.push({ label: `run_root/${agent}/case_dirs`, status: 'missing', detail: 'no case directories found' })
      continue
    }
    for (const caseName of caseDirs) {
      const caseDir = path.join(agentDir, caseName)
      const row = rowByAgentCase.get(`${agent}:${caseName}`)
      const wasSkipped = row?.status === 'not_run' || row?.error_type?.startsWith?.('stop_gate:')
      checks.push(await fileCheck(`run_root/${agent}/${caseName}/prompt.txt`, path.join(caseDir, 'prompt.txt')))
      if (wasSkipped) {
        checks.push(await fileCheck(`run_root/${agent}/${caseName}/run-manifest.json`, path.join(caseDir, 'run-manifest.json')))
        checks.push(await fileCheck(`run_root/${agent}/${caseName}/skipped.txt`, path.join(caseDir, 'skipped.txt')))
        continue
      }
      checks.push(await fileCheck(`run_root/${agent}/${caseName}/result.json`, path.join(caseDir, 'result.json'), { optional: benchmark === 'program-bench' }))
      checks.push(await anyFileCheck(`run_root/${agent}/${caseName}/response`, caseDir, ['response.txt', 'response.raw.txt']))
      checks.push(await anyPatternCheck(`run_root/${agent}/${caseName}/runner-log`, caseDir, [/\.log$/]))
      if (agent === 'agent-runlab') checks.push(await anyFileCheck(`run_root/${agent}/${caseName}/session`, caseDir, ['agent-runlab-session.jsonl']))
      if (benchmark === 'browsecomp') {
        checks.push(await anyFileCheck(`run_root/${agent}/${caseName}/judge-prompt`, caseDir, ['judge-prompt.txt']))
        checks.push(await anyFileCheck(`run_root/${agent}/${caseName}/judge-response`, caseDir, ['judge-response.txt']))
      }
      if (benchmark === 'program-bench') {
        checks.push(await fileCheck(`run_root/${agent}/${caseName}/run-manifest.json`, path.join(caseDir, 'run-manifest.json')))
        checks.push(await fileCheck(`run_root/${agent}/${caseName}/native-score.json`, path.join(caseDir, 'native-score.json')))
        checks.push(await anyPatternCheck(`run_root/${agent}/${caseName}/native-eval-log`, caseDir, [/programbench-eval.*\.log$/, /native-score.*\.log$/]))
        checks.push(await anyFileCheck(`run_root/${agent}/${caseName}/submission-contract`, caseDir, ['submission-contract.json', 'submission-contract.initial.json']))
        const continuationSummary = path.join(caseDir, 'contract-continuation-summary.json')
        if (await shouldRequireProgramBenchContinuationSummary(caseDir, row, continuationSummary)) {
          checks.push(await fileCheck(`run_root/${agent}/${caseName}/contract-continuation-summary`, continuationSummary))
        }
      }
      if (benchmark === 'job-bench') {
        checks.push(await fileCheck(`run_root/${agent}/${caseName}/task_card.md`, path.join(caseDir, 'task_card.md')))
        checks.push(await fileCheck(`run_root/${agent}/${caseName}/RUBRICS.json`, path.join(caseDir, 'RUBRICS.json')))
        checks.push(await fileCheck(`run_root/${agent}/${caseName}/reference-files.json`, path.join(caseDir, 'reference-files.json')))
        checks.push(await fileCheck(`run_root/${agent}/${caseName}/deliverables-manifest.json`, path.join(caseDir, 'deliverables-manifest.json')))
      }
    }
  }
  if (benchmark === 'job-bench') {
    checks.push(await fileCheck('run_root/native-judge-dataset/judge-dataset-manifest.json', findJudgeManifestPath(runRoot)))
    checks.push(await fileCheck('judge-preflight/preflight-summary.json', path.join(legacy-runnerRoot, 'artifacts/job-bench/judge-preflight/preflight-summary.json')))
    checks.push(await fileCheck('judge-preflight/README.md', path.join(legacy-runnerRoot, 'artifacts/job-bench/judge-preflight/README.md')))
  }
  return checks
}

async function shouldRequireProgramBenchContinuationSummary(caseDir, row, continuationSummary) {
  if (await fileExists(continuationSummary)) return true
  const artifactText = [row?.agent_artifact, row?.claude_artifact, row?.artifact]
    .filter((value) => typeof value === 'string')
    .join(';')
  if (artifactText.includes('contract-continuation-summary.json')) return true
  for (const marker of [
    'contract-repair-prompt.txt',
    'contract-continuation-2-prompt.txt',
    'contract-continuation-3-prompt.txt',
  ]) {
    if (await fileExists(path.join(caseDir, marker))) return true
  }
  return false
}

function summarizeBenchmark({ benchmark, evidence_level, headline_run_id, checks }) {
  const missing = checks.filter((check) => check.status === 'missing')
  const optionalMissing = checks.filter((check) => check.status === 'optional_missing')
  const present = checks.filter((check) => check.status === 'present')
  return {
    benchmark,
    evidence_level,
    headline_run_id,
    status: missing.length ? 'attention_required' : 'pass',
    present: present.length,
    missing: missing.length,
    optional_missing: optionalMissing.length,
    checks,
  }
}

function findJudgeManifestPath(runRoot) {
  return path.join(runRoot, 'native-judge-dataset/easy/judge-dataset-manifest.json')
}

async function fileCheck(label, filePath, options = {}) {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return { label, status: 'missing', detail: 'not a file' }
    return { label, status: 'present', size: info.size }
  } catch {
    return { label, status: options.optional ? 'optional_missing' : 'missing', detail: 'file not found' }
  }
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath)
    return info.isFile()
  } catch {
    return false
  }
}

async function dirCheck(label, dirPath) {
  try {
    const info = await stat(dirPath)
    if (!info.isDirectory()) return { label, status: 'missing', detail: 'not a directory' }
    const entries = await readdir(dirPath)
    return { label, status: 'present', entries: entries.length }
  } catch {
    return { label, status: 'missing', detail: 'directory not found' }
  }
}

async function anyFileCheck(label, dirPath, names) {
  for (const name of names) {
    const check = await fileCheck(`${label}:${name}`, path.join(dirPath, name), { optional: true })
    if (check.status === 'present') return { label, status: 'present', matched: name, size: check.size }
  }
  return { label, status: 'missing', detail: `none of ${names.join(', ')} found` }
}

async function anyPatternCheck(label, dirPath, patterns) {
  try {
    const entries = await readdir(dirPath)
    const matched = entries.find((entry) => patterns.some((pattern) => pattern.test(entry)))
    if (!matched) return { label, status: 'missing', detail: `no file matched ${patterns.map(String).join(', ')}` }
    const info = await stat(path.join(dirPath, matched))
    return { label, status: 'present', matched, size: info.size }
  } catch {
    return { label, status: 'missing', detail: 'directory not found' }
  }
}

async function listDirs(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

async function maybeReadJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function maybeReadJsonl(filePath) {
  try {
    const text = await readFile(filePath, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function renderMarkdown(report) {
  const lines = [
    '# Benchmark Artifact Completeness Audit',
    '',
    `Generated by \`${report.generated_by}\`.`,
    '',
    `Scope: ${report.scope}`,
    '',
    `Overall status: \`${report.status}\``,
    '',
    '## Legacy Runner Files',
    '',
    '| File | Status | Detail |',
    '|---|---|---|',
  ]
  for (const check of report.legacy-runner_files) lines.push(`| \`${check.label}\` | ${check.status} | ${check.size ?? check.detail ?? ''} |`)
  lines.push('', '## Benchmarks', '', '| Benchmark | Evidence | Headline run | Status | Present | Missing | Optional missing |', '|---|---|---|---|---:|---:|---:|')
  for (const benchmark of report.benchmarks) {
    lines.push(`| ${benchmark.benchmark} | ${benchmark.evidence_level} | \`${benchmark.headline_run_id}\` | ${benchmark.status} | ${benchmark.present} | ${benchmark.missing} | ${benchmark.optional_missing} |`)
  }
  for (const benchmark of report.benchmarks) {
    const missing = benchmark.checks.filter((check) => check.status === 'missing')
    if (!missing.length) continue
    lines.push('', `## ${benchmark.benchmark} Missing Required Artifacts`, '')
    for (const check of missing) lines.push(`- \`${check.label}\`: ${check.detail || 'missing'}`)
  }
  lines.push('')
  return lines.join('\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

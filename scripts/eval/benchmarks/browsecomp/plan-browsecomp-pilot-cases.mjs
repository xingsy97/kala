#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runner = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const browseRoot = path.join(legacy-runner, 'artifacts/browsecomp')
const browsePlanningRoot = path.join(legacy-runner, 'planning/browsecomp')

const args = parseArgs(process.argv.slice(2))

await main()

async function main() {
  const selected = await readJsonl(args.selectedCases)
  const history = await loadHistory()
  const historyByCase = groupBy(history.flatMap((run) => run.cases.map((item) => ({ ...item, run_id: run.run_id, run_status: run.status }))), 'instance_id')
  const rows = selected.map((item, index) => classifyCase(item, index, historyByCase.get(item.instance_id) ?? []))
  const freshRecommended = rows.filter((row) => row.recommendation === 'candidate').slice(0, args.limit)
  const rerunRecommended = freshRecommended.length
    ? []
    : rows.filter((row) => row.formal_rerun_needed === true).slice(0, args.limit)
  const recommended = freshRecommended.length ? freshRecommended : rerunRecommended
  const immediateGateMode = freshRecommended.length ? 'fresh_unrun_prefix' : 'formal_rerun_prefix'
  const report = {
    schema_version: 1,
    generated_by: 'scripts/eval/benchmarks/browsecomp/plan-browsecomp-pilot-cases.mjs',
    selected_cases: selected.length,
    target_subset_size: selected.length,
    requested_pilot_cases: args.limit,
    policy: {
      exclude_known_diagnostics: true,
      exclude_already_scored_smoke: true,
      prefer_selected_order: true,
      no_model_or_judge_calls: true,
      formal_subset_is_full_selected_cases: true,
      immediate_gate_is_fresh_unrun_prefix: immediateGateMode === 'fresh_unrun_prefix',
      immediate_gate_is_formal_rerun_prefix: immediateGateMode === 'formal_rerun_prefix',
    },
    target_case_ids: rows.map((row) => row.instance_id),
    recommended_case_ids: recommended.map((row) => row.instance_id),
    immediate_gate: {
      case_ids: recommended.map((row) => row.instance_id),
      first_case_id: recommended[0]?.instance_id ?? null,
      max_agent_runs: 2,
      stop_after_turn_limits: 1,
      stop_after_errors: 1,
      mode: immediateGateMode,
      note: immediateGateMode === 'fresh_unrun_prefix'
        ? 'Run the first fresh pair before expanding; this is not the formal 30-case subset result.'
        : 'All fixed target cases have history. Run the first formal rerun pair before expanding; this is not the formal 30-case subset result.',
    },
    rows,
  }
  await mkdir(args.outputDir, { recursive: true })
  await writeFile(path.join(args.outputDir, 'browsecomp-pilot-case-preflight.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(path.join(args.outputDir, 'browsecomp-pilot-case-preflight.csv'), toCsv(rows), 'utf8')
  await writeFile(path.join(args.outputDir, 'browsecomp-pilot-selected-cases.jsonl'), `${recommended.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  await writeFile(path.join(args.outputDir, 'browsecomp-target-selected-cases.jsonl'), `${rows.map((row) => JSON.stringify({
    benchmark: 'browsecomp',
    instance_id: row.instance_id,
    source_row_index: row.source_row_index,
    selected_index: row.selected_index,
    execution_status: row.recommendation === 'candidate' ? 'pending_fresh' : row.formal_rerun_needed ? 'pending_formal_rerun' : 'historical_or_diagnostic_boundary',
    formal_rerun_needed: row.formal_rerun_needed,
    reasons: row.reasons,
    prior_runs: row.prior_runs,
  })).join('\n')}\n`, 'utf8')
  await writeFile(path.join(args.outputDir, 'browsecomp-pilot-case-preflight.md'), toMarkdown(report), 'utf8')
  console.log(JSON.stringify({ recommended_case_ids: report.recommended_case_ids, output_dir: relativeToLegacy Runner(args.outputDir) }, null, 2))
}

function classifyCase(item, selected_index, history) {
  const diagnostics = history.filter((entry) => entry.diagnostic)
  const scoredSmoke = history.some((entry) => entry.status === 'resolved' && entry.comparable === true)
  const formalComparable = history.some((entry) => entry.comparable === true && (entry.status === 'resolved' || entry.status === 'unresolved'))
  const turnLimit = history.some((entry) => entry.error_type === 'turn_limit_best_effort' || String(entry.stop_reason ?? '').includes('turn_limits'))
  const aborted = history.some((entry) => String(entry.run_status).includes('aborted') || entry.status === 'terminated_before_result')
  const errors = history.some((entry) => entry.status === 'error')
  const reasons = []
  if (scoredSmoke) reasons.push('already_scored_smoke')
  if (turnLimit) reasons.push('prior_turn_limit')
  if (aborted) reasons.push('prior_aborted_or_terminated')
  if (errors) reasons.push('prior_infrastructure_error')
  if (diagnostics.length) reasons.push('has_diagnostic_history')
  const recommendation = reasons.length ? 'exclude' : 'candidate'
  const formal_rerun_needed = !formalComparable || errors || turnLimit || aborted
  return {
    selected_index,
    instance_id: item.instance_id,
    source_row_index: item.source_row_index,
    question_chars: item.question.length,
    question_preview: item.question.replace(/\s+/g, ' ').slice(0, 180),
    recommendation,
    formal_rerun_needed,
    reasons: reasons.join(';'),
    prior_runs: history.map((entry) => `${entry.run_id}:${entry.agent ?? 'pair'}:${entry.status ?? entry.run_status}`).join(';'),
  }
}

async function loadHistory() {
  const out = []
  for (const name of await readdir(browseRoot)) {
    if (name === 'grading' || name === 'planning') continue
    const runDir = path.join(browseRoot, name)
    const scorePath = path.join(runDir, 'score-summary.json')
    const abortedPath = path.join(runDir, 'aborted-run-summary.json')
    if (existsSync(scorePath)) {
      const summary = JSON.parse(await readFile(scorePath, 'utf8'))
      if (summary.status === 'dry_run') continue
      out.push({ run_id: summary.run_id ?? name, status: summary.status, cases: await loadRunCases(runDir, summary) })
    } else if (existsSync(abortedPath)) {
      const summary = JSON.parse(await readFile(abortedPath, 'utf8'))
      const cases = [
        ...(summary.completed_agent_runs ?? []).map((row) => ({ ...row, diagnostic: true })),
        ...(summary.partial_agent_runs ?? []).map((row) => ({ ...row, diagnostic: true })),
      ]
      out.push({ run_id: summary.run_id ?? name, status: summary.status, cases })
    }
  }
  return out
}

async function loadRunCases(runDir, summary) {
  const instancePath = path.join(runDir, 'instance-results.jsonl')
  if (existsSync(instancePath)) {
    return (await readJsonl(instancePath)).map((row) => ({
      instance_id: row.instance_id,
      agent: row.agent,
      status: row.status,
      score: row.score,
      error_type: row.error_type,
      stop_reason: summary.stop_reason ?? null,
      diagnostic: summary.status !== 'completed' || Boolean(summary.stop_reason) || row.status === 'error' || row.error_type === 'turn_limit_best_effort',
      comparable: summary.status === 'completed' && row.status !== 'error' && row.status !== 'not_run' && row.error_type !== 'turn_limit_best_effort',
    }))
  }
  const cases = []
  for (const agent of ['agent-runlab', 'claude-code']) {
    const agentDir = path.join(runDir, agent)
    if (!existsSync(agentDir)) continue
    for (const caseId of await readdir(agentDir)) {
      const resultPath = path.join(agentDir, caseId, 'result.json')
      if (!existsSync(resultPath)) continue
      const row = JSON.parse(await readFile(resultPath, 'utf8'))
      cases.push({
        instance_id: row.instance_id,
        agent: row.agent,
        status: row.status,
        score: row.score,
        error_type: row.error_type,
        stop_reason: summary.stop_reason ?? null,
        diagnostic: summary.status !== 'completed' || Boolean(summary.stop_reason) || row.status === 'error' || row.error_type === 'turn_limit_best_effort',
        comparable: summary.status === 'completed' && row.status !== 'error' && row.status !== 'not_run' && row.error_type !== 'turn_limit_best_effort',
      })
    }
  }
  return cases
}

async function readJsonl(file) {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function groupBy(rows, key) {
  const map = new Map()
  for (const row of rows) {
    const value = row[key]
    if (!map.has(value)) map.set(value, [])
    map.get(value).push(row)
  }
  return map
}

function toCsv(rows) {
  const fields = ['selected_index', 'instance_id', 'source_row_index', 'question_chars', 'recommendation', 'formal_rerun_needed', 'reasons', 'prior_runs', 'question_preview']
  return `${fields.join(',')}\n${rows.map((row) => fields.map((field) => csvCell(row[field] ?? '')).join(',')).join('\n')}\n`
}

function csvCell(value) {
  const text = String(value)
  if (!/[",\n]/.test(text)) return text
  return `"${text.replaceAll('"', '""')}"`
}

function toMarkdown(report) {
  const recommended = report.recommended_case_ids.map((id, i) => `${i + 1}. \`${id}\``).join('\n') || '- none'
  const excluded = report.rows.filter((row) => row.recommendation === 'exclude')
  return `# BrowseComp Pilot Case Preflight\n\nGenerated by \`${report.generated_by}\`. No model, web, or judge calls were made.\n\n## Formal Target Subset\n\n- Target subset size: \`${report.target_subset_size}\` fixed selected cases.\n- Target subset artifact: \`browsecomp-target-selected-cases.jsonl\`.\n- Historical or diagnostic rows remain part of the fixed selected-case boundary but are not promoted as completed formal results unless they are rerun under the formal paired protocol.\n\n## Immediate Gate\n\nMode: \`${report.immediate_gate.mode}\`\n\nRun only the first recommended pair before expanding. This gate is deliberately smaller than the formal target subset.\n\n${recommended}\n\n## Policy\n\n- Preserve deterministic selected-case order.\n- Exclude already scored smoke cases from the immediate fresh gate.\n- Exclude cases with archived turn-limit, aborted, or infrastructure diagnostic history from the immediate fresh gate.\n- If all fixed target cases already have history, switch the immediate gate to the fixed-subset formal rerun prefix.\n- Treat this as case selection planning, not benchmark evidence.\n\n## Excluded Cases With History\n\n| Case | Reasons | Prior runs |\n|---|---|---|\n${excluded.map((row) => `| \`${row.instance_id}\` | ${row.reasons || ''} | ${row.prior_runs || ''} |`).join('\n') || '| none |  |  |'}\n`
}

function relativeToLegacy Runner(file) {
  return path.relative(legacy-runner, file).replaceAll(path.sep, '/')
}

function parseArgs(argv) {
  const outputDir = path.resolve(value(argv, '--output-dir') ?? browsePlanningRoot)
  return {
    selectedCases: path.resolve(value(argv, '--selected-cases') ?? path.join(browsePlanningRoot, 'selected-cases.jsonl')),
    outputDir,
    limit: numberValue(argv, '--limit') ?? 5,
  }
}

function value(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function numberValue(argv, name) {
  const raw = value(argv, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`)
  return n
}

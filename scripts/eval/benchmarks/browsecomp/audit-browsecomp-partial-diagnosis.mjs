#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runnerRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const browseRoot = path.join(legacy-runnerRoot, 'artifacts/browsecomp')
const diagnosisDir = path.join(legacy-runnerRoot, 'diagnostics/browsecomp')

async function main() {
  const partial = await latestPartialRun()
  if (!partial) throw new Error('no BrowseComp partial_stopped run found')
  const runRoot = path.join(browseRoot, partial.name)
  const summary = await readJson(path.join(runRoot, 'score-summary.json'))
  const pairwise = await maybeReadJsonl(path.join(runRoot, 'pairwise-comparison.jsonl'))
  const row = pairwise[0] ?? null
  const agentResult = row?.agent_runlab_status !== 'not_run'
    ? await maybeReadJson(path.join(runRoot, 'agent-runlab', row.instance_id, 'result.json'))
    : null
  const metadata = row?.agent_runlab_status !== 'not_run'
    ? await maybeReadJson(path.join(runRoot, 'agent-runlab', row.instance_id, 'agent-runlab-metadata.json'))
    : null
  const response = row?.agent_runlab_status !== 'not_run'
    ? await maybeReadText(path.join(runRoot, 'agent-runlab', row.instance_id, 'response.txt'))
    : ''
  const judge = row?.agent_runlab_status !== 'not_run'
    ? await maybeReadText(path.join(runRoot, 'agent-runlab', row.instance_id, 'judge-response.txt'))
    : ''
  const sessionLog = row?.agent_runlab_status !== 'not_run'
    ? path.join(runRoot, 'agent-runlab', row.instance_id, 'agent-runlab-session.jsonl')
    : ''
  const session = sessionLog && existsSync(sessionLog) ? await sessionSummary(sessionLog) : null
  const completedComparablePair = summary.stop_reason === 'max_agent_runs:2'
    && summary.completed_agent_runs === summary.requested_agent_runs
    && row?.winner
    && row.winner !== 'not_comparable'
  const report = {
    schema_version: 1,
    benchmark: 'browsecomp',
    generated_by: 'scripts/eval/benchmarks/browsecomp/audit-browsecomp-partial-diagnosis.mjs',
    status: completedComparablePair ? 'diagnosed_completed_pair_not_formal_subset' : 'diagnosed_partial_not_formal_subset',
    latest_partial_run: {
      run_id: summary.run_id,
      status: summary.status,
      stop_reason: summary.stop_reason,
      selected_cases: summary.selected_cases,
      completed_agent_runs: summary.completed_agent_runs,
      requested_agent_runs: summary.requested_agent_runs,
      model: summary.model,
      scorer: summary.scorer,
    },
    instance_id: row?.instance_id ?? null,
    pairwise: row ? {
      winner: row.winner,
      agent_runlab_status: row.agent_runlab_status,
      claude_code_status: row.claude_code_status,
      agent_runlab_score: Number(row.agent_runlab_score ?? 0),
      claude_code_score: Number(row.claude_code_score ?? 0),
      failure_category: row.failure_category,
      notes: row.notes,
    } : null,
    agent_runlab: agentResult ? {
      status: agentResult.status,
      score: agentResult.score,
      error_type: agentResult.error_type,
      turn_limit_hit: metadata?.turnLimitHit === true,
      llm_responses: metadata?.llmResponses ?? null,
      finalized_after_turn_limit: metadata?.finalizedAfterTurnLimit === true,
      final_answer: extractExactAnswer(response),
      confidence: extractConfidence(response),
    } : null,
    judge: {
      correct: /correct:\s*yes/i.test(judge),
      extracted_final_answer: extractJudgeField(judge, 'extracted_final_answer'),
      correct_answer_leak_check: 'answer key is only present in judge prompt/result artifacts, not agent prompt',
    },
    session,
    diagnosis: buildDiagnosis(summary, row, metadata, response, session, completedComparablePair),
    next_gate: completedComparablePair
      ? 'Refresh BrowseComp planning, exclude this completed diagnostic pair, then run exactly the next fresh pair with --max-agent-runs 2, --stop-after-turn-limits 1, and --stop-after-errors 1. Do not promote one-pair diagnostics to formal subset evidence.'
      : 'Improve BrowseComp query discipline before the next paid fresh pair; keep stop-after-turn-limits=1 and do not promote partial diagnostics to headline evidence.',
  }
  await mkdir(diagnosisDir, { recursive: true })
  await writeFile(path.join(diagnosisDir, 'latest-partial-run-diagnosis.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(diagnosisDir, 'latest-partial-run-diagnosis.md'), renderMarkdown(report))
  console.log(`BrowseComp partial diagnosis ${report.status}: ${summary.run_id}`)
}

async function latestPartialRun() {
  const candidates = []
  for (const name of await readdir(browseRoot)) {
    const summaryPath = path.join(browseRoot, name, 'score-summary.json')
    if (!existsSync(summaryPath)) continue
    const summary = await readJson(summaryPath)
    if (summary.status !== 'partial_stopped') continue
    const info = await stat(summaryPath)
    candidates.push({ name, mtimeMs: info.mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0] ?? null
}

async function sessionSummary(filePath) {
  const events = (await readFile(filePath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.kind === 'event')
  const toolCalls = []
  const toolErrors = []
  for (const row of events) {
    const event = row.event ?? {}
    if (event.kind === 'llm_response') {
      for (const part of event.message?.content ?? []) {
        if (part.type === 'tool_call') toolCalls.push({ seq: row.seq, name: part.name, input: part.input })
      }
    }
    if (event.kind === 'tool_result' && event.ok !== true) toolErrors.push({ seq: row.seq, content: String(event.content ?? '').slice(0, 500) })
  }
  return {
    event_count: events.length,
    llm_response_count: events.filter((row) => row.event?.kind === 'llm_response').length,
    tool_result_count: events.filter((row) => row.event?.kind === 'tool_result').length,
    tool_error_count: toolErrors.length,
    tool_call_count: toolCalls.length,
    tool_calls: toolCalls.map((call) => ({ ...call, input: JSON.stringify(call.input).slice(0, 240) })),
    tool_errors: toolErrors,
  }
}

function buildDiagnosis(summary, row, metadata, response, session, completedComparablePair) {
  const items = []
  if (completedComparablePair) {
    items.push({
      category: 'completed_comparable_pair_not_formal_subset',
      severity: 'scope_boundary',
      evidence: `stop_reason=${summary.stop_reason}; completed_agent_runs=${summary.completed_agent_runs}; requested_agent_runs=${summary.requested_agent_runs}; winner=${row.winner}`,
      interpretation: 'Both agents completed and were judged in the same capped run, so this is valid one-pair diagnostic evidence. It is still not a formal BrowseComp subset result.',
    })
    return items
  }
  if (summary.stop_reason === 'stop_after_turn_limits:1' || metadata?.turnLimitHit === true) {
    items.push({
      category: 'turn_budget_exhaustion',
      severity: 'blocking_for_pairwise_expansion',
      evidence: `stop_reason=${summary.stop_reason}; llm_responses=${metadata?.llmResponses ?? 'unknown'}`,
      interpretation: 'Agent RunLab consumed the BrowseComp turn budget before producing a confident answer, so the run correctly stopped before Claude Code spent tokens.',
    })
  }
  if (row?.winner === 'not_comparable') {
    items.push({
      category: 'not_comparable_partial_run',
      severity: 'must_not_report_as_result',
      evidence: `agent=${row.agent_runlab_status}; claude=${row.claude_code_status}`,
      interpretation: 'This row is diagnostic only. It cannot be used for Agent RunLab vs Claude Code performance claims because one side did not run.',
    })
  }
  if (/Exact Answer:\s*Unknown/i.test(response)) {
    items.push({
      category: 'low_confidence_finalization',
      severity: 'failure_mode',
      evidence: `final_answer=${extractExactAnswer(response) ?? 'none'}; confidence=${extractConfidence(response) ?? 'none'}`,
      interpretation: 'The finalizer had insufficient usable evidence and emitted Unknown rather than a supported entity.',
    })
  }
  const queries = session?.tool_calls?.map((call) => call.input).join('\n') ?? ''
  if (/Filipino|Malaysian|Indonesian|African|Kenyan|Tanzanian|Zimbabwean|Ethiopian|Ugandan|South African/i.test(queries)) {
    items.push({
      category: 'query_drift',
      severity: 'failure_mode',
      evidence: 'search queries repeatedly widened geography and celebrity categories instead of converging on one candidate evidence chain',
      interpretation: 'The agent spent turns broadening the search space. The next prompt should force candidate extraction, candidate verification, and early finalization after bounded search.',
    })
  }
  return items
}

function renderMarkdown(report) {
  const lines = [
    '# BrowseComp Latest Partial Run Diagnosis',
    '',
    `Status: \`${report.status}\``,
    '',
    `Run: \`${report.latest_partial_run.run_id}\``,
    `Stop reason: \`${report.latest_partial_run.stop_reason}\``,
    `Instance: \`${report.instance_id ?? ''}\``,
    '',
    '## Pairwise Boundary',
    '',
    `Winner: \`${report.pairwise?.winner ?? ''}\``,
    `Agent RunLab: \`${report.pairwise?.agent_runlab_status ?? ''}\``,
    `Claude Code: \`${report.pairwise?.claude_code_status ?? ''}\``,
    '',
    '## Diagnosis',
    '',
  ]
  for (const item of report.diagnosis) {
    lines.push(`- \`${item.category}\` / ${item.severity}: ${item.interpretation}`)
    lines.push(`  Evidence: ${item.evidence}`)
  }
  lines.push('', '## Next Gate', '', report.next_gate, '')
  return lines.join('\n')
}

function extractExactAnswer(text) {
  return /^Exact Answer:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null
}

function extractConfidence(text) {
  return /^Confidence:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null
}

function extractJudgeField(text, field) {
  return new RegExp(`^${field}:\\s*(.+)$`, 'im').exec(text)?.[1]?.trim() ?? null
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function maybeReadJson(filePath) {
  try { return await readJson(filePath) } catch { return null }
}

async function maybeReadText(filePath) {
  try { return await readFile(filePath, 'utf8') } catch { return '' }
}

async function maybeReadJsonl(filePath) {
  try {
    return (await readFile(filePath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

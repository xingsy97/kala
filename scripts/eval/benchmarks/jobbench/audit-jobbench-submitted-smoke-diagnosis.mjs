#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runnerRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const jobRoot = path.join(legacy-runnerRoot, 'artifacts/job-bench')
const jobReportRoot = path.join(legacy-runnerRoot, 'reports/jobbench')
const diagnosisDir = path.join(legacy-runnerRoot, 'diagnostics/jobbench')

async function main() {
  const latest = await readJson(path.join(jobReportRoot, 'latest-run-summary.json'))
  const preflight = await readJson(path.join(jobRoot, 'judge-preflight/preflight-summary.json'))
  const runRoot = path.join(legacy-runnerRoot, latest.run_root)
  const pairwise = await readJsonl(path.join(runRoot, 'pairwise-comparison.jsonl'))
  const row = pairwise[0]
  if (!row) throw new Error('no JobBench pairwise row found')
  const instanceId = row.instance_id
  const agent = await agentSummary(runRoot, 'agent-runlab', instanceId)
  const claude = await agentSummary(runRoot, 'claude-code', instanceId)
  const report = {
    schema_version: 1,
    benchmark: 'job-bench',
    generated_by: 'scripts/eval/benchmarks/jobbench/audit-jobbench-submitted-smoke-diagnosis.mjs',
    status: 'diagnosed_submitted_unscored_not_ready_for_scored_subset',
    latest_run: {
      run_id: latest.run_id,
      status: latest.status,
      split: latest.split,
      selected_cases: latest.selected_cases,
      completed_agent_runs: latest.completed_agent_runs,
      model: latest.model,
      judge_model: latest.judge_model,
      scorer: latest.scorer,
      official: latest.official,
    },
    instance_id: instanceId,
    pairwise: {
      winner: row.winner,
      agent_runlab_status: row.agent_runlab_status,
      claude_code_status: row.claude_code_status,
      agent_runlab_score: null,
      claude_code_score: null,
      failure_category: row.failure_category,
      notes: row.notes,
    },
    agents: {
      'agent-runlab': agent,
      'claude-code': claude,
    },
    judge_preflight: {
      status: preflight.status,
      evaluator_commit: preflight.evaluator?.commit ?? null,
      rubric_count: preflight.dataset?.rubric_count ?? null,
      model_output_count: preflight.dataset?.model_outputs?.length ?? 0,
      valid_score_present: preflight.valid_score_present === true,
      invalid_attempt_count: preflight.invalid_attempts?.length ?? 0,
      invalid_attempts: (preflight.invalid_attempts ?? []).map((attempt) => ({
        validator_version: attempt.validator_version,
        valid: attempt.valid,
        evaluated_model: attempt.evaluated_model,
        judge_model: attempt.judge_model,
        normalized_score: attempt.normalized_score,
        first_invalid_reason: attempt.first_invalid_reason,
        validation_file: rel(attempt.validation_file),
      })),
    },
    diagnosis: buildDiagnosis({ latest, row, preflight, agent, claude }),
    next_gate: 'Provide a judge API key, run exactly one official judged smoke for both submitted outputs, validate both judge JSON files with validate-jobbench-judge-result.mjs --fail-invalid, and only then consider a small judged subset.',
    required_next_evidence: [
      'one valid judge JSON for Agent RunLab with validator_version=2 and valid=true',
      'one valid judge JSON for Claude Code with validator_version=2 and valid=true',
      'normalized rubric scores copied into JobBench instance-results.jsonl and pairwise-comparison.jsonl',
      'failure-analysis.md updated with rubric-level pass/fail differences',
      'latest-run-summary.json scorer changed only after valid scores exist',
    ],
  }
  await mkdir(diagnosisDir, { recursive: true })
  await writeFile(path.join(diagnosisDir, 'latest-submitted-smoke-diagnosis.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(diagnosisDir, 'latest-submitted-smoke-diagnosis.md'), renderMarkdown(report))
  console.log(`JobBench submitted-smoke diagnosis ${report.status}`)
}

async function agentSummary(runRoot, agent, instanceId) {
  const caseRoot = path.join(runRoot, agent, instanceId)
  const manifest = await readJson(path.join(caseRoot, 'deliverables-manifest.json'))
  const result = await readJson(path.join(caseRoot, 'result.json'))
  const metadata = agent === 'agent-runlab'
    ? await maybeReadJson(path.join(caseRoot, 'agent-runlab-metadata.json'))
    : null
  const sdkResult = agent === 'claude-code'
    ? await maybeReadJson(path.join(caseRoot, 'claude-code-artifacts/claude-agent-sdk.result.json'))
    : null
  return {
    status: result.status ?? null,
    score_claimed: null,
    deliverable_count: manifest.files?.length ?? 0,
    deliverables: (manifest.files ?? []).map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    })),
    response_artifact: rel(path.join(caseRoot, 'response.txt')),
    prompt_artifact: rel(path.join(caseRoot, 'prompt.txt')),
    deliverables_manifest: rel(path.join(caseRoot, 'deliverables-manifest.json')),
    workspace_root: rel(manifest.workspace_root),
    llm_response_count: metadata?.llm_response_count ?? null,
    tool_result_count: metadata?.tool_result_count ?? null,
    terminal_reason: sdkResult?.result?.terminal_reason ?? sdkResult?.result?.subtype ?? null,
    num_turns: sdkResult?.result?.num_turns ?? null,
    total_cost_usd: sdkResult ? Number(sdkResult.result?.total_cost_usd ?? 0) : null,
  }
}

function buildDiagnosis({ latest, row, preflight, agent, claude }) {
  const items = []
  if (latest.status === 'submitted_unscored' && row.winner === 'not_comparable') {
    items.push({
      component: 'legacy-runner_evidence_level',
      category: 'submitted_unscored_boundary',
      severity: 'blocking_for_score_claims',
      evidence: `run status=${latest.status}; pairwise winner=${row.winner}; scorer=${latest.scorer}`,
      interpretation: 'The smoke proves both systems can receive the JobBench task and submit deliverables, but it does not prove either system solved the benchmark case.',
    })
  }
  if (agent.deliverable_count > 0 && claude.deliverable_count > 0) {
    items.push({
      component: 'agent_outputs',
      category: 'deliverables_archived',
      severity: 'positive_artifact_signal',
      evidence: `Agent RunLab deliverables=${agent.deliverable_count}; Claude Code deliverables=${claude.deliverable_count}`,
      interpretation: 'Both systems produced archived outputs, so the next useful evidence is rubric judging rather than another unscored submission smoke.',
    })
  }
  if (preflight.status === 'blocked_missing_judge_key') {
    items.push({
      component: 'jobbench_judge',
      category: 'credential_gate',
      severity: 'blocking_for_native_score',
      evidence: `preflight status=${preflight.status}; visible_env_vars=${(preflight.credentials?.visible_env_vars ?? []).join(',') || 'none'}`,
      interpretation: 'The official judge bridge is prepared, but no valid native score can be produced until a judge credential is available.',
    })
  }
  if ((preflight.invalid_attempts ?? []).length) {
    items.push({
      component: 'jobbench_judge',
      category: 'invalid_infrastructure_attempts',
      severity: 'must_not_report_as_score',
      evidence: `${preflight.invalid_attempts.length} invalid attempt(s), first reason: ${preflight.invalid_attempts[0]?.first_invalid_reason ?? 'unknown'}`,
      interpretation: 'The archived zero-like judge outputs are infrastructure failures. They are useful debugging evidence but must not be counted as benchmark results.',
    })
  }
  return items
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

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function rel(filePath) {
  if (!filePath) return ''
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(legacy-runnerRoot, filePath)
  return path.relative(legacy-runnerRoot, absolute).replaceAll(path.sep, '/')
}

function renderMarkdown(report) {
  const lines = [
    '# JobBench Submitted Smoke Diagnosis',
    '',
    `Status: \`${report.status}\``,
    '',
    `Run: \`${report.latest_run.run_id}\``,
    `Instance: \`${report.instance_id}\``,
    `Pairwise: \`${report.pairwise.winner}\`; scores are intentionally unset because no valid judge result exists.`,
    '',
    '## Agent Outputs',
    '',
    '| Agent | Status | Deliverables | LLM turns / responses | Cost |',
    '|---|---|---:|---:|---:|',
    `| Agent RunLab | ${report.agents['agent-runlab'].status ?? ''} | ${report.agents['agent-runlab'].deliverable_count} | ${report.agents['agent-runlab'].llm_response_count ?? ''} |  |`,
    `| Claude Code | ${report.agents['claude-code'].status ?? ''} | ${report.agents['claude-code'].deliverable_count} | ${report.agents['claude-code'].num_turns ?? ''} | ${report.agents['claude-code'].total_cost_usd ?? ''} |`,
    '',
    '## Judge State',
    '',
    `- Preflight: \`${report.judge_preflight.status}\``,
    `- Evaluator commit: \`${report.judge_preflight.evaluator_commit ?? ''}\``,
    `- Rubrics: ${report.judge_preflight.rubric_count}`,
    `- Model output directories: ${report.judge_preflight.model_output_count}`,
    `- Valid score present: ${report.judge_preflight.valid_score_present}`,
    `- Invalid attempts archived: ${report.judge_preflight.invalid_attempt_count}`,
    '',
    '## Diagnosis',
    '',
  ]
  for (const item of report.diagnosis) {
    lines.push(`- \`${item.component}\` / \`${item.category}\` / ${item.severity}: ${item.interpretation}`)
    lines.push(`  Evidence: ${item.evidence}`)
  }
  lines.push('', '## Next Gate', '', report.next_gate, '', 'Required evidence before scored subset expansion:', '')
  for (const item of report.required_next_evidence) lines.push(`- ${item}`)
  lines.push('')
  return lines.join('\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

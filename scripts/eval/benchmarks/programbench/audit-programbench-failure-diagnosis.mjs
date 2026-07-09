#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runnerRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const programRoot = path.join(legacy-runnerRoot, 'artifacts/program-bench')
const programReportRoot = path.join(legacy-runnerRoot, 'reports/programbench')
const diagnosisDir = path.join(legacy-runnerRoot, 'diagnostics/programbench')

async function main() {
  const latest = await readJson(path.join(programReportRoot, 'latest-run-summary.json'))
  const runRoot = path.join(legacy-runnerRoot, latest.run_root)
  const pairwise = await readJsonl(path.join(runRoot, 'pairwise-comparison.jsonl'))
  const comparable = pairwise.find((row) => row.winner !== 'not_comparable')
  if (!comparable) throw new Error('no comparable ProgramBench row found')
  const instanceId = comparable.instance_id
  const agent = await agentSummary(runRoot, 'agent-runlab', instanceId)
  const claude = await agentSummary(runRoot, 'claude-code', instanceId)
  const implementationQuality = await readImplementationQuality(runRoot, instanceId)
  const continuationProbe = await continuationProbeSummary(instanceId)
  const sameSessionPaidDiagnostic = await sameSessionPaidDiagnosticSummary()
  const entrypointDiagnosis = await maybeReadJson(path.join(diagnosisDir, 'latest-entrypoint-diagnosis.json'))
  const readiness = await readJson(path.join(diagnosisDir, 'pilot-readiness.json'))
  const report = {
    schema_version: 1,
    benchmark: 'program-bench',
    generated_by: 'scripts/eval/benchmarks/programbench/audit-programbench-failure-diagnosis.mjs',
    status: 'diagnosed_not_ready_for_5case_pilot',
    latest_run: {
      run_id: latest.run_id,
      status: latest.status,
      completed_agent_runs: latest.completed_agent_runs,
      stop_reason: latest.stop_reason,
      model: latest.model,
      scorer: latest.scorer,
    },
    instance_id: instanceId,
    pairwise: {
      winner: comparable.winner,
      agent_runlab_status: comparable.agent_runlab_status,
      claude_code_status: comparable.claude_code_status,
      agent_runlab_score: Number(comparable.agent_runlab_score),
      claude_code_score: Number(comparable.claude_code_score),
      failure_category: comparable.failure_category,
      notes: comparable.notes,
    },
    agents: {
      'agent-runlab': agent,
      'claude-code': claude,
    },
    implementation_quality: implementationQuality,
    continuation_probe: continuationProbe,
    same_session_paid_diagnostic: sameSessionPaidDiagnostic,
    entrypoint_diagnosis: entrypointDiagnosis
      ? {
          status: entrypointDiagnosis.status,
          agent_runlab_source_files: entrypointDiagnosis.agents?.['agent-runlab']?.source_files ?? [],
          claude_code_source_files: entrypointDiagnosis.agents?.['claude-code']?.source_files ?? [],
          agent_runlab_prompt: entrypointDiagnosis.agents?.['agent-runlab']?.repair_prompt_preview ?? null,
          claude_code_prompt: entrypointDiagnosis.agents?.['claude-code']?.repair_prompt_preview ?? null,
        }
      : null,
    diagnosis: buildDiagnosis(agent, claude, continuationProbe, sameSessionPaidDiagnostic, implementationQuality),
    next_gate: buildNextGate(agent, claude, readiness, implementationQuality),
    required_next_evidence: buildRequiredNextEvidence(agent, claude),
  }
  await mkdir(diagnosisDir, { recursive: true })
  await writeFile(path.join(diagnosisDir, 'latest-failure-diagnosis.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(diagnosisDir, 'latest-failure-diagnosis.md'), renderMarkdown(report))
  console.log(`ProgramBench failure diagnosis ${report.status}`)
}

function buildNextGate(agent, claude, readiness, implementationQuality) {
  const artifactContractFailed = [agent, claude].some((item) => item.contract_ok !== true)
  if (artifactContractFailed) {
    return 'Do not expand to the 5-case pilot yet. The latest capped pair still failed the artifact contract before compile repair could apply. The next work is artifact-contract completion control for both systems under the same max-agent-runs=2 capped validation shape, not broader subset expansion.'
  }
  const compileFailed = [agent, claude].some((item) => item.compile_probe?.ok === false || item.native_eval_summary?.primary_error_code === 'compile_failed')
  if (compileFailed) {
    const compileGateReady = [agent, claude].some((item) => item.compile_repair_gate?.action === 'continue_compile_repair')
    const compileLoopReady = readiness.evidence_summary?.mechanism_readiness?.compile_repair_loop_dry_run === true
    return compileGateReady && compileLoopReady
      ? 'Do not expand to the 5-case pilot yet. The latest capped pair reached native scoring, compile-repair gate evidence exists, and the bounded compile-repair loop is dry-run validated. The next paid ProgramBench step should be exactly one monitored capped pair with bounded compile repair enabled, not a broader subset.'
      : compileGateReady
        ? 'Do not expand to the 5-case pilot yet. The latest capped pair reached native scoring and compile-repair gate evidence exists, but the bounded compile-repair loop still needs dry-run validation before another paid pair.'
      : 'Do not expand to the 5-case pilot yet. The latest capped pair reached native scoring, but native eval reported compile_failed. Add a no-model compile probe and bounded compile-repair classification before another paid ProgramBench expansion.'
  }
  if (implementationQuality.some((item) => item.blocking === true)) {
    return 'Do not expand to the 5-case pilot yet. The latest capped pair passed the artifact and compile probes only through runner bootstrap scaffolding; both systems ended with promise-like implementation responses and inactivity/abort while main.c remained the placeholder scaffold. The implementation write-through guard is now implemented and no-model validated; the next paid ProgramBench step is exactly one monitored capped pair with that guard active before any broader spend.'
  }
  return readiness.recommendation?.next_allowed_step ?? 'Re-run ProgramBench readiness audit before any spend.'
}

function buildRequiredNextEvidence(agent, claude) {
  const items = [
    'one monitored Agent RunLab / Claude Code pair only before any subset expansion',
    'same-session Agent RunLab contract continuation enabled',
    'native-eval timeout guard enabled',
    'max-agent-runs=2 stop gate preserved',
    'native eval result must be bounded and archived for both systems',
  ]
  if ([agent, claude].some((item) => item.contract_ok !== true)) {
    items.unshift('artifact contract must be satisfied before compile repair can apply')
  } else if ([agent, claude].some((item) => item.compile_probe?.ok === false || item.native_eval_summary?.primary_error_code === 'compile_failed')) {
    items.unshift('no-model compile probe must classify compile_failed before the next paid run')
    if (agent.compile_repair_gate?.action === 'continue_compile_repair' || claude.compile_repair_gate?.action === 'continue_compile_repair') {
      items.unshift('bounded compile-repair loop must stay enabled in the next capped paid pair')
    } else {
      items.unshift('bounded compile-repair path must be dry-run validated')
    }
  } else {
    items.unshift('implementation write-through guard must remain active and stop scaffold-only submissions')
  }
  if (agent.contract_ok !== true) items.push('Agent RunLab submission-contract-gate.json must be ok=true before any 5-case expansion')
  if (claude.contract_ok !== true) items.push('Claude Code submission-contract-gate.json must be ok=true before any 5-case expansion')
  return items
}

async function agentSummary(runRoot, agent, instanceId) {
  const caseRoot = path.join(runRoot, agent, instanceId)
  const contract = await readJson(path.join(caseRoot, 'submission-contract.json'))
  const gate = await readJson(path.join(caseRoot, 'submission-contract-gate.json'))
  const nativeScore = await readJson(path.join(caseRoot, 'native-score.json'))
  const manifest = await readJson(path.join(caseRoot, 'run-manifest.json'))
  const compileProbe = await maybeReadJson(path.join(caseRoot, 'compile-probe.json'))
  const compileRepairGate = await maybeReadJson(path.join(caseRoot, 'compile-repair-gate.json'))
  const sdkResult = agent === 'claude-code'
    ? await maybeReadJson(path.join(caseRoot, 'claude-code-artifacts/claude-agent-sdk.result.json'))
    : null
  return {
    contract_ok: contract.ok === true,
    contract_reason_codes: contract.reason_codes ?? [],
    contract_required_actions: contract.required_actions ?? [],
    source_file_count: contract.source_file_count ?? 0,
    source_files: contract.source_files ?? [],
    implementation_file_count: implementationFiles(contract).length,
    implementation_files: implementationFiles(contract),
    compile_sh_exists: contract.checks?.compile_sh_exists === true,
    compile_sh_executable: contract.checks?.compile_sh_executable === true,
    gate_ok: gate.ok === true,
    gate_policy: gate.native_eval_policy ?? null,
    native_score: Number(nativeScore.score ?? 0),
    native_scorer: nativeScore.scorer ?? null,
    eval_json: rel(nativeScore.eval_json ?? manifest.eval_json ?? ''),
    native_eval_summary: await nativeEvalSummary(nativeScore.eval_json),
    compile_probe: compileProbe
      ? {
          ok: compileProbe.ok === true,
          status: compileProbe.status ?? null,
          reason_codes: compileProbe.reason_codes ?? [],
          exit_code: compileProbe.exit_code ?? null,
          stderr_preview: String(compileProbe.stderr ?? '').trim().slice(0, 500),
        }
      : null,
    compile_repair_gate: compileRepairGate
      ? {
          classification: compileRepairGate.compile_repair_control?.classification ?? null,
          action: compileRepairGate.compile_repair_control?.action ?? null,
          prompt: compileRepairGate.prompt ?? null,
          next_action: compileRepairGate.next_action ?? null,
        }
      : null,
    workspace_root: manifest.workspace_root ?? null,
    submission_archive: manifest.submission_archive ?? null,
    terminal_reason: sdkResult?.result?.terminal_reason ?? sdkResult?.result?.subtype ?? null,
    total_cost_usd: sdkResult ? Number(sdkResult.result?.total_cost_usd ?? 0) : null,
    num_turns: sdkResult?.result?.num_turns ?? null,
  }
}

async function continuationProbeSummary(instanceId) {
  const runId = 'programbench-sonnet-monitored-pair-contract-continuation-1'
  const runRoot = path.join(programRoot, runId)
  const summary = await maybeReadJson(path.join(runRoot, 'agent-runlab', instanceId, 'contract-continuation-summary.json'))
  const stoppedNote = path.join(runRoot, 'native-eval-stopped.md')
  if (!summary && !(await exists(stoppedNote))) return null
  return {
    run_id: runId,
    completed_scored_pair: false,
    agent_runlab_attempted_continuations: summary?.attempted ?? null,
    agent_runlab_final_ok: summary?.final_ok ?? null,
    agent_runlab_final_reason_codes: summary?.final_reason_codes ?? [],
    agent_runlab_stopped_after_no_progress: summary?.stopped_after_no_progress ?? inferStoppedAfterNoProgress(summary),
    agent_runlab_final_progress_classification: summary?.final_progress_classification ?? inferFinalProgressClassification(summary),
    native_eval_stopped_note: (await exists(stoppedNote)) ? rel(stoppedNote) : null,
  }
}

async function sameSessionPaidDiagnosticSummary() {
  const runId = 'programbench-sonnet-monitored-pair-same-session-continuation-1'
  const runRoot = path.join(programRoot, runId)
  const summary = await maybeReadJson(path.join(runRoot, 'aborted-run-summary.json'))
  if (!summary) return null
  return {
    run_id: runId,
    status: summary.status,
    reporting_boundary: summary.reporting_boundary,
    agent_runlab_final_ok: summary.agent_runlab?.contract_final_ok ?? null,
    agent_runlab_final_reason_codes: summary.agent_runlab?.contract_final_reason_codes ?? [],
    agent_runlab_source_file_count: summary.agent_runlab?.source_file_count ?? null,
    agent_runlab_progress_classification: summary.agent_runlab?.contract_final_ok === true
      ? 'contract_satisfied'
      : Number(summary.agent_runlab?.source_file_count ?? 0) > 0
        ? 'progress_but_contract_failed'
        : 'no_progress',
    claude_code_runner_completed: summary.claude_code?.runner_completed ?? null,
    claude_code_workspace_artifacts_present_at_abort: summary.claude_code?.workspace_artifacts_present_at_abort ?? [],
    evidence: rel(path.join(runRoot, 'aborted-run-summary.json')),
  }
}

function buildDiagnosis(agent, claude, continuationProbe, sameSessionPaidDiagnostic, implementationQuality) {
  const items = []
  if (!agent.contract_ok) {
    items.push({
      component: 'agent-runlab',
      category: 'artifact_contract_failure',
      severity: 'blocking',
      evidence: `contract ok=false; reason_codes=${agent.contract_reason_codes.join(',') || 'none'}; source_file_count=${agent.source_file_count}; implementation_file_count=${agent.implementation_file_count}`,
      interpretation: 'Agent RunLab ended with a judgeable native score of zero, but the primary failure is earlier: the submitted workspace did not satisfy the minimum ProgramBench artifact contract.',
    })
  } else if (agent.compile_probe?.ok === false || agent.native_eval_summary?.primary_error_code === 'compile_failed') {
    items.push({
      component: 'agent-runlab',
      category: 'compile_failure_after_artifact_contract',
      severity: 'blocking',
      evidence: `contract ok=true; compile_probe=${agent.compile_probe?.status ?? 'missing'}; native_score=${agent.native_score}; primary_error_code=${agent.native_eval_summary.primary_error_code}; error_codes=${formatCounts(agent.native_eval_summary.error_codes)}`,
      interpretation: 'Agent RunLab reached a later stage than the previous missing-artifact failure: it produced the required ProgramBench files, but the submitted implementation did not compile under the native evaluator.',
    })
  }
  if (!claude.contract_ok) {
    items.push({
      component: 'claude-code',
      category: 'artifact_contract_failure',
      severity: 'blocking',
      evidence: `contract ok=false; reason_codes=${claude.contract_reason_codes.join(',') || 'none'}; source_file_count=${claude.source_file_count}; implementation_file_count=${claude.implementation_file_count}; native_score=${claude.native_score}; terminal_reason=${claude.terminal_reason ?? 'none'}`,
      interpretation: 'In the latest capped pair, Claude Code also failed before satisfying the minimum ProgramBench artifact contract. The inactivity guard prevented an unbounded stall, but the submitted workspace still lacked compile.sh.',
    })
  } else if (claude.compile_probe?.ok === false || claude.native_eval_summary?.primary_error_code === 'compile_failed') {
    items.push({
      component: 'claude-code',
      category: 'compile_failure_after_artifact_contract',
      severity: 'blocking',
      evidence: `contract ok=true; source_file_count=${claude.source_file_count}; compile_probe=${claude.compile_probe?.status ?? 'missing'}; native_score=${claude.native_score}; primary_error_code=${claude.native_eval_summary.primary_error_code}; terminal_reason=${claude.terminal_reason ?? 'none'}`,
      interpretation: 'Claude Code produced the minimum artifacts, but the native evaluator reported compile_failed. This is an implementation/build failure rather than a missing-artifact failure.',
    })
  }
  if (continuationProbe?.agent_runlab_final_ok === false) {
    items.push({
      component: 'agent-runlab',
      category: 'completion_control_failure_after_continuation',
      severity: 'blocking',
      evidence: `continuation_attempts=${continuationProbe.agent_runlab_attempted_continuations}; final_reason_codes=${continuationProbe.agent_runlab_final_reason_codes.join(',')}; final_progress=${continuationProbe.agent_runlab_final_progress_classification}; stopped_after_no_progress=${continuationProbe.agent_runlab_stopped_after_no_progress}`,
      interpretation: 'The older continuation probe shows that merely asking for repair did not force Agent RunLab to produce required files. The next paid test must validate the newer same-session continuation mechanism, not expand the case count.',
    })
  }
  if (sameSessionPaidDiagnostic?.status === 'manually_aborted_diagnostic') {
    items.push({
      component: 'agent-runlab',
      category: 'same_session_continuation_partial_improvement',
      severity: 'blocking',
      evidence: `run=${sameSessionPaidDiagnostic.run_id}; final_ok=${sameSessionPaidDiagnostic.agent_runlab_final_ok}; reason_codes=${sameSessionPaidDiagnostic.agent_runlab_final_reason_codes.join(',')}; source_file_count=${sameSessionPaidDiagnostic.agent_runlab_source_file_count}; progress=${sameSessionPaidDiagnostic.agent_runlab_progress_classification}`,
      interpretation: 'The same-session paid diagnostic proved the repair loop runs in the original session and improved source artifact creation, but Agent RunLab still missed the required compile.sh entrypoint.',
    })
    items.push({
      component: 'claude-code',
      category: 'interrupted_comparator_evidence',
      severity: 'not_scoreable',
      evidence: `run=${sameSessionPaidDiagnostic.run_id}; runner_completed=${sameSessionPaidDiagnostic.claude_code_runner_completed}; artifacts=${sameSessionPaidDiagnostic.claude_code_workspace_artifacts_present_at_abort.join(',')}`,
      interpretation: 'Claude Code produced minimum-looking artifacts before interruption, but the runner did not complete packaging, contract inspection, or native eval, so no score should be claimed.',
    })
  }
  for (const item of implementationQuality.filter((entry) => entry.blocking === true)) {
    items.push({
      component: item.agent,
      category: 'implementation_write_through_failure',
      severity: 'blocking',
      evidence: `bootstrapped=${item.bootstrapped}; placeholder_implementation=${item.placeholder_implementation}; final_response_promises_implementation=${item.final_response_promises_implementation}; inactivity_or_abort=${item.inactivity_or_abort}`,
      interpretation: 'The runner-created compile.sh/main.c allowed contract and compile probes to pass, but the agent did not replace the placeholder implementation before stopping. The native score is scaffold baseline evidence, not a meaningful ProgramBench result.',
    })
  }
  return items
}

async function readImplementationQuality(runRoot, instanceId) {
  const rows = []
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
      bootstrapped,
      placeholder_implementation: placeholder,
      final_response_promises_implementation: promises,
      inactivity_or_abort: inactive,
      category: blocking ? 'implementation_write_through_failure' : 'implementation_evidence_not_blocking',
      blocking,
    })
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

async function nativeEvalSummary(evalJsonPath) {
  const evalJson = evalJsonPath ? await maybeReadJson(evalJsonPath) : null
  const statuses = {}
  const errorCodes = {}
  for (const result of evalJson?.test_results ?? []) {
    const status = result.status ?? 'unknown'
    statuses[status] = (statuses[status] ?? 0) + 1
    const code = result.extra?.error_code
    if (code) errorCodes[code] = (errorCodes[code] ?? 0) + 1
  }
  const primaryErrorCode = Object.entries(errorCodes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return {
    primary_error_code: primaryErrorCode,
    error_codes: errorCodes,
    statuses,
  }
}

function formatCounts(counts) {
  return Object.entries(counts ?? {}).map(([key, value]) => `${key}:${value}`).join(',') || 'none'
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
  const implementationDelta = implementationFiles(after).length - implementationFiles(before).length
  if (resolved.length || implementationDelta > 0) return 'progress'
  if (added.length || implementationDelta < 0) return 'regression'
  return 'no_progress'
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

async function exists(filePath) {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}

function rel(filePath) {
  if (!filePath) return ''
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(legacy-runnerRoot, filePath)
  return path.relative(legacy-runnerRoot, absolute).replaceAll(path.sep, '/')
}

function renderMarkdown(report) {
  const lines = [
    '# ProgramBench Latest Failure Diagnosis',
    '',
    `Status: \`${report.status}\``,
    '',
    `Run: \`${report.latest_run.run_id}\``,
    `Instance: \`${report.instance_id}\``,
    `Pairwise: \`${report.pairwise.winner}\`, Agent RunLab ${report.pairwise.agent_runlab_score}, Claude Code ${report.pairwise.claude_code_score}`,
    '',
    '## Agent Comparison',
    '',
    '| Agent | Contract | Source files | Implementation files | Native score | Terminal reason |',
    '|---|---|---:|---:|---:|---|',
    `| Agent RunLab | ${report.agents['agent-runlab'].contract_ok ? 'ok' : report.agents['agent-runlab'].contract_reason_codes.join(', ')} | ${report.agents['agent-runlab'].source_file_count} | ${report.agents['agent-runlab'].implementation_file_count} | ${report.agents['agent-runlab'].native_score} (${report.agents['agent-runlab'].native_eval_summary?.primary_error_code ?? 'no primary error'}; compile probe ${report.agents['agent-runlab'].compile_probe?.status ?? 'missing'}) | ${report.agents['agent-runlab'].terminal_reason ?? ''} |`,
    `| Claude Code | ${report.agents['claude-code'].contract_ok ? 'ok' : report.agents['claude-code'].contract_reason_codes.join(', ')} | ${report.agents['claude-code'].source_file_count} | ${report.agents['claude-code'].implementation_file_count} | ${report.agents['claude-code'].native_score} (${report.agents['claude-code'].native_eval_summary?.primary_error_code ?? 'no primary error'}; compile probe ${report.agents['claude-code'].compile_probe?.status ?? 'missing'}) | ${report.agents['claude-code'].terminal_reason ?? ''} |`,
    '',
    '## Diagnosis',
    '',
  ]
  for (const item of report.diagnosis) {
    lines.push(`- \`${item.component}\` / \`${item.category}\` / ${item.severity}: ${item.interpretation}`)
    lines.push(`  Evidence: ${item.evidence}`)
  }
  lines.push('', '## Compile Repair Gate', '')
  for (const [agent, info] of Object.entries(report.agents)) {
    const gate = info.compile_repair_gate
    lines.push(`- ${agent}: ${gate?.classification ?? 'missing'} -> ${gate?.action ?? 'missing'}${gate?.prompt ? `; prompt: \`${gate.prompt}\`` : ''}`)
  }
  if (report.entrypoint_diagnosis) {
    lines.push('', '## Entrypoint Diagnosis', '')
    lines.push('Source-file-aware repair prompt previews exist for the latest comparable Agent RunLab and Claude Code workspaces.')
    lines.push(`- Agent RunLab sources: ${report.entrypoint_diagnosis.agent_runlab_source_files.join(', ') || 'none'}`)
    lines.push(`- Claude Code sources: ${report.entrypoint_diagnosis.claude_code_source_files.join(', ') || 'none'}`)
    lines.push(`- Agent RunLab prompt: \`${report.entrypoint_diagnosis.agent_runlab_prompt}\``)
    lines.push(`- Claude Code prompt: \`${report.entrypoint_diagnosis.claude_code_prompt}\``)
  }
  lines.push('', '## Next Gate', '', report.next_gate, '', 'Required evidence before expansion:', '')
  for (const item of report.required_next_evidence) lines.push(`- ${item}`)
  lines.push('')
  return lines.join('\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

#!/usr/bin/env node
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const portfolioRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const programRoot = path.join(portfolioRoot, 'artifacts/program-bench')
const programReportRoot = path.join(portfolioRoot, 'reports/programbench')
const diagnosisDir = path.join(portfolioRoot, 'diagnostics/programbench')

async function main() {
  const latest = await readJson(path.join(programReportRoot, 'latest-run-summary.json'))
  const runRoot = path.join(portfolioRoot, latest.run_root)
  const pairwise = await readJsonl(path.join(runRoot, 'pairwise-comparison.jsonl'))
  const comparable = pairwise.find((row) => row.winner !== 'not_comparable')
  if (!comparable) throw new Error('no comparable ProgramBench row found')

  const agents = {}
  for (const agent of ['agent-runlab', 'claude-code']) {
    const caseRoot = path.join(runRoot, agent, comparable.instance_id)
    const contract = await readJson(path.join(caseRoot, 'submission-contract.json'))
    const continuation = await maybeReadJson(path.join(caseRoot, 'contract-continuation-summary.json'))
    const attempts = []
    for (const attempt of continuation?.attempts ?? []) {
      const responsePath = resolveArtifactPath(caseRoot, attempt.response)
      const responseText = await readFile(responsePath, 'utf8').catch(() => '')
      attempts.push({
        attempt: attempt.attempt,
        response: rel(responsePath),
        before: attempt.before,
        after: attempt.after,
        progress: attempt.progress,
        completion_control: classifyCompletionControl({
          contract: summaryToContract(attempt.after),
          progress: attempt.progress,
          responseText,
        }),
        response_preview: responseText.trim().slice(0, 240),
      })
    }
    const finalResponse = attempts.at(-1)?.response_preview ?? await readFile(path.join(caseRoot, 'response.txt'), 'utf8').catch(() => '')
    const implementationQuality = await readImplementationQuality(caseRoot, contract, finalResponse)
    agents[agent] = {
      contract_ok: contract.ok === true,
      reason_codes: contract.reason_codes ?? [],
      source_file_count: contract.source_file_count ?? 0,
      source_files: contract.source_files ?? [],
      implementation_file_count: implementationFiles(contract).length,
      implementation_files: implementationFiles(contract),
      implementation_quality: implementationQuality,
      completion_control: classifyCompletionControl({ contract: normalizeContract(contract), responseText: finalResponse, implementationQuality }),
      continuation_attempts: attempts,
    }
  }

  const blocking = Object.values(agents).some((agent) => agent.completion_control.classification !== 'contract_satisfied')
  const report = {
    schema_version: 1,
    benchmark: 'program-bench',
    generated_by: 'scripts/eval/benchmarks/programbench/audit-programbench-completion-control.mjs',
    status: blocking ? 'completion_control_blocking' : 'completion_control_clear',
    latest_run: {
      run_id: latest.run_id,
      run_root: latest.run_root,
      model: latest.model,
      scorer: latest.scorer,
    },
    instance_id: comparable.instance_id,
    agents,
    next_gate: blocking
      ? 'Completion-control now classifies missing required artifacts as unfinished and maps them to runner actions. Do not expand to the 5-case pilot; use the ProgramBench readiness gate for exactly one capped validation pair before any broader spend.'
      : 'Completion-control diagnostics are clear; a capped validation pair may be considered if other readiness gates pass.',
  }

  await mkdir(diagnosisDir, { recursive: true })
  await writeFile(path.join(diagnosisDir, 'latest-completion-control.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(diagnosisDir, 'latest-completion-control.md'), renderMarkdown(report))
  console.log(`ProgramBench completion control ${report.status}`)
}

function classifyCompletionControl(input) {
  const missing = missingRequiredArtifacts(input.contract)
  const promisesFiles = /\b(?:i\s+will|i'll|let\s+me|now\s+i\s+will|i\s+need\s+to)\b[^.\n]{0,120}\b(?:write|create|implement|add)\b/i.test(input.responseText)
    || /\b(?:write|create|implement|add)\b[^.\n]{0,120}\b(?:source|code|implementation|compile\.sh|files?)\b/i.test(input.responseText)
  if (input.implementationQuality?.blocking) return { classification: 'implementation_write_through_failure', action: 'stop_no_progress', unfinished: true, final_response_promises_files: promisesFiles, missing_required_artifacts: [], reason: 'minimum artifacts are present only because of runner bootstrap; the placeholder implementation was not replaced before inactivity/abort' }
  if (input.contract.ok) return { classification: 'contract_satisfied', action: 'accept_final', unfinished: false, final_response_promises_files: promisesFiles, missing_required_artifacts: [], reason: 'minimum ProgramBench submission contract is satisfied' }
  if (promisesFiles && input.progress?.classification === 'no_progress' && missing.length) return { classification: 'promise_without_artifacts', action: 'stop_no_progress', unfinished: true, final_response_promises_files: true, missing_required_artifacts: missing, reason: 'assistant promised file creation again but the continuation produced no required-artifact progress' }
  if (promisesFiles && missing.length) return { classification: 'promise_without_artifacts', action: 'continue_same_session', unfinished: true, final_response_promises_files: true, missing_required_artifacts: missing, reason: 'assistant final response promised file creation while required artifacts were still missing' }
  if (input.progress?.improved) return { classification: 'artifact_progress', action: 'continue_same_session', unfinished: true, final_response_promises_files: promisesFiles, missing_required_artifacts: missing, reason: 'contract improved but required artifacts are still missing' }
  return { classification: 'no_artifact_progress', action: 'stop_no_progress', unfinished: missing.length > 0, final_response_promises_files: promisesFiles, missing_required_artifacts: missing, reason: 'no required-artifact progress was detected' }
}

async function readImplementationQuality(caseRoot, contract, responseText) {
  const logText = await readCaseLogs(caseRoot)
  const mainText = await readFile(path.join(caseRoot, 'workspace/main.c'), 'utf8').catch(() => '')
  const bootstrapped = (contract.runner_normalizations ?? []).some((item) => item.kind === 'runner_bootstrap_submission_skeleton' && item.applied === true)
  const placeholder = isPlaceholderMain(mainText) && (contract.implementation_files ?? []).length === 1 && contract.implementation_files?.[0] === 'main.c'
  const promises = promisesImplementation(responseText)
  const inactive = /inactive for \d+ms|inactivityTimedOut"?:\s*true|process aborted by user/i.test(logText)
  const blocking = bootstrapped && placeholder && (promises || inactive)
  return {
    bootstrapped,
    placeholder_implementation: placeholder,
    final_response_promises_implementation: promises,
    inactivity_or_abort: inactive,
    blocking,
    category: blocking ? 'implementation_write_through_failure' : 'implementation_evidence_not_blocking',
  }
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

function missingRequiredArtifacts(contract) {
  const missing = []
  if (!normalizeContract(contract).checks?.source_files_present) missing.push('source_files')
  if (!contract.checks?.compile_sh_exists) missing.push('compile.sh')
  else if (!contract.checks?.compile_sh_executable) missing.push('compile.sh_executable')
  return missing
}

function summaryToContract(summary) {
  return normalizeContract({
    ok: summary.ok === true,
    checks: {
      source_files_present: implementationFiles(summary).length > 0,
      compile_sh_exists: !(summary.reason_codes ?? []).includes('missing_compile_sh'),
      compile_sh_executable: !(summary.reason_codes ?? []).includes('compile_sh_not_executable') && !(summary.reason_codes ?? []).includes('missing_compile_sh'),
    },
    source_file_count: summary.source_file_count ?? 0,
    source_files: summary.source_files ?? [],
    implementation_file_count: implementationFiles(summary).length,
    implementation_files: implementationFiles(summary),
    reason_codes: summary.reason_codes ?? [],
  })
}

function normalizeContract(contract) {
  const impl = implementationFiles(contract)
  const reasons = new Set(contract.reason_codes ?? [])
  if (impl.length === 0) reasons.add('missing_source_files')
  return {
    ...contract,
    ok: contract.ok === true && impl.length > 0,
    checks: {
      ...(contract.checks ?? {}),
      source_files_present: impl.length > 0,
      implementation_files_present: impl.length > 0,
      implementation_written_through_after_bootstrap: contract.checks?.implementation_written_through_after_bootstrap ?? !reasons.has('bootstrap_scaffold_not_replaced'),
    },
    implementation_file_count: impl.length,
    implementation_files: impl,
    reason_codes: [...reasons],
  }
}

function implementationFiles(contract) {
  const explicit = contract.implementation_files
  if (Array.isArray(explicit)) return explicit
  return (contract.source_files ?? []).filter((file) => isImplementationFile(String(file)))
}

function isImplementationFile(file) {
  const name = file.split('/').at(-1) ?? file
  if (name === 'Makefile') return true
  return /\.(c|cc|cpp|cxx|go|rs|sh|py|java|js|ts|mk)$/i.test(name)
}

function renderMarkdown(report) {
  const lines = [
    '# ProgramBench Completion-Control Diagnosis',
    '',
    `Status: \`${report.status}\``,
    `Run: \`${report.latest_run.run_id}\``,
    `Instance: \`${report.instance_id}\``,
    '',
    '| Agent | Contract | Source files | Implementation files | Final classification | Action | Missing artifacts |',
    '|---|---|---:|---:|---|---|---|',
  ]
  for (const [agent, info] of Object.entries(report.agents)) {
    lines.push(`| ${agent} | ${info.contract_ok ? 'ok' : info.reason_codes.join(',')} | ${info.source_file_count} | ${info.implementation_file_count} | \`${info.completion_control.classification}\` | \`${info.completion_control.action}\` | ${info.completion_control.missing_required_artifacts.join(', ') || ''} |`)
  }
  lines.push('', '## Attempt Details', '')
  for (const [agent, info] of Object.entries(report.agents)) {
    lines.push(`### ${agent}`, '')
    for (const attempt of info.continuation_attempts) {
      lines.push(`- Attempt ${attempt.attempt}: \`${attempt.completion_control.classification}\` -> \`${attempt.completion_control.action}\`; response: \`${attempt.response}\``)
      if (attempt.response_preview) lines.push(`  Preview: ${attempt.response_preview.replace(/\s+/g, ' ')}`)
    }
    if (!info.continuation_attempts.length) lines.push('- No continuation attempts recorded.')
    lines.push('')
  }
  lines.push('## Next Gate', '', report.next_gate, '')
  return lines.join('\n')
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function maybeReadJson(file) {
  try { return await readJson(file) } catch { return null }
}

async function readJsonl(file) {
  return (await readFile(file, 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
}

function rel(file) {
  return path.relative(portfolioRoot, file).replaceAll(path.sep, '/')
}

function resolveArtifactPath(caseRoot, artifactPath) {
  if (!artifactPath) return path.join(caseRoot, '')
  if (path.isAbsolute(artifactPath)) return artifactPath
  if (artifactPath.startsWith('artifacts/')) return path.join(portfolioRoot, artifactPath)
  return path.join(caseRoot, artifactPath)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

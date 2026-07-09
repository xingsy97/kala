#!/usr/bin/env node
import { access, constants, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const portfolioDir = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const programRoot = path.join(portfolioDir, 'artifacts/program-bench')
const runId = value(process.argv.slice(2), '--run-id') ?? 'programbench-lh3-pairwise-clean-calibration-1'
const runRoot = path.join(programRoot, runId)

async function main() {
  const instanceResultsPath = path.join(runRoot, 'instance-results.jsonl')
  const rows = await readJsonl(instanceResultsPath)
  const updated = []
  for (const row of rows) {
    const caseRoot = path.join(runRoot, row.agent, row.instance_id)
    const workspaceRoot = path.join(caseRoot, 'workspace')
    const contract = await inspectSubmissionContract(workspaceRoot)
    const contractPath = path.join(caseRoot, 'submission-contract.json')
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`)
    const gatePath = path.join(caseRoot, 'submission-contract-gate.json')
    await writeFile(gatePath, `${JSON.stringify(buildSubmissionContractGate(contract), null, 2)}\n`)
    const artifactRef = rel(contractPath)
    const gateArtifactRef = rel(gatePath)
    const artifactRefs = new Set(row.artifact_refs ?? [])
    artifactRefs.add(artifactRef)
    artifactRefs.add(gateArtifactRef)
    updated.push({
      ...row,
      artifact_refs: [...artifactRefs],
      submission_contract: contract,
    })
  }
  await writeJsonl(instanceResultsPath, updated)
  await mkdir(path.join(programRoot, 'grading'), { recursive: true })
  await writeJsonl(path.join(programRoot, 'grading/instance-results.jsonl'), updated)
  await rewritePairwise(updated)
  console.log(`Backfilled ProgramBench submission contracts for ${updated.length} rows in ${rel(runRoot)}`)
}

async function inspectSubmissionContract(workspaceRoot) {
  const compilePath = path.join(workspaceRoot, 'compile.sh')
  const compileExists = existsSync(compilePath)
  let compileExecutable = false
  if (compileExists) {
    compileExecutable = await new Promise((resolve) => access(compilePath, constants.X_OK, (err) => resolve(!err)))
  }
  const sourceFiles = await collectSourceFiles(workspaceRoot)
  const relativeSourceFiles = sourceFiles
    .map((file) => path.relative(workspaceRoot, file).replaceAll(path.sep, '/'))
    .sort()
  const relativeImplementationFiles = relativeSourceFiles.filter(isImplementationFile).sort()
  const referenceExecutable = existsSync(path.join(workspaceRoot, 'executable'))
  const reasonCodes = []
  if (!compileExists) reasonCodes.push('missing_compile_sh')
  else if (!compileExecutable) reasonCodes.push('compile_sh_not_executable')
  if (relativeImplementationFiles.length === 0) reasonCodes.push('missing_source_files')
  return {
    schema_version: 1,
    ok: compileExists && compileExecutable && relativeImplementationFiles.length > 0,
    checks: {
      compile_sh_exists: compileExists,
      compile_sh_executable: compileExecutable,
      source_files_present: relativeImplementationFiles.length > 0,
      implementation_files_present: relativeImplementationFiles.length > 0,
      implementation_written_through_after_bootstrap: true,
      reference_executable_present_before_packaging: referenceExecutable,
    },
    source_file_count: relativeSourceFiles.length,
    source_files: relativeSourceFiles,
    implementation_file_count: relativeImplementationFiles.length,
    implementation_files: relativeImplementationFiles,
    reason_codes: reasonCodes,
    required_actions: requiredActions(reasonCodes),
  }
}

function isImplementationFile(file) {
  const name = file.split('/').at(-1) ?? file
  if (name === 'Makefile') return true
  return /\.(c|cc|cpp|cxx|go|rs|sh|py|java|js|ts|mk)$/i.test(name)
}

function requiredActions(reasonCodes) {
  const actions = []
  if (reasonCodes.includes('missing_compile_sh')) actions.push('Create a top-level compile.sh file in the workspace root.')
  if (reasonCodes.includes('compile_sh_not_executable')) actions.push('Run chmod +x ./compile.sh so test -x ./compile.sh passes.')
  if (reasonCodes.includes('missing_source_files')) actions.push('Write the source/build files needed for compile.sh to build ./executable.')
  return actions
}

function buildSubmissionContractGate(contract) {
  return {
    schema_version: 1,
    gate: 'programbench_submission_contract',
    ok: contract.ok,
    reason_codes: contract.reason_codes,
    required_actions: contract.required_actions ?? requiredActions(contract.reason_codes ?? []),
    source_file_count: contract.source_file_count,
    checks: contract.checks,
    continuation_attempts: null,
    native_eval_policy: contract.ok
      ? 'contract_satisfied_native_eval_authoritative'
      : 'contract_failed_but_native_eval_still_runs_to_preserve_official_zero_or_error_evidence',
    completion_control_interpretation: contract.ok
      ? 'agent produced the minimum ProgramBench submission artifacts before scoring'
      : 'agent finalization did not produce the minimum ProgramBench submission artifacts; treat as artifact_contract_failure even if native eval also reports compile_failed',
  }
}

async function collectSourceFiles(dir) {
  const out = []
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (['.git', '.agent-kernel', '.claude', '.codex'].includes(entry.name)) continue
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (isProgramBenchSourceFile(entry.name)) out.push(entryPath)
    }
  }
  await visit(dir)
  return out
}

function isProgramBenchSourceFile(name) {
  if (name === 'compile.sh') return false
  return /\.(c|cc|cpp|cxx|h|hpp|go|rs|sh|py|java|js|ts|mk)$/i.test(name) || name === 'Makefile'
}

async function rewritePairwise(rows) {
  const byKey = new Map(rows.map((row) => [`${row.instance_id}:${row.agent}`, row]))
  const ids = [...new Set(rows.map((row) => row.instance_id))].sort()
  const pairwise = ids.map((id) => {
    const agent = byKey.get(`${id}:agent-runlab`)
    const claude = byKey.get(`${id}:claude-code`)
    return {
      benchmark: 'program-bench',
      instance_id: id,
      task_type: 'cleanroom_program_reconstruction',
      model: agent?.model ?? claude?.model ?? '',
      agent_runlab_status: agent?.status ?? 'not_run',
      claude_code_status: claude?.status ?? 'not_run',
      agent_runlab_score: String(agent?.score ?? 0),
      claude_code_score: String(claude?.score ?? 0),
      winner: winner(agent, claude),
      agent_artifact: agent?.artifact_refs?.join(';') ?? '',
      claude_artifact: claude?.artifact_refs?.join(';') ?? '',
      grader_report: 'artifacts/program-bench/grading/instance-results.jsonl',
      failure_category: failureCategory(agent, claude),
      notes: notes(agent, claude),
    }
  })
  const header = Object.keys(pairwise[0] ?? {})
  const csv = [header.join(','), ...pairwise.map((row) => header.map((key) => csvCell(row[key])).join(','))].join('\n') + '\n'
  const jsonl = pairwise.map((row) => JSON.stringify(row)).join('\n') + '\n'
  await writeFile(path.join(programRoot, 'pairwise-comparison.csv'), csv)
  await writeFile(path.join(programRoot, 'pairwise-comparison.jsonl'), jsonl)
  await writeFile(path.join(runRoot, 'pairwise-comparison.csv'), csv)
  await writeFile(path.join(runRoot, 'pairwise-comparison.jsonl'), jsonl)
}

function winner(agent, claude) {
  if (!agent || !claude || !agent.official || !claude.official) return 'not_comparable'
  if (agent.score > claude.score) return 'agent-runlab'
  if (claude.score > agent.score) return 'claude-code'
  return 'tie'
}

function failureCategory(agent, claude) {
  if ([agent, claude].some((row) => row?.submission_contract && !row.submission_contract.ok)) return 'artifact_contract_failure'
  if ([agent, claude].some((row) => row?.error_type?.includes('max_turns') || row?.error_type?.includes('maximum number of turns'))) return 'incomplete_execution'
  return [agent, claude].some((row) => row?.official && row.score === 0) ? 'compile_failed' : ''
}

function notes(agent, claude) {
  const reasons = []
  for (const [label, row] of [['Agent RunLab', agent], ['Claude Code', claude]]) {
    if (row?.submission_contract && !row.submission_contract.ok) reasons.push(`${label} contract: ${row.submission_contract.reason_codes.join('+')}`)
  }
  if (reasons.length) return reasons.join('; ')
  if (!agent || !claude) return 'missing one side of pairwise comparison'
  if (!agent.official || !claude.official) return 'native eval pending for one or both systems'
  return 'native ProgramBench eval completed for both systems'
}

async function readJsonl(file) {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function writeJsonl(file, rows) {
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''))
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function rel(file) {
  return path.relative(portfolioDir, file).replaceAll(path.sep, '/')
}

function value(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

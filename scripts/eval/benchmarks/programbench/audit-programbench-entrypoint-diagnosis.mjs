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

  const agents = {}
  for (const agent of ['agent-runlab', 'claude-code']) {
    const caseRoot = path.join(runRoot, agent, comparable.instance_id)
    const contract = await readJson(path.join(caseRoot, 'submission-contract.json'))
    const manifest = await readJson(path.join(caseRoot, 'run-manifest.json'))
    const caseJson = await readJson(path.join(caseRoot, 'programbench-case.json'))
    const workspaceRoot = path.join(legacy-runnerRoot, manifest.workspace_root)
    const sourceFiles = contract.source_files?.length ? contract.source_files : await collectSourceFiles(workspaceRoot)
    const prompt = buildEntrypointRepairPrompt(caseJson, manifest.workspace_root, contract, sourceFiles)
    const promptFile = path.join(diagnosisDir, `latest-entrypoint-repair-prompt.${agent}.txt`)
    await writeFile(promptFile, prompt, 'utf8')
    agents[agent] = {
      contract_ok: contract.ok === true,
      reason_codes: contract.reason_codes ?? [],
      source_file_count: contract.source_file_count ?? 0,
      source_files: sourceFiles,
      compile_sh_exists: contract.checks?.compile_sh_exists === true,
      workspace_root: manifest.workspace_root,
      repair_prompt_preview: rel(promptFile),
      entrypoint_completion_applicable: contract.checks?.source_files_present === true && contract.checks?.compile_sh_exists !== true,
    }
  }

  const applicableAgents = Object.entries(agents)
    .filter(([, info]) => info.entrypoint_completion_applicable)
    .map(([agent]) => agent)
  const missingSourceAgents = Object.entries(agents)
    .filter(([, info]) => info.source_files.length === 0)
    .map(([agent]) => agent)

  const report = {
    schema_version: 1,
    benchmark: 'program-bench',
    generated_by: 'scripts/eval/benchmarks/programbench/audit-programbench-entrypoint-diagnosis.mjs',
    status: 'entrypoint_completion_diagnosed',
    latest_run: {
      run_id: latest.run_id,
      status: latest.status,
      model: latest.model,
      scorer: latest.scorer,
    },
    instance_id: comparable.instance_id,
    pairwise: {
      winner: comparable.winner,
      agent_runlab_score: Number(comparable.agent_runlab_score),
      claude_code_score: Number(comparable.claude_code_score),
      failure_category: comparable.failure_category,
    },
    agents,
    conclusion: renderConclusion({ applicableAgents, missingSourceAgents }),
    next_gate: renderNextGate({ applicableAgents, missingSourceAgents }),
  }

  await mkdir(diagnosisDir, { recursive: true })
  await writeFile(path.join(diagnosisDir, 'latest-entrypoint-diagnosis.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(path.join(diagnosisDir, 'latest-entrypoint-diagnosis.md'), renderMarkdown(report), 'utf8')
  console.log(`ProgramBench entrypoint diagnosis ${report.status}`)
}

function renderConclusion({ applicableAgents, missingSourceAgents }) {
  if (applicableAgents.length && missingSourceAgents.length) {
    return `The latest comparable ProgramBench pair still failed before the minimum artifact contract. Entrypoint-only repair applies to ${applicableAgents.join(', ')} because source files exist but compile.sh is missing; ${missingSourceAgents.join(', ')} still lacks source files as well as compile.sh. This is a no-model diagnostic only; it does not change scores or artifact contracts.`
  }
  if (applicableAgents.length) {
    return `The latest comparable ProgramBench workspaces have source files but no top-level compile.sh for ${applicableAgents.join(', ')}, so the entrypoint-focused repair prompt is applicable. This is a no-model diagnostic only; it does not change scores or artifact contracts.`
  }
  return 'The latest comparable ProgramBench workspaces still lack the minimum source/build artifacts, so entrypoint-only repair is not sufficient. This is a no-model diagnostic only; it does not change scores or artifact contracts.'
}

function renderNextGate({ applicableAgents, missingSourceAgents }) {
  if (missingSourceAgents.length) {
    return 'Do not expand to five cases. Before another paid ProgramBench pair, fix the completion-control path so agents create source files and compile.sh before extended probing; keep max-agent-runs=2 when validating the fix.'
  }
  if (applicableAgents.length) {
    return 'If spending is accepted, run exactly one capped pair with the entrypoint-focused repair path and keep max-agent-runs=2. Do not expand to five cases until the minimum artifact contract passes.'
  }
  return 'Do not expand to five cases. Rework the ProgramBench completion-control prompt and runner checks, then validate with one capped pair only.'
}

function buildEntrypointRepairPrompt(item, workspaceRoot, contract, sourceFiles) {
  const sourceFileText = sourceFiles.length ? sourceFiles.map((file) => `- ${file}`).join('\n') : '- none recorded'
  const missingSources = !sourceFiles.length
  const hasSourcesButNoEntrypoint = sourceFiles.length > 0 && contract.checks?.compile_sh_exists !== true
  return `You are continuing the same ProgramBench clean-room reconstruction task.

Instance: ${item.instance_id}
Host workspace path for filesystem tools: ${workspaceRoot}
Bash workspace path: /workspace

Current completion-control focus:
- ${missingSources
    ? 'Source files are missing. Write at least one task-language source file and a top-level ./compile.sh before doing more analysis or ending the response.'
    : hasSourcesButNoEntrypoint
      ? 'Source files are already present but top-level ./compile.sh is missing. Create ./compile.sh first, make it executable, then run it.'
      : 'Satisfy every missing contract item before any final response.'}
- If both source files and compile.sh are missing, this is a minimum-artifact-completion task: write the source skeleton and compile.sh immediately, even if the implementation is incomplete.
- If source files already exist and only compile.sh is missing, this is an entrypoint-completion task: create ./compile.sh immediately around the existing source files.
- Do not start by investigating the reference executable again.
- Do not finish with a promise to write files.

Minimum artifact checkpoint:
- Before any final response, the workspace must contain a source/build file and ./compile.sh.
- If either is absent, the only acceptable next action is a file-writing tool call, not explanation.
- A response that says "I will create" or "let me write" without a file-writing tool call is still a failed repair.

Detected source files:
${sourceFileText}

Failed contract reason codes:
${(contract.reason_codes ?? []).map((reason) => `- ${reason}`).join('\n') || '- unknown'}

Required repair actions:
${(contract.required_actions ?? []).map((action) => `- ${action}`).join('\n') || '- Re-check the workspace and satisfy the benchmark contract.'}

Contract requirements:
- Create a top-level ./compile.sh if it is missing.
- Make ./compile.sh executable with chmod +x ./compile.sh.
- Running ./compile.sh from the workspace root must build a fresh top-level ./executable.
- Keep the final source code self-contained in this workspace.
- Do not use the internet, web search, web fetch, package registries, external repositories, prior benchmark artifacts, or files outside this workspace.
`
}

async function collectSourceFiles(workspaceRoot) {
  const out = []
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.agent-kernel' || entry.name === '.claude' || entry.name === '.codex' || entry.name === '.claude-home' || entry.name === '.agent-home') continue
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (isProgramBenchSourceFile(entry.name)) out.push(path.relative(workspaceRoot, entryPath).replaceAll(path.sep, '/'))
    }
  }
  await visit(workspaceRoot)
  return out.sort()
}

function isProgramBenchSourceFile(name) {
  if (name === 'compile.sh') return false
  return /\.(c|cc|cpp|cxx|h|hpp|go|rs|sh|py|java|js|ts|mk)$/i.test(name) || name === 'Makefile'
}

function renderMarkdown(report) {
  const lines = [
    '# ProgramBench Entrypoint Diagnosis',
    '',
    `Status: \`${report.status}\``,
    `Run: \`${report.latest_run.run_id}\``,
    `Instance: \`${report.instance_id}\``,
    '',
    '| Agent | Contract | Source files | compile.sh | Entrypoint repair applicable | Prompt preview |',
    '|---|---:|---:|---:|---:|---|',
  ]
  for (const [agent, info] of Object.entries(report.agents)) {
    lines.push(`| ${agent} | \`${info.contract_ok ? 'ok' : info.reason_codes.join(',') || 'failed'}\` | ${info.source_file_count} | ${info.compile_sh_exists ? 'yes' : 'no'} | ${info.entrypoint_completion_applicable ? 'yes' : 'no'} | \`${info.repair_prompt_preview}\` |`)
  }
  lines.push('', '## Conclusion', '', report.conclusion, '', '## Next Gate', '', report.next_gate, '')
  return lines.join('\n')
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function readJsonl(file) {
  return (await readFile(file, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function rel(file) {
  return path.relative(legacy-runnerRoot, file).replaceAll(path.sep, '/')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

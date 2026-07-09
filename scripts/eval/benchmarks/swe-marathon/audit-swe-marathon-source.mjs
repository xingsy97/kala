#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const legacy-runner = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const reference = path.join(legacy-runner, 'references/swe-marathon')
const planningDir = path.join(legacy-runner, 'planning/swe-marathon')
const diagnosticsDir = path.join(legacy-runner, 'diagnostics/swe-marathon')
const reportDir = path.join(legacy-runner, 'reports/swe-marathon')

async function main() {
  const tasksDir = path.join(reference, 'tasks')
  const taskNames = (await readdir(tasksDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const datasetToml = await readFile(path.join(tasksDir, 'dataset.toml'), 'utf8')
  const digestByName = parseDatasetDigests(datasetToml)
  const rows = []

  for (const task of taskNames) {
    const taskTomlPath = path.join(tasksDir, task, 'task.toml')
    const instructionPath = path.join(tasksDir, task, 'instruction.md')
    const toml = await readFile(taskTomlPath, 'utf8')
    const instruction = await readFile(instructionPath, 'utf8')
    rows.push({
      benchmark: 'swe-marathon',
      instance_id: task,
      task_name: `abundant/${task}`,
      digest: digestByName.get(`abundant/${task}`) || '',
      category: extractString(toml, 'metadata', 'category'),
      difficulty: extractString(toml, 'metadata', 'difficulty'),
      tags: extractArray(toml, 'metadata', 'tags'),
      verifier_type: extractString(toml, 'verifier', 'type') || 'shell',
      verifier_network_mode: extractString(toml, 'verifier', 'network_mode'),
      verifier_timeout_sec: extractNumber(toml, 'verifier', 'timeout_sec'),
      agent_network_mode: extractString(toml, 'agent', 'network_mode'),
      agent_timeout_sec: extractNumber(toml, 'agent', 'timeout_sec'),
      cpus: extractNumber(toml, 'environment', 'cpus'),
      memory_mb: extractNumber(toml, 'environment', 'memory_mb'),
      storage_mb: extractNumber(toml, 'environment', 'storage_mb'),
      gpus: extractNumber(toml, 'environment', 'gpus') ?? 0,
      gpu_types: extractArray(toml, 'environment', 'gpu_types'),
      environment_network_mode: extractString(toml, 'environment', 'network_mode'),
      instruction_sha256: sha256(instruction),
      task_toml_sha256: sha256(toml),
      instruction_chars: instruction.length,
      source_ref: `references/swe-marathon/tasks/${task}`,
    })
  }

  const summary = buildSummary(rows)
  await mkdir(planningDir, { recursive: true })
  await mkdir(diagnosticsDir, { recursive: true })
  await mkdir(reportDir, { recursive: true })
  await writeFile(path.join(planningDir, 'selected-cases.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  await writeFile(path.join(planningDir, 'selected-cases.csv'), toCsv(rows))
  await writeFile(path.join(diagnosticsDir, 'source-preflight.json'), JSON.stringify(summary, null, 2) + '\n')
  await writeFile(path.join(diagnosticsDir, 'source-preflight.md'), renderMarkdown(summary, rows))
  await writeFile(path.join(reportDir, 'benchmark-summary.json'), JSON.stringify({
    schema_version: 1,
    benchmark: 'swe-marathon',
    status: 'source_audited_not_run',
    evidence_level: 'source_audited',
    target_subset: rows.length,
    selected_cases: rows.length,
    executed_cases: 0,
    scored_cases: 0,
    canonical_source: 'https://github.com/abundant-ai/swe-marathon',
    reference_commit: summary.reference_commit,
    native_harness: 'Harbor/Modal task framework',
    next_gate: summary.toolchain.harbor_available
      ? 'Validate Modal/auth/cost controls, then run one non-GPU public-network calibration task before any broader subset.'
      : 'Install harbor[modal]==0.17.1, validate Modal/auth/cost controls, then run one non-GPU public-network calibration task before any broader subset.',
  }, null, 2) + '\n')
  console.log(`Wrote SWE-Marathon source audit for ${rows.length} tasks`)
}

function parseDatasetDigests(toml) {
  const result = new Map()
  const blocks = toml.split(/\n\[\[tasks\]\]\n/g).slice(1)
  for (const block of blocks) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1]
    const digest = block.match(/^digest\s*=\s*"([^"]+)"/m)?.[1]
    if (name && digest) result.set(name, digest)
  }
  return result
}

function sectionText(toml, section) {
  const match = toml.match(new RegExp(`\\n?\\[${escapeRegExp(section)}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`))
  return match?.[1] || ''
}

function extractString(toml, section, key) {
  return sectionText(toml, section).match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] || ''
}

function extractNumber(toml, section, key) {
  const value = sectionText(toml, section).match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*([0-9.]+)`, 'm'))?.[1]
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function extractArray(toml, section, key) {
  const text = sectionText(toml, section)
  const inline = text.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'))?.[1]
  const block = inline ?? text.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))?.[1]
  if (!block) return []
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function buildSummary(rows) {
  const gpuRows = rows.filter((row) => row.gpus > 0)
  const restrictedRows = rows.filter((row) => row.agent_network_mode === 'allowlist' || row.verifier_network_mode === 'no-network')
  const toolchain = inspectToolchain()
  return {
    schema_version: 1,
    benchmark: 'swe-marathon',
    generated_by: 'scripts/eval/benchmarks/swe-marathon/audit-swe-marathon-source.mjs',
    status: 'source_audited_not_run',
    reference_path: 'experiments/evals/2026-07-agent-benchmark-comparison/references/swe-marathon',
    reference_commit: process.env.SWE_MARATHON_REF || gitHead(),
    selected_cases: rows.length,
    gpu_cases: gpuRows.length,
    gpu_types: [...new Set(gpuRows.flatMap((row) => row.gpu_types))].sort(),
    internet_restricted_cases: restrictedRows.length,
    max_agent_timeout_sec: Math.max(...rows.map((row) => row.agent_timeout_sec || 0)),
    max_verifier_timeout_sec: Math.max(...rows.map((row) => row.verifier_timeout_sec || 0)),
    max_storage_mb: Math.max(...rows.map((row) => row.storage_mb || 0)),
    categories: countBy(rows, 'category'),
    difficulties: countBy(rows, 'difficulty'),
    toolchain,
    hard_blockers_before_run: [
      toolchain.harbor_available
        ? `harbor[modal]==0.17.1 is installed locally; harbor --version returned ${toolchain.harbor_version}`
        : 'harbor[modal]==0.17.1 must be installed',
      toolchain.has_modal_credentials
        ? 'Modal credentials are visible in the shell; validate spending controls before any run'
        : 'Modal authentication and spending controls must be validated',
      'ANTHROPIC_API_KEY is required for many verifier CUA/judge stages, not only agent inference',
      'GPU tasks require Modal GPU availability and should not be included in the first calibration unless explicitly budgeted',
    ],
    recommended_calibration_policy: 'Start with one non-GPU public-network task and one system only if the Harbor dry-run/config checks pass; then add the second system on the same task before expanding.',
  }
}

function inspectToolchain() {
  const modalCliPath = process.env.HARBOR_MODAL_CLI || commandOutput('bash', ['-lc', 'command -v modal || true'])
  const harborVersion = commandOutput('harbor', ['--version'])
  const modalVersion = modalCliPath ? commandOutput(modalCliPath, ['--version']) : ''
  const credentialEnvNames = [
    'MODAL_TOKEN_ID',
    'MODAL_TOKEN_SECRET',
    'MODAL_PROFILE',
    'ANTHROPIC_API_KEY',
    'JUDGE_API_KEY',
    'XAI_API_KEY',
  ]
  return {
    harbor_available: Boolean(harborVersion),
    harbor_version: harborVersion,
    modal_cli_path: modalCliPath || '<modal-not-on-path>',
    modal_available: Boolean(modalVersion),
    modal_version: modalVersion,
    credential_env_present: credentialEnvNames.filter((name) => Boolean(process.env[name])),
    has_modal_credentials: Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET),
    has_anthropic_api_key: Boolean(process.env.ANTHROPIC_API_KEY),
    install_note: harborVersion
      ? 'Latest successful install used: uv tool install --python 3.13 \'harbor[modal]==0.17.1\'. Default Python 3.11 was too old; system Python 3.14 was too new for a PyO3 dependency.'
      : 'Harbor was not visible on PATH during this audit.',
  }
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function gitHead() {
  try {
    return execFileSync('git', ['-C', reference, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function renderMarkdown(summary, rows) {
  const table = rows.map((row) => `| \`${row.instance_id}\` | ${row.category} | ${row.difficulty} | ${row.gpus || 0} | ${(row.gpu_types || []).join(' ')} | ${row.agent_timeout_sec || ''} | ${row.verifier_timeout_sec || ''} | ${row.agent_network_mode || row.environment_network_mode || ''} |`).join('\n')
  return `# SWE-Marathon Source Preflight\n\nGenerated by \`${summary.generated_by}\`. No model, Modal job, or verifier calls were made.\n\n## Summary\n\n- Selected cases: ${summary.selected_cases}\n- GPU cases: ${summary.gpu_cases}${summary.gpu_types.length ? ` (${summary.gpu_types.join(', ')})` : ''}\n- Internet-restricted cases: ${summary.internet_restricted_cases}\n- Max agent timeout: ${summary.max_agent_timeout_sec} sec\n- Max verifier timeout: ${summary.max_verifier_timeout_sec} sec\n- Max storage: ${summary.max_storage_mb} MB\n\n## Toolchain Gate\n\n- Harbor available: ${summary.toolchain.harbor_available ? 'yes' : 'no'}${summary.toolchain.harbor_version ? ` (${summary.toolchain.harbor_version})` : ''}\n- Modal CLI available: ${summary.toolchain.modal_available ? 'yes' : 'no'}${summary.toolchain.modal_version ? ` (${summary.toolchain.modal_version})` : ''}\n- Modal CLI path: \`${summary.toolchain.modal_cli_path}\`\n- Visible credential env vars: ${summary.toolchain.credential_env_present.length ? summary.toolchain.credential_env_present.map((name) => `\`${name}\``).join(', ') : 'none'}\n- Install note: ${summary.toolchain.install_note}\n\n## Hard Blockers Before Any Run\n\n${summary.hard_blockers_before_run.map((item) => `- ${item}`).join('\n')}\n\n## Calibration Policy\n\n${summary.recommended_calibration_policy}\n\n## Cases\n\n| Case | Category | Difficulty | GPUs | GPU types | Agent timeout | Verifier timeout | Network |\n|---|---|---|---:|---|---:|---:|---|\n${table}\n`
}

function countBy(rows, key) {
  const out = {}
  for (const row of rows) out[row[key] || 'unknown'] = (out[row[key] || 'unknown'] || 0) + 1
  return out
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function toCsv(rows) {
  const fields = Object.keys(rows[0] || {})
  return [fields.join(','), ...rows.map((row) => fields.map((field) => csv(row[field])).join(','))].join('\n') + '\n'
}

function csv(value) {
  if (value === null || value === undefined) return ''
  const text = Array.isArray(value) ? value.join(';') : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

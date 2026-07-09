#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const portfolioRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const planningRoot = path.join(portfolioRoot, 'planning/swe-marathon')
const diagnosticsRoot = path.join(portfolioRoot, 'diagnostics/swe-marathon')
const calibrationRoot = path.join(portfolioRoot, 'diagnostics/swe-marathon/no-run-calibration')
const referenceRoot = path.join(portfolioRoot, 'references/swe-marathon')
const configPath = path.join(calibrationRoot, 'stripe-clone-claude-code-sonnet-modal.config.json')
const printConfigPath = path.join(calibrationRoot, 'print-config-output.json')
const preflightPath = path.join(calibrationRoot, 'preflight-summary.json')

async function main() {
  const config = await readJson(configPath)
  const printConfig = await readJson(printConfigPath)
  const sourcePreflight = await readJson(path.join(diagnosticsRoot, 'source-preflight.json'))
  const selectedCase = await findSelectedCase('stripe-clone')
  const harborVersion = commandOutput('harbor', ['--version'])
  const harborRunHelp = commandOutput('harbor', ['run', '--help'])
  const harborAuthStatus = commandOutput('harbor', ['auth', 'status']) || 'unknown'
  const modalCliPath = sourcePreflight.toolchain?.modal_cli_path && sourcePreflight.toolchain.modal_cli_path !== '<modal-not-on-path>'
    ? sourcePreflight.toolchain.modal_cli_path
    : process.env.HARBOR_MODAL_CLI || commandOutput('bash', ['-lc', 'command -v modal || true'])
  const modalProfileCurrent = modalCliPath ? commandOutput(modalCliPath, ['profile', 'current']) || 'unknown' : 'unknown'
  const printConfigProbe = commandOutput('harbor', ['run', '--config', rel(configPath), '--print-config'])
  const parsedPrintConfigProbe = parseTrailingJson(printConfigProbe)
  const credentialEnvNames = [
    'MODAL_TOKEN_ID',
    'MODAL_TOKEN_SECRET',
    'MODAL_PROFILE',
    'ANTHROPIC_API_KEY',
    'JUDGE_API_KEY',
    'XAI_API_KEY',
  ]

  const validation = validate({
    config,
    printConfig,
    parsedPrintConfigProbe,
    sourcePreflight,
    selectedCase,
    harborVersion,
    harborRunHelp,
    harborAuthStatus,
    modalProfileCurrent,
  })
  const visibleSecretEnvVars = credentialEnvNames.filter((name) => Boolean(process.env[name]))
  const hasModalCredentials = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET)
  const report = {
    schema_version: 1,
    benchmark: 'swe-marathon',
    generated_by: 'scripts/eval/benchmarks/swe-marathon/audit-swe-marathon-no-run-calibration.mjs',
    status: validation.errors.length ? 'invalid_no_run_template' : 'no_run_template_validated',
    task: 'stripe-clone',
    task_selection_reason: 'non-GPU public-network medium backend task; avoids combining first runner calibration with GPU or allowlist complexity',
    agent: firstAgent(config)?.name || null,
    model: firstAgent(config)?.model_name || null,
    environment: config.environment?.type || null,
    n_attempts: 1,
    n_concurrent_trials: config.n_concurrent_trials ?? null,
    n_concurrent_agents: firstAgent(config)?.n_concurrent ?? null,
    max_retries: 0,
    commands_run: [
      'harbor run --help',
      'harbor auth status',
      `${modalCliPath || '<modal-not-on-path>'} profile current`,
      `harbor run --config ${rel(configPath)} --print-config`,
    ],
    print_config_result: parsedPrintConfigProbe
      ? 'succeeded_without_starting_job_for_repo_root_config_file'
      : 'missing_or_unparseable_print_config_probe',
    harbor_version: harborVersion,
    harbor_run_help_has_print_config: harborRunHelp.includes('--print-config'),
    harbor_auth_status: normalizeAuthStatus(harborAuthStatus),
    modal_profile_current: modalProfileCurrent,
    visible_secret_env_vars: visibleSecretEnvVars,
    modal_credentials_validated: hasModalCredentials && !/not authenticated|unknown/i.test(harborAuthStatus),
    spending_controls_validated: false,
    job_started: false,
    selected_case: {
      instance_id: selectedCase?.instance_id || null,
      difficulty: selectedCase?.difficulty || null,
      category: selectedCase?.category || null,
      gpus: selectedCase?.gpus ?? null,
      agent_network_mode: selectedCase?.agent_network_mode || selectedCase?.environment_network_mode || null,
      verifier_network_mode: selectedCase?.verifier_network_mode || null,
      agent_timeout_sec: selectedCase?.agent_timeout_sec ?? null,
      verifier_timeout_sec: selectedCase?.verifier_timeout_sec ?? null,
    },
    validation,
    next_gate: 'Validate Modal credentials and explicit spending controls before running the template without --print-config.',
  }
  await mkdir(calibrationRoot, { recursive: true })
  await writeFile(preflightPath, JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(calibrationRoot, 'README.md'), renderMarkdown(report))
  console.log(`SWE-Marathon no-run calibration ${report.status}`)
}

function validate({ config, printConfig, parsedPrintConfigProbe, sourcePreflight, selectedCase, harborVersion, harborRunHelp, harborAuthStatus, modalProfileCurrent }) {
  const errors = []
  const warnings = []
  if (!harborVersion.startsWith('0.17.1')) errors.push(`expected harbor 0.17.1, got ${harborVersion || 'missing'}`)
  if (!harborRunHelp.includes('--print-config')) errors.push('harbor run --help did not expose --print-config')
  if (!parsedPrintConfigProbe) errors.push('harbor --print-config probe did not return parseable JSON')
  if (config.environment?.type !== 'modal') errors.push(`expected modal environment, got ${config.environment?.type}`)
  if (config.n_concurrent_trials !== 1) errors.push(`expected n_concurrent_trials=1, got ${config.n_concurrent_trials}`)
  if (firstAgent(config)?.name !== 'claude-code') errors.push(`expected agent claude-code, got ${firstAgent(config)?.name}`)
  if (firstAgent(config)?.model_name !== 'anthropic/claude-sonnet-4-6') errors.push(`expected anthropic/claude-sonnet-4-6, got ${firstAgent(config)?.model_name}`)
  if (firstAgent(config)?.n_concurrent !== 1) errors.push(`expected one concurrent agent, got ${firstAgent(config)?.n_concurrent}`)
  if (taskName(config) !== 'stripe-clone') errors.push(`expected config task stripe-clone, got ${taskName(config)}`)
  if (taskName(printConfig) !== 'stripe-clone') errors.push(`expected archived print-config task stripe-clone, got ${taskName(printConfig)}`)
  if (parsedPrintConfigProbe && taskName(parsedPrintConfigProbe) !== 'stripe-clone') errors.push(`expected live print-config probe task stripe-clone, got ${taskName(parsedPrintConfigProbe)}`)
  if (!selectedCase) errors.push('selected-cases.jsonl does not include stripe-clone')
  if (selectedCase?.gpus !== 0) errors.push(`stripe-clone calibration must be non-GPU, got gpus=${selectedCase?.gpus}`)
  if ((selectedCase?.agent_network_mode || '') === 'allowlist') errors.push('stripe-clone calibration must not use agent allowlist mode')
  if ((selectedCase?.verifier_network_mode || '') === 'no-network') warnings.push('stripe-clone verifier is no-network; verify this is still intended for first public-network calibration')
  if (sourcePreflight.status !== 'source_audited_not_run') errors.push(`source preflight should remain source_audited_not_run, got ${sourcePreflight.status}`)
  if (sourcePreflight.selected_cases !== 20) errors.push(`source preflight selected_cases must be 20, got ${sourcePreflight.selected_cases}`)
  if (!/not authenticated|unknown/i.test(harborAuthStatus)) warnings.push(`harbor auth status is ${harborAuthStatus}; confirm spending controls before live run`)
  if (!modalProfileCurrent) warnings.push('modal profile current returned empty output')
  return { errors, warnings }
}

async function findSelectedCase(instanceId) {
  const text = await readFile(path.join(planningRoot, 'selected-cases.jsonl'), 'utf8')
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line)
    if (row.instance_id === instanceId) return row
  }
  return null
}

function parseTrailingJson(output) {
  if (!output) return null
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(output.slice(start, end + 1))
  } catch {
    return null
  }
}

function firstAgent(config) {
  return Array.isArray(config.agents) ? config.agents[0] : null
}

function taskName(config) {
  const raw = Array.isArray(config.tasks) ? config.tasks[0]?.path : ''
  return path.basename(String(raw || ''))
}

function normalizeAuthStatus(output) {
  if (!output) return 'unknown'
  if (/not authenticated|not logged in/i.test(output)) return 'not_authenticated'
  return output
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    return [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function rel(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/')
}

function renderMarkdown(report) {
  const lines = [
    '# SWE-Marathon No-Run Calibration Template',
    '',
    'This directory records a safe Harbor/Modal calibration plan. No Harbor/Modal benchmark job has been started from this template.',
    '',
    `Status: \`${report.status}\``,
    '',
    '## Selected First Task',
    '',
    `\`${report.task}\` is the recommended first calibration task because it is non-GPU, public-network, medium difficulty, and representative of backend implementation work.`,
    '',
    'This avoids combining first-run Harbor/Modal validation with GPU allocation or internet allowlist complexity.',
    '',
    '## Validated No-Run Command',
    '',
    'Recommended from the repo root:',
    '',
    '```bash',
    `harbor run --config ${rel(configPath)} --print-config`,
    '```',
    '',
    `${report.print_config_result}. It did not start a Modal job.`,
    '',
    '## Current Gates',
    '',
    `- Harbor runner: ${report.harbor_version || 'missing'}`,
    `- Harbor run help exposes --print-config: ${report.harbor_run_help_has_print_config ? 'yes' : 'no'}`,
    `- Harbor auth status: \`${report.harbor_auth_status}\``,
    `- Modal profile current: \`${report.modal_profile_current}\``,
    `- Visible secret env vars: ${report.visible_secret_env_vars.length ? report.visible_secret_env_vars.map((name) => `\`${name}\``).join(', ') : 'none'}`,
    `- Modal credentials validated: ${report.modal_credentials_validated ? 'yes' : 'no'}`,
    `- Spending controls validated: ${report.spending_controls_validated ? 'yes' : 'no'}`,
    `- Job started: ${report.job_started ? 'yes' : 'no'}`,
    '',
    '## Validation',
    '',
  ]
  if (!report.validation.errors.length) lines.push('- errors: none')
  for (const error of report.validation.errors) lines.push(`- error: ${error}`)
  if (!report.validation.warnings.length) lines.push('- warnings: none')
  for (const warning of report.validation.warnings) lines.push(`- warning: ${warning}`)
  lines.push('', '## Next Gate', '', report.next_gate, '')
  return lines.join('\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

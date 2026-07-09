#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const portfolioRoot = path.join(root, 'experiments/evals/2026-07-agent-benchmark-comparison')
const artifactRoot = path.join(portfolioRoot, 'artifacts/job-bench')
const runId = 'jobbench-easy-1case-unscored-smoke-1'
const runRoot = path.join(artifactRoot, runId)
const judgeDatasetRoot = path.join(runRoot, 'native-judge-dataset/easy')
const taskDir = path.join(judgeDatasetRoot, 'bookkeeping_accounting_and_auditing_clerks/task1')
const evaluatorRoot = path.join(portfolioRoot, 'references/job-bench-eval')
const preflightDir = path.join(artifactRoot, 'judge-preflight')

async function main() {
  const manifest = await readJson(path.join(judgeDatasetRoot, 'judge-dataset-manifest.json'))
  const invalidAttemptDir = path.join(taskDir, 'eval_result/eval_agent-runlab-sonnet-4-6/invalid-attempts')
  const invalidAttempts = await readInvalidAttempts(invalidAttemptDir)
  const dependencyStatus = dependencyProbe()
  const report = {
    schema_version: 1,
    benchmark: 'job-bench',
    generated_by: 'scripts/eval/benchmarks/jobbench/audit-jobbench-judge-preflight.mjs',
    status: hasJudgeKey() ? 'ready_for_one_case_judge_smoke' : 'blocked_missing_judge_key',
    run_id: runId,
    evaluator: {
      path: rel(evaluatorRoot),
      commit: gitHead(evaluatorRoot),
      run_judge: rel(path.join(evaluatorRoot, 'eval/run_judge.sh')),
      judge_py: rel(path.join(evaluatorRoot, 'eval/judge.py')),
    },
    dependencies: dependencyStatus,
    credentials: {
      visible_env_vars: ['JUDGE_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY'].filter((name) => Boolean(process.env[name])),
      has_judge_key: hasJudgeKey(),
    },
    dataset: {
      root: rel(judgeDatasetRoot),
      task_dir: rel(taskDir),
      case_id: manifest.case_id,
      rubric_count: await rubricCount(path.join(taskDir, 'RUBRICS.json')),
      task_folder_files: await listRelativeFiles(path.join(taskDir, 'task_folder')),
      model_outputs: manifest.models.map((model) => ({
        model_output_name: model.model_output_name,
        file_count: model.files.length,
        files: model.files.map((file) => file.path),
      })),
    },
    invalid_attempts: invalidAttempts,
    valid_score_present: false,
    next_gate: hasJudgeKey()
      ? 'Run the one-case official judge smoke for both model outputs with MAX_CONCURRENT=1 and validate each JSON with validate-jobbench-judge-result.mjs --fail-invalid.'
      : 'Provide a judge API key through JUDGE_API_KEY or equivalent before any valid JobBench score can be produced.',
    safe_commands: {
      preflight: 'node scripts/eval/benchmarks/jobbench/audit-jobbench-judge-preflight.mjs',
      validate_invalid_attempt_example: 'node scripts/eval/benchmarks/jobbench/validate-jobbench-judge-result.mjs --result <judge_result.json> --fail-invalid',
    },
  }
  await mkdir(preflightDir, { recursive: true })
  await writeFile(path.join(preflightDir, 'preflight-summary.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(path.join(preflightDir, 'README.md'), renderMarkdown(report))
  console.log(`JobBench judge preflight ${report.status}`)
}

async function readInvalidAttempts(dir) {
  try {
    const entries = (await readdir(dir)).filter((name) => name.endsWith('.validation.json')).sort()
    const attempts = []
    for (const entry of entries) {
      const body = await readJson(path.join(dir, entry))
      attempts.push({
        validation_file: rel(path.join(dir, entry)),
        validator_version: body.validator_version ?? null,
        valid: Boolean(body.valid),
        evaluated_model: body.evaluated_model,
        judge_model: body.judge_model,
        total_score: body.total_score,
        max_score: body.max_score,
        normalized_score: body.normalized_score,
        invalid_reason_count: body.invalid_reason_count,
        first_invalid_reason: body.invalid_reasons?.[0] || '',
      })
    }
    return attempts
  } catch {
    return []
  }
}

function dependencyProbe() {
  const script = "import importlib.util; names=['openai','pandas','datasets']; print('\\n'.join(f'{n}={bool(importlib.util.find_spec(n))}' for n in names))"
  const output = commandOutput('uv', ['run', 'python', '-c', script], evaluatorRoot)
  const packages = {}
  for (const line of output.split('\n').filter(Boolean)) {
    const [name, value] = line.split('=')
    packages[name] = value === 'True'
  }
  return {
    uv_run_python_ok: Boolean(output),
    packages,
  }
}

async function rubricCount(filePath) {
  const body = await readJson(filePath)
  return Array.isArray(body.rubrics) ? body.rubrics.length : null
}

async function listRelativeFiles(dir) {
  try {
    const out = []
    for (const name of await readdir(dir)) {
      const filePath = path.join(dir, name)
      const info = await stat(filePath)
      if (info.isFile()) out.push({ path: name, size: info.size })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  } catch {
    return []
  }
}

function hasJudgeKey() {
  return Boolean(process.env.JUDGE_API_KEY || process.env.XAI_API_KEY || process.env.OPENAI_API_KEY)
}

function gitHead(cwd) {
  return commandOutput('git', ['rev-parse', 'HEAD'], cwd)
}

function commandOutput(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
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
    '# JobBench Judge Preflight',
    '',
    `Status: \`${report.status}\``,
    '',
    'No paid judge call is made by this preflight.',
    '',
    '## Evaluator',
    '',
    `- Path: \`${report.evaluator.path}\``,
    `- Commit: \`${report.evaluator.commit}\``,
    `- Runner: \`${report.evaluator.run_judge}\``,
    '',
    '## Dependencies And Credentials',
    '',
    `- uv Python probe: ${report.dependencies.uv_run_python_ok ? 'ok' : 'failed'}`,
    `- openai package: ${report.dependencies.packages.openai ? 'present' : 'missing'}`,
    `- pandas package: ${report.dependencies.packages.pandas ? 'present' : 'missing'}`,
    `- datasets package: ${report.dependencies.packages.datasets ? 'present' : 'missing'}`,
    `- Visible judge credential env vars: ${report.credentials.visible_env_vars.length ? report.credentials.visible_env_vars.map((name) => `\`${name}\``).join(', ') : 'none'}`,
    '',
    '## Dataset Layout',
    '',
    `- Case: \`${report.dataset.case_id}\``,
    `- Task dir: \`${report.dataset.task_dir}\``,
    `- Rubrics: ${report.dataset.rubric_count}`,
    `- Reference files: ${report.dataset.task_folder_files.map((file) => `\`${file.path}\``).join(', ')}`,
    '',
    '| Model output | Files |',
    '|---|---:|',
  ]
  for (const model of report.dataset.model_outputs) lines.push(`| \`${model.model_output_name}\` | ${model.file_count} |`)
  lines.push('', '## Invalid Attempts Preserved', '')
  if (!report.invalid_attempts.length) lines.push('- none')
  for (const attempt of report.invalid_attempts) {
    lines.push(`- \`${attempt.validation_file}\`: validator=${attempt.validator_version ?? 'unknown'}, valid=${attempt.valid}, invalid_reason_count=${attempt.invalid_reason_count}, first=${attempt.first_invalid_reason}`)
  }
  lines.push('', '## Next Gate', '', report.next_gate, '')
  return lines.join('\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

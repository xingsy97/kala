#!/usr/bin/env node
/**
 * CI-friendly SWE-bench smoke path.
 *
 * This intentionally does not run the official Docker harness. It verifies the
 * production adapter boundaries that are cheap and deterministic in CI:
 *   - official prediction JSONL generation from SWE-bench-shaped fixtures,
 *   - official-style result ingestion,
 *   - run comparison artifact generation,
 *   - dry-run official harness command construction.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const keep = process.argv.includes('--keep')
const dir = mkdtempSync(join(tmpdir(), 'ak-swebench-smoke-'))
const bin = join(root, 'packages/host/dist/bin/agent-kernel-host.js')

const cli = existsSync(bin)
  ? [process.execPath, bin]
  : ['pnpm', ['--filter', '@agent-kernel/host', 'exec', 'tsx', 'bin/agent-kernel-host.ts']]

let exitCode = 0
const check = (name, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
  if (!pass) exitCode = 1
}

try {
  const instances = join(dir, 'instances.jsonl')
  const patches = join(dir, 'patches')
  const baseResults = join(dir, 'official-results-base')
  const candidateResults = join(dir, 'official-results-candidate')
  mkdirSync(patches, { recursive: true })
  mkdirSync(baseResults, { recursive: true })
  mkdirSync(candidateResults, { recursive: true })

  writeFileSync(
    instances,
    [
      { instance_id: 'local__repo-1', repo: 'local/repo', problem_statement: 'fix one' },
      { instance_id: 'local__repo-2', repo: 'local/repo', problem_statement: 'fix two' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  )
  writeFileSync(join(patches, 'local__repo-1.diff'), 'diff --git a/a.txt b/a.txt\n+fixed\n', 'utf8')
  writeFileSync(join(patches, 'local__repo-2.diff'), 'diff --git a/b.txt b/b.txt\n+fixed\n', 'utf8')

  runCli([
    'eval', 'swebench', 'infer',
    '--root-dir', join(dir, 'runs'),
    '--run-id', 'baseline',
    '--dataset', 'local/SWE-bench-smoke',
    '--model', 'agent-kernel-smoke',
    '--instances-jsonl', instances,
    '--patches-dir', patches,
  ])
  runCli([
    'eval', 'swebench', 'infer',
    '--root-dir', join(dir, 'runs'),
    '--run-id', 'candidate',
    '--dataset', 'local/SWE-bench-smoke',
    '--model', 'agent-kernel-smoke',
    '--instances-jsonl', instances,
    '--patches-dir', patches,
  ])

  writeFileSync(
    join(baseResults, 'instance_results.jsonl'),
    JSON.stringify({ instance_id: 'local__repo-1', resolved: false, error: 'tests failed' }) + '\n' +
      JSON.stringify({ instance_id: 'local__repo-2', resolved: false, error: 'patch apply failed' }) + '\n',
    'utf8',
  )
  writeFileSync(
    join(candidateResults, 'instance_results.jsonl'),
    JSON.stringify({ instance_id: 'local__repo-1', resolved: true }) + '\n' +
      JSON.stringify({ instance_id: 'local__repo-2', resolved: false, error: 'tests failed' }) + '\n',
    'utf8',
  )

  runCli(['eval', 'swebench', 'ingest-results', '--root-dir', join(dir, 'runs'), '--run-id', 'baseline', '--results-dir', baseResults])
  runCli(['eval', 'swebench', 'ingest-results', '--root-dir', join(dir, 'runs'), '--run-id', 'candidate', '--results-dir', candidateResults])
  runCli([
    'enhancement', 'eval', 'compare-runs',
    '--root-dir', join(dir, 'compare'),
    '--baseline-summary', join(dir, 'runs', 'baseline', 'summary.json'),
    '--candidate-summary', join(dir, 'runs', 'candidate', 'summary.json'),
  ])
  const grade = runCli([
    'eval', 'swebench', 'grade',
    '--dataset', 'local/SWE-bench-smoke',
    '--predictions', join(dir, 'runs', 'candidate', 'predictions.jsonl'),
    '--run-id', 'candidate',
    '--max-workers', '2',
  ])

  const predictions = readFileSync(join(dir, 'runs', 'candidate', 'predictions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const candidateSummary = JSON.parse(readFileSync(join(dir, 'runs', 'candidate', 'summary.json'), 'utf8'))
  const comparison = JSON.parse(readFileSync(join(dir, 'compare', 'eval-comparison.json'), 'utf8'))
  const gradePayload = parseMaybeJson(grade.stdout)

  check('prediction JSONL has two official rows', predictions.length === 2, `${predictions.length} row(s)`)
  check('prediction rows use official keys', predictions.every((row) => row.instance_id && row.model_name_or_path && typeof row.model_patch === 'string'))
  check('official-style result ingestion updates resolved count', candidateSummary.resolved === 1, `resolved=${candidateSummary.resolved}`)
  check('comparison captures pass-rate delta', comparison.deltas.passRate === 0.5, `delta=${comparison.deltas.passRate}`)
  check(
    'grade command is dry-run by default and names the official Docker harness',
    gradePayload
      ? gradePayload.gradingAuthority === 'official-swebench-harness' &&
        gradePayload.gradingMode === 'dry-run' &&
        gradePayload.requiresDocker === true &&
        String(gradePayload.shellCommand).includes('python -m swebench.harness.run_evaluation')
      : grade.stdout.includes('python -m swebench.harness.run_evaluation'),
    grade.stdout.trim(),
  )
} finally {
  if (keep) console.log(`kept smoke directory: ${dir}`)
  else rmSync(dir, { recursive: true, force: true })
}

process.exit(exitCode)

function runCli(args) {
  const result = Array.isArray(cli[1])
    ? spawnSync(cli[0], [...cli[1], '--', ...args], { cwd: root, encoding: 'utf8' })
    : spawnSync(cli[0], [cli[1], ...args], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error([
      `agent-kernel-host ${args.join(' ')} failed with exit ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

function parseMaybeJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

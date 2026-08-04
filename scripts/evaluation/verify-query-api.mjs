#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-query-api-'))
try {
  const reportPath = join(temporary, 'control-plane.json')
  await runFile('pnpm', ['--dir', 'packages/eval-orchestrator', 'exec', 'vitest', 'run', 'src/control-plane.test.ts', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const assertions = report.testResults.flatMap((file) => file.assertionResults)
  const requiredTests = [
    required(assertions, 'serves real catalog resources and cursor pagination from accepted immutable specs'),
    required(assertions, 'serves run, trial, and artifact query contracts with cursor pagination and filters'),
    required(assertions, 'publishes only complete eligible canonical evidence and replays one authoritative board for all pivots'),
    required(assertions, 'durably controls defect promotion, reproduction, regression, reports, insights, and immutable audit'),
    required(assertions, 'persists authoritative analysis jobs, validates output manifests, and replays terminal job state'),
  ]
  const sourcePaths = [
    'packages/eval-protocol/src/queries.ts',
    'packages/eval-orchestrator/src/control-plane.ts',
    'packages/eval-orchestrator/src/control-plane.test.ts',
    'packages/eval-orchestrator/src/http-server.ts',
    'packages/eval-sdk/src/client.ts',
    'scripts/evaluation/verify-query-api.mjs',
  ]
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const resources = ['catalogs', 'runs', 'trials', 'artifacts', 'reports', 'leaderboards', 'analysis-jobs', 'analysis-output', 'capability-vectors', 'platform-metrics', 'defects', 'reproductions', 'regressions', 'regression-decisions', 'insights', 'audit']
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'versioned authoritative query API contract, cursor pagination, and resource filters',
    sourceRevision,
    sourceFiles,
    requiredTests,
    contract: { endpoint: '/api/v1/query', schema: 'EvaluationQuerySchema', resources, maximumPageSize: 500, malformedCursorRejected: true, invalidPageLimitRejected: true },
    filters: { runsByState: true, trialsByRunAndState: true, artifactsByRunAndTrial: true, leaderboardBySlice: true, leaderboardActiveAudit: true, leaderboardAgentModel: true, leaderboardSort: true, analysisJobsByRunStateKind: true, capabilityVectorsByRunAgentMethodology: true, defectsByRun: true, reproductionsByFinding: true, reportsByRun: true },
    pagination: { cursorContinuation: true, hasMore: true, total: true, catalogCoverage: ['agents', 'datasets', 'tasks', 'task-packs', 'sandboxes', 'verifiers', 'detectors'] },
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, requiredTests: requiredTests.length, resources: resources.length, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function required(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required query API test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

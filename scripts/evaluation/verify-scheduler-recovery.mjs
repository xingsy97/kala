#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-scheduler-recovery-'))
try {
  const reportPaths = { orchestrator: join(temporary, 'orchestrator.json'), worker: join(temporary, 'worker.json') }
  await Promise.all([
    vitest('packages/eval-orchestrator', ['src/control-plane.test.ts'], reportPaths.orchestrator),
    vitest('packages/eval-worker', ['src/worker.integration.test.ts'], reportPaths.worker),
  ])
  const reports = Object.fromEntries(await Promise.all(Object.entries(reportPaths).map(async ([name, path]) => [name, JSON.parse(await readFile(path, 'utf8'))])))
  const assertions = Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, report.testResults.flatMap((file) => file.assertionResults)]))
  const scheduler = [
    required(assertions.orchestrator, 'schedules compatible runs fairly and respects retry backoff after a pre-execution expiry'),
    required(assertions.orchestrator, 'honors priority, backend/provider limits, Worker resources, and the canonical lease ceiling'),
    required(assertions.orchestrator, 'stops scheduling at token, cost, and wall-time budgets and durably blocks queued work'),
    required(assertions.orchestrator, 'automatically retries only declared, observed-safe failure categories and persists failed attempts'),
  ]
  const leases = [
    required(assertions.orchestrator, 'leases only compatible trials and makes result completion idempotent by hash'),
    required(assertions.orchestrator, 'renews a live lease from the Control Plane clock and expires it only after the renewed deadline'),
    required(assertions.worker, 'runs Worker and lease heartbeats and reaps only its labelled orphan set on process start'),
    required(assertions.worker, 'classifies an in-flight trial indeterminate after hard Worker loss stops lease heartbeats'),
    required(assertions.worker, 'retries a lost result acknowledgement against the idempotent committed result'),
  ]
  const cancellation = [
    required(assertions.orchestrator, 'requeues expired work only before any execution receipt and classifies ambiguous work indeterminate'),
    required(assertions.orchestrator, 'classifies expired in-flight work during Control Plane restart and requires an explicit indeterminate retry confirmation'),
    required(assertions.worker, 'calls backend cancellation on timeout and commits a timeout only after cleanup'),
    required(assertions.worker, 'propagates durable run cancellation through a rejected lease heartbeat to the live Agent'),
  ]
  const sourcePaths = [
    'packages/eval-orchestrator/src/control-plane.ts',
    'packages/eval-orchestrator/src/control-plane.test.ts',
    'packages/eval-orchestrator/src/projection.ts',
    'packages/eval-worker/src/worker.ts',
    'packages/eval-worker/src/worker.integration.test.ts',
    'packages/eval-worker/src/trial-runner.ts',
    'packages/eval-worker/src/lease-client.ts',
    'scripts/evaluation/verify-scheduler-recovery.mjs',
  ]
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'durable scheduler, lease/heartbeat/orphan recovery, idempotent completion, cancellation, and indeterminate-effect safety',
    sourceRevision,
    sourceFiles,
    scheduler,
    leases,
    cancellation,
    coverage: { fairness: true, priority: true, concurrencyLimits: true, workerCapacityBackpressure: true, tokenCostWallBudgets: true, selectiveRetry: true, heartbeatRenewal: true, leaseExpiry: true, orphanRecovery: true, workerDeath: true, duplicateCompletion: true, lostResultAcknowledgement: true, durableCancellation: true, blindIndeterminateReplayRejected: true },
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, scheduler: scheduler.length, leases: leases.length, cancellation: cancellation.length, coverage: Object.keys(evidence.coverage).length, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function vitest(directory, files, output) { await runFile('pnpm', ['--dir', directory, 'exec', 'vitest', 'run', ...files, '--reporter=json', '--outputFile=' + output], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }) }
function required(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required scheduler/recovery test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

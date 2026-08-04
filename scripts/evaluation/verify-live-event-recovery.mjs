#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-live-event-recovery-'))
try {
  const orchestratorReport = join(temporary, 'http-server.json')
  const dashboardReport = join(temporary, 'dashboard.json')
  const browserEvidencePath = join(temporary, 'dashboard-browser.json')
  await Promise.all([
    vitest('packages/eval-orchestrator', ['src/http-server.test.ts'], orchestratorReport),
    vitest('packages/eval-dashboard', ['src/client.test.ts', 'src/app.test.tsx'], dashboardReport),
    runFile('pnpm', ['verify:evaluation-dashboard-browser', '--', '--output', browserEvidencePath], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 }),
  ])
  const reports = await Promise.all([orchestratorReport, dashboardReport].map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
  const assertions = reports.flatMap((report) => report.testResults.flatMap((file) => file.assertionResults))
  const requiredTests = [
    required(assertions, 'serves durable SSE catch-up starting after the requested sequence'),
    required(assertions, 'resumes durable SSE catch-up after a dropped connection without replaying acknowledged events'),
    required(assertions, 'reconnects after a dropped event from the last durable sequence and ignores duplicate delivery'),
    required(assertions, 'treats live events as notifications and reloads the authoritative projection'),
  ]
  const browserEvidence = JSON.parse(await readFile(browserEvidencePath, 'utf8'))
  if (browserEvidence.summary?.liveEventRecoveryChecks !== 1 || browserEvidence.summary?.failures !== 0) throw new Error('real-browser live-event recovery acceptance did not pass')
  const liveEvents = browserEvidence.liveEvents
  if (liveEvents?.sequence !== '2' || liveEvents?.liveState !== 'connected' || !liveEvents?.droppedSequenceDetected || !liveEvents?.resumedAfterSequence || liveEvents?.authoritativeQueries < 2) throw new Error('real-browser durable catch-up evidence is incomplete')
  const sourcePaths = [
    'packages/eval-orchestrator/src/http-server.ts',
    'packages/eval-orchestrator/src/http-server.test.ts',
    'packages/eval-dashboard/src/client.ts',
    'packages/eval-dashboard/src/client.test.ts',
    'packages/eval-dashboard/src/app.tsx',
    'packages/eval-dashboard/src/app.test.tsx',
    'scripts/evaluation/dashboard-fixture-server.mjs',
    'scripts/evaluation/verify-dashboard-browser.mjs',
    'scripts/evaluation/verify-live-event-recovery.mjs',
  ]
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'ordered non-authoritative SSE notifications with durable sequence catch-up and authoritative Dashboard reload',
    sourceRevision,
    sourceFiles,
    requiredTests,
    server: { endpoint: '/api/v1/events', orderedDurableSequence: true, afterCursor: true, lastEventId: true, acknowledgedEventsNotReplayed: true },
    dashboard: { eventPayloadIsNonAuthoritative: true, projectionReloadAfterNotification: true, duplicateDeliveryIgnored: true, sequenceGapDetected: true, reconnectFromLastContiguousSequence: true, reconnectStateVisible: true },
    browser: { version: browserEvidence.browser.version, routeStateChecks: browserEvidence.summary.routeStateChecks, liveEventRecoveryChecks: browserEvidence.summary.liveEventRecoveryChecks, ...liveEvents },
    browserEvidenceSha256: sha256(await readFile(browserEvidencePath)),
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, requiredTests: requiredTests.length, browserChecks: 1, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function vitest(directory, files, output) { await runFile('pnpm', ['--dir', directory, 'exec', 'vitest', 'run', ...files, '--reporter=json', '--outputFile=' + output], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }) }
function required(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required live-event recovery test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-control-plane-parity-'))
try {
  const orchestratorReportPath = join(temporary, 'http-server.json')
  const dashboardReportPath = join(temporary, 'dashboard-client.json')
  await Promise.all([
    runFile('pnpm', ['--dir', 'packages/eval-orchestrator', 'exec', 'vitest', 'run', 'src/http-server.test.ts', '--reporter=json', '--outputFile=' + orchestratorReportPath], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }),
    runFile('pnpm', ['--dir', 'packages/eval-dashboard', 'exec', 'vitest', 'run', 'src/client.test.ts', '--reporter=json', '--outputFile=' + dashboardReportPath], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }),
  ])
  const reports = await Promise.all([orchestratorReportPath, dashboardReportPath].map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
  const assertions = reports.flatMap((report) => report.testResults.flatMap((file) => file.assertionResults))
  const requiredTests = [
    required(assertions, 'provides CLI/Web client parity with durable projection and committed acknowledgements'),
    required(assertions, 'executes the real CLI against the same HTTP commands and queries as the SDK client'),
    required(assertions, 'returns the same committed acknowledgement after restart and rejects an idempotency collision over HTTP'),
    required(assertions, 'delegates UI commands to the shared versioned client and returns its committed acknowledgement'),
    required(assertions, 'loads normalized trace content only through the contained artifact endpoint'),
  ]
  const sourcePaths = [
    'packages/eval-protocol/src/commands.ts',
    'packages/eval-protocol/src/run-events.ts',
    'packages/eval-sdk/src/client.ts',
    'packages/eval-orchestrator/bin/eval-cli.ts',
    'packages/eval-orchestrator/src/control-plane.ts',
    'packages/eval-orchestrator/src/http-server.ts',
    'packages/eval-orchestrator/src/http-server.test.ts',
    'packages/eval-orchestrator/src/journal.ts',
    'packages/eval-orchestrator/src/model.ts',
    'packages/eval-orchestrator/src/projection.ts',
    'packages/eval-dashboard/src/client.ts',
    'packages/eval-dashboard/src/client.test.ts',
    'scripts/evaluation/verify-control-plane-parity.mjs',
  ]
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'real CLI and SDK/Web-style HTTP clients using one durable versioned Control Plane command/query API',
    sourceRevision,
    sourceFiles,
    requiredTests,
    assertions: {
      commandEndpoint: '/api/v1/commands',
      queryEndpoint: '/api/v1/query',
      committedAcknowledgementFields: ['idempotencyKey', 'commandId', 'committedSequence', 'committedAt', 'projectionVersion'],
      duplicateSamePayload: 'same acknowledgement and no new transaction',
      duplicateDifferentPayload: 'HTTP 409 CONFLICT and no new transaction',
      restartDurability: true,
      realCliProcessParity: true,
      dashboardSharedClientDelegation: true,
      dashboardContainedArtifactReads: true,
    },
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, requiredTests: requiredTests.length, restartDurability: true, realCliProcessParity: true, dashboardSharedClientDelegation: true, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function required(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required parity test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

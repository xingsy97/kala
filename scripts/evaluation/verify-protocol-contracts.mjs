#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-protocol-contracts-'))
try {
  const reportPath = join(temporary, 'protocol.json')
  await runFile('pnpm', ['--dir', 'packages/eval-protocol', 'exec', 'vitest', 'run', 'src/protocol.test.ts', '--reporter=json', '--outputFile=' + reportPath], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const assertions = report.testResults.flatMap((file) => file.assertionResults)
  const groups = {
    statesAndEvents: [
      required(assertions, 'requires monotonic durable events'),
      required(assertions, 'replays only legal typed run/trial state transitions'),
      required(assertions, 'property-checks reducer replay determinism and rejects every sequence corruption'),
    ],
    evidenceAndFailures: [
      required(assertions, 'parses the canonical result fixture and verifies its manifest/result hashes'),
      required(assertions, 'never lets smoke or ungraded evidence claim official authority'),
      required(assertions, 'enforces structured failure responsibility and typed reproduction execution'),
    ],
    datasetsAndSlices: [
      required(assertions, 'enforces truthful full/subset/sample identity and labels'),
      required(assertions, 'binds every selection kind to an immutable task-ID manifest'),
      required(assertions, 'property-checks every slice kind, truthful coverage, and sample provenance'),
      required(assertions, 'versions Leaderboard filters, sort, audit, and invalidation as protocol contracts'),
    ],
    pluginAndCoordinationContracts: [
      required(assertions, 'requires contained artifact paths, unique entries, and valid leases'),
      required(assertions, 'negotiates protocol capabilities and rejects incompatible descriptors'),
      required(assertions, 'accepts namespaced external plugins while keeping external Agents unranked and non-official'),
    ],
    productEvidenceContracts: [
      required(assertions, 'migrates only canonical platform schemas through explicit forward steps'),
      required(assertions, 'requires explicit review, redaction evidence, and provenance approval for private public task packs'),
      required(assertions, 'blocks unsafe reproduction publication, incomplete reports, and unsupported validated insights'),
    ],
  }
  const protocolSourceNames = (await readdir(resolve(root, 'packages/eval-protocol/src'))).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort()
  const sourcePaths = [...protocolSourceNames.map((name) => 'packages/eval-protocol/src/' + name), 'packages/eval-protocol/src/protocol.test.ts', 'scripts/evaluation/verify-protocol-contracts.mjs']
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'canonical event, evidence, failure, dataset/slice, plugin, lease, analysis, defect, reproduction, regression, insight, report, and audit contracts',
    sourceRevision,
    sourceFiles,
    groups,
    summary: { requiredTests: Object.values(groups).flat().length, protocolSourceFiles: protocolSourceNames.length, stateReplayProperties: true, evidenceAuthority: true, truthfulDatasetSlices: true, capabilityNegotiation: true, explicitForwardMigrationOnly: true, canonicalV1BackwardReadable: true, preRefactorHostArtifactsRejected: true, productEvidencePublicationGuards: true },
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, ...evidence.summary, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function required(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required protocol contract test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

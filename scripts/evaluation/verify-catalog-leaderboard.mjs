#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-catalog-leaderboard-'))
try {
  const reports = { protocol: join(temporary, 'protocol.json'), orchestrator: join(temporary, 'orchestrator.json') }
  await Promise.all([
    vitest('packages/eval-protocol', ['src/protocol.test.ts'], reports.protocol),
    vitest('packages/eval-orchestrator', ['src/control-plane.test.ts'], reports.orchestrator),
  ])
  const parsed = Object.fromEntries(await Promise.all(Object.entries(reports).map(async ([name, path]) => [name, JSON.parse(await readFile(path, 'utf8'))])))
  const assertions = Object.fromEntries(Object.entries(parsed).map(([name, report]) => [name, report.testResults.flatMap((file) => file.assertionResults)]))
  const requiredTests = [
    required(assertions.protocol, 'enforces truthful full/subset/sample identity and labels'),
    required(assertions.protocol, 'binds every selection kind to an immutable task-ID manifest'),
    required(assertions.protocol, 'property-checks every slice kind, truthful coverage, and sample provenance'),
    required(assertions.protocol, 'enforces the complete Leaderboard eligibility and comparability identity matrix'),
    required(assertions.protocol, 'versions Leaderboard filters, sort, audit, and invalidation as protocol contracts'),
    required(assertions.orchestrator, 'serves real catalog resources and cursor pagination from accepted immutable specs'),
    required(assertions.orchestrator, 'restores the task and evaluated-slice catalog from the sole durable journal without startup catalog input'),
    required(assertions.orchestrator, 'publishes only complete eligible canonical evidence and replays one authoritative board for all pivots'),
  ]
  const browserEvidencePath = resolve(root, 'docs/evidence/evaluation/dashboard-browser-acceptance-20260803.json')
  const browserEvidence = JSON.parse(await readFile(browserEvidencePath, 'utf8'))
  if (browserEvidence.leaderboard?.pivots?.length !== 3 || browserEvidence.leaderboard?.querySliceHashes?.length !== 1 || browserEvidence.summary?.failures !== 0 || browserEvidence.leaderboard?.audit?.view !== 'audit' || browserEvidence.leaderboard?.expansion?.links?.length !== 4 || browserEvidence.leaderboard?.comparison?.urlSlice === undefined) throw new Error('real-browser Leaderboard pivot/slice/audit/export evidence is incomplete')
  const sourcePaths = [
    'packages/eval-protocol/src/datasets.ts',
    'packages/eval-protocol/src/leaderboard.ts',
    'packages/eval-protocol/src/protocol.test.ts',
    'packages/eval-orchestrator/src/task-catalog.ts',
    'packages/eval-orchestrator/src/control-plane.ts',
    'packages/eval-orchestrator/src/control-plane.test.ts',
    'packages/eval-dashboard/src/app.tsx',
    'scripts/evaluation/verify-dashboard-browser.mjs',
    'scripts/evaluation/verify-catalog-leaderboard.mjs',
  ]
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])))
  const sourceRevision = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim()
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'immutable dataset/version/slice catalog and rank-eligible, slice-isolated Leaderboards across all three pivots',
    sourceRevision,
    sourceFiles,
    requiredTests,
    catalog: { durableJournalReplay: true, startupInputNotRequiredAfterReplay: true, cursorPagination: true, selectionKinds: ['full', 'official_subset', 'named_subset', 'explicit_ids', 'sampled'], immutableTaskIdsHash: true, truthfulCoverageAndLabels: true },
    eligibility: { officialEvidenceRequiredForOfficialDataset: true, completedTrialsMustEqualExpected: true, positiveRepeats: true, verifierVersionRequired: true, smokeRejected: true, nativeRejectedForOfficialDataset: true },
    comparabilityIdentity: ['datasetId', 'datasetVersion', 'split', 'sliceManifestHash', 'verifierVersion', 'repeatPolicyHash', 'evidenceLevel'],
    browser: { pivots: browserEvidence.leaderboard.pivots.map((pivot) => pivot.pivot), exactSliceHashes: browserEvidence.leaderboard.querySliceHashes, labelsIncludeSelectionCountCoverageSeedAndFilters: true, urlFilterSort: browserEvidence.leaderboard.audit.url, inactiveAuditWithoutRank: browserEvidence.leaderboard.audit.ranks.every((rank) => rank === '—'), rowExpansionLinks: browserEvidence.leaderboard.expansion.links, warningGatedCrossSliceExploration: browserEvidence.leaderboard.comparison, provenanceExports: browserEvidence.leaderboard.pivots.map((pivot) => ({ csv: pivot.csvDownload, json: pivot.jsonDownload })), failures: browserEvidence.summary.failures },
    browserEvidenceSha256: sha256(await readFile(browserEvidencePath)),
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, requiredTests: requiredTests.length, selectionKinds: evidence.catalog.selectionKinds.length, pivots: evidence.browser.pivots.length, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function vitest(directory, files, output) { await runFile('pnpm', ['--dir', directory, 'exec', 'vitest', 'run', ...files, '--reporter=json', '--outputFile=' + output], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }) }
function required(assertions, title) {
  const matches = assertions.filter((assertion) => assertion.title === title)
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required catalog/Leaderboard test did not pass exactly once: ' + title)
  return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

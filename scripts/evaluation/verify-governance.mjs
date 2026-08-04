#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { DatasetVersionRefSchema, EvaluationRunSpecSchema, ResolvedTaskSchema, decideCatalogPolicy, findPlaintextCredentialPaths } from '../../packages/eval-protocol/dist/index.js'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-governance-'))

try {
  const reports = Object.fromEntries(['protocol', 'worker', 'orchestrator', 'environmentCommon', 'environmentDocker', 'sweBench'].map((name) => [name, join(temporary, name + '.json')]))
  await Promise.all([
    vitest('packages/eval-protocol', ['src/protocol.test.ts'], reports.protocol),
    vitest('packages/eval-worker', ['src/artifact-stager.test.ts', 'src/worker.integration.test.ts'], reports.worker),
    vitest('packages/eval-orchestrator', ['src/artifact-store.test.ts', 'src/control-plane.test.ts', 'src/report-generator.test.ts'], reports.orchestrator),
    vitest('adapters/environments/common', ['src/lxd.test.ts'], reports.environmentCommon),
    vitest('adapters/environments/docker', ['src/index.test.ts'], reports.environmentDocker),
    vitest('adapters/benchmarks/swe-bench', ['src/index.test.ts'], reports.sweBench),
  ])
  const parsed = Object.fromEntries(await Promise.all(Object.entries(reports).map(async ([name, path]) => [name, JSON.parse(await readFile(path, 'utf8'))])))
  const assertions = Object.fromEntries(Object.entries(parsed).map(([name, report]) => [name, report.testResults.flatMap((file) => file.assertionResults)]))
  const controls = {
    credentialReferences: [
      required(assertions.protocol, 'rejects plaintext credential-like fields and accepts credential references'),
      required(assertions.worker, 'redacts referenced and generic secrets from failure artifacts and hashes the redacted result'),
      required(assertions.environmentDocker, 'keeps environment secrets out of host argv and removes the 0600 guest file'),
      required(assertions.environmentCommon, 'keeps secrets out of host argv and deletes the 0600 guest file after execution'),
    ],
    pathContainment: [
      required(assertions.protocol, 'requires contained artifact paths, unique entries, and valid leases'),
      required(assertions.worker, 'imports only regular allowlisted files contained by the provider artifact root'),
      required(assertions.orchestrator, 'reads only regular contained files whose size and hash match authority metadata'),
      required(assertions.orchestrator, 'rejects symlink files even when they point inside or outside the root'),
      required(assertions.orchestrator, 'rejects private absolute paths before producing public report files'),
    ],
    retentionDeletionAudit: [
      required(assertions.orchestrator, 'durably controls defect promotion, reproduction, regression, reports, insights, and immutable audit'),
    ],
    provenance: [
      required(assertions.protocol, 'defaults every unknown, denied, and unreviewed catalog policy dimension to denial'),
      required(assertions.sweBench, 'resolves a fresh immutable task without consulting Host runs or sessions'),
      required(assertions.sweBench, 'rejects a derived trial image whose official OCI lineage does not match'),
      required(assertions.sweBench, 'refuses evidence from any unpinned harness revision'),
    ],
    cleanCutoverProtocol: [required(assertions.protocol, 'is a clean-cutover protocol and does not expose a legacy Host parser')],
  }
  const [boundaries, cleanCutover] = await Promise.all([
    command(process.execPath, ['scripts/evaluation/verify-boundaries.mjs']),
    command(process.execPath, ['scripts/evaluation/verify-clean-cutover.mjs']),
  ])
  const dashboard = JSON.parse(await readFile(join(root, 'docs/evidence/evaluation/dashboard-browser-acceptance-20260803.json'), 'utf8'))
  const administrationEntries = dashboard.stateMatrix.filter((entry) => entry.expectedRoute === 'administration')
  const requiredAdministrationScenarios = ['loading', 'ready', 'empty', 'partial', 'error', 'unsupported-capability', 'unsupported-protocol', 'offline', 'stale']
  const administrationScenarios = [...new Set(administrationEntries.map((entry) => entry.scenario))].sort()
  if (JSON.stringify(administrationScenarios) !== JSON.stringify([...requiredAdministrationScenarios].sort())
    || administrationEntries.some((entry) => entry.loadState !== entry.expected)
    || !dashboard.responsive.some((entry) => entry.route === 'administration' && entry.viewport === 'mobile')) {
    throw new Error('Administration/Audit browser acceptance evidence is incomplete')
  }
  const administrationChecks = administrationEntries.length
  if (dashboard.internationalization?.initial?.language !== 'zh-CN' || dashboard.internationalization?.switched?.language !== 'en' || dashboard.productWorkflows?.largeTrace?.virtualized !== 'true') throw new Error('Dashboard internationalization or normalized-trace governance evidence is incomplete')

  const canonical = JSON.parse(await readFile(join(root, 'packages/eval-protocol/fixtures/canonical-run-spec-v1.json'), 'utf8'))
  if (findPlaintextCredentialPaths(canonical).length || !EvaluationRunSpecSchema.safeParse(canonical).success) throw new Error('canonical run credential-reference governance failed')
  const denialChecks = {
    taskUnknownLicenseRejected: policyDenied(ResolvedTaskSchema.parse(taskFixture({ policy: fixturePolicy({ license: { status: 'unknown' } }) })).policy),
    taskDeniedPermissionRejected: policyDenied(ResolvedTaskSchema.parse(taskFixture({ policy: fixturePolicy({ permissions: { evaluation: { status: 'denied', basis: 'evaluation denied' }, training: { status: 'unreviewed' } } }) })).policy),
    datasetUnknownLicenseRejected: policyDenied(DatasetVersionRefSchema.parse(datasetFixture({ policy: fixturePolicy({ license: { status: 'unknown' } }) })).policy),
    datasetUnreviewedPermissionRejected: policyDenied(DatasetVersionRefSchema.parse(datasetFixture({ policy: fixturePolicy({ permissions: { evaluation: { status: 'unreviewed', basis: 'private workspace' }, training: { status: 'unreviewed' } } }) })).policy),
  }
  if (Object.values(denialChecks).some((passed) => !passed)) throw new Error('publication governance denial checks failed')

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'standalone governance gates over current source and fresh synthetic data; historical Host evaluation data is rejected and never discovered',
    controls,
    administrationAuditBrowserChecks: administrationChecks,
    dashboardGovernance: { internationalization: dashboard.internationalization, normalizedTrace: dashboard.productWorkflows.largeTrace, errorBoundaryTest: 'contains render failures without exposing error detail or mutating durable state' },
    runtimeChecks: { credentialPathsPersisted: [], canonicalCredentialReferences: canonical.agents.flatMap((agent) => agent.credentialRefs.map((reference) => reference.referenceId)), publicationDenials: denialChecks },
    cleanCutover: { boundaries: JSON.parse(boundaries.stdout), sourceScan: JSON.parse(cleanCutover.stdout), historicalPolicy: 'reject-and-never-discover', importSurface: 'none' },
    sourceHashes: await sourceHashes([
      'packages/eval-protocol/src/common.ts', 'packages/eval-protocol/src/tasks.ts', 'packages/eval-protocol/src/datasets.ts', 'packages/eval-protocol/src/protocol.test.ts',
      'packages/eval-worker/src/artifact-stager.ts', 'packages/eval-worker/src/artifact-stager.test.ts', 'packages/eval-orchestrator/src/artifact-store.ts', 'packages/eval-orchestrator/src/control-plane.ts',
      'scripts/evaluation/verify-boundaries.mjs', 'scripts/evaluation/verify-clean-cutover.mjs', 'scripts/evaluation/verify-governance.mjs',
    ]),
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, credentialTests: controls.credentialReferences.length, pathTests: controls.pathContainment.length, provenanceTests: controls.provenance.length, administrationChecks, historicalPolicy: evidence.cleanCutover.historicalPolicy, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function taskFixture(overrides = {}) {
  return { schemaVersion: 1, taskId: 'governance-task', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Governance fixture', prompt: 'Verify governance.', repository: { kind: 'artifact', archiveRef: 'fixtures/task.tar', archiveSha256: 'a'.repeat(64), revision: 'fixture-v1' }, fixtureManifestHash: 'a'.repeat(64), faultScenarioIds: [], verification: [{ stepId: 'verify', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: fixturePolicy(), ...overrides }
}
function datasetFixture(overrides = {}) { return { datasetId: 'governance-dataset', displayName: 'Governance Dataset', version: '1', sourceRevision: 'fixture-v1', manifestHash: 'a'.repeat(64), taskIdsHash: 'b'.repeat(64), totalItems: 1, officialBenchmark: false, policy: fixturePolicy(), ...overrides } }
function fixturePolicy(overrides = {}) { return { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'public synthetic evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:governance'] }, publication: { artifact: { status: 'granted', basis: 'fixture' }, report: { status: 'granted', basis: 'fixture' }, leaderboard: { status: 'granted', basis: 'fixture' }, redistribution: { status: 'granted', basis: 'MIT' } }, ...overrides } }
function policyDenied(policy) { return !decideCatalogPolicy({ operation: 'run_admission', dataset: policy, taskPack: policy }).allowed }
function required(assertions, title) { const matches = assertions.filter((assertion) => assertion.title === title); if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('required governance test did not pass exactly once: ' + title); return { test: matches[0].fullName, status: matches[0].status, durationMs: matches[0].duration } }
async function vitest(directory, files, output) { await command('pnpm', ['--dir', directory, 'exec', 'vitest', 'run', ...files, '--reporter=json', '--outputFile=' + output]) }
async function command(binary, args) { return await runFile(binary, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }) }
async function sourceHashes(paths) { return await Promise.all(paths.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') }))) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

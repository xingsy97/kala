#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { canonicalJson, sha256Hex, verifyTrialEvidence } from '../../packages/eval-protocol/dist/index.js'
import { ControlPlaneClient, generateMetamorphicVariant } from '../../packages/eval-sdk/dist/index.js'
import { EvaluationControlPlane, RegisteredTaskCatalog, createEvaluationHttpServer } from '../../packages/eval-orchestrator/dist/src/index.js'
import { EvaluationWorker, WorkerRuntimeRegistry } from '../../packages/eval-worker/dist/src/index.js'
import { EvaluationAnalyzer, EvaluationGrader } from '../../packages/eval-analyzer/dist/src/index.js'
import { DockerSandboxProvider } from '../../adapters/environments/docker/dist/index.js'
import { createCustomCommandAgentBackend } from '../../adapters/agents/custom-command/dist/index.js'
import { createCustomTaskPackAdapter } from '../../adapters/benchmarks/custom-task-pack/dist/index.js'
import { createProgramBenchAdapter } from '../../adapters/benchmarks/program-bench/dist/index.js'
import { createSweMarathonAdapter } from '../../adapters/benchmarks/swe-marathon/dist/index.js'
import { createEphemeralAuth } from './fixtures/ephemeral-auth.mjs'

const runFile = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const mode = option('--mode')
if (mode !== 'swe-marathon' && mode !== 'metamorphic') throw new Error('--mode must be swe-marathon or metamorphic')
const imageDigest = option('--image') ?? 'mcr.microsoft.com/devcontainers/typescript-node@sha256:3ff0e3ff2f98928cb4cd1faab2b3338161b13007c04e9b0f1d2d89a69c75e676'
if (!/@sha256:[a-f0-9]{64}$/u.test(imageDigest)) throw new Error('--image must use a pinned OCI repository digest')
const temporary = await mkdtemp(join(tmpdir(), 'agent-eval-remaining-lifecycles-'))
const dataRoot = join(temporary, 'platform')
const artifactRoot = join(dataRoot, 'artifacts')
const workerDataDir = join(temporary, 'worker')
await Promise.all([mkdir(artifactRoot, { recursive: true, mode: 0o700 }), mkdir(workerDataDir, { recursive: true, mode: 0o700 })])

const marathon = await preparedMarathon(workerDataDir)
const metamorphic = await preparedMetamorphic(workerDataDir)
const tasks = mode === 'swe-marathon' ? [marathon.task] : metamorphic.tasks
const taskIds = tasks.map((task) => task.taskId)
const taskIdsHash = await sha256Hex(canonicalJson(taskIds))
const selectedPrepared = mode === 'swe-marathon' ? [marathon] : metamorphic.prepared
const sliceManifestHash = await sha256Hex(canonicalJson({ taskIds, fixtures: selectedPrepared.map((item) => ({ taskId: item.taskId, fixtureManifestHash: item.fixtureManifestHash })) }))
const runId = 'fresh-' + mode + '-lifecycle-' + new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14) + '-' + process.pid
const variantId = 'deterministic-lifecycle-agent'
const commandConfig = { argv: ['sh', '-ceu', 'printf "lifecycle accepted\n"'] }
const variant = { variantId, backendId: 'custom-command', agentVersion: '1.0.0', model: { modelId: 'deterministic-command' }, configHash: await sha256Hex(canonicalJson(commandConfig)), config: commandConfig, credentialRefs: [] }
const spec = {
  schemaVersion: 1, runId,
  taskPack: { id: mode === 'swe-marathon' ? 'swe-marathon' : 'program-bench', version: '1.0.0', evaluatedSlice: { sliceId: mode + '-full', dataset: { datasetId: mode + '-lifecycle', displayName: mode + ' lifecycle acceptance', version: '1.0.0', sourceRevision: sliceManifestHash, manifestHash: sliceManifestHash, taskIdsHash, totalItems: tasks.length, officialBenchmark: false, license: 'MIT', evaluationPermission: 'public synthetic evaluation' }, selectionKind: 'full', selectionSpec: { kind: 'full', taskIdsHash }, selectedItems: tasks.length, coverageRatio: 1, taskIdsManifestRef: 'catalog/' + mode + '.json', sliceManifestHash } },
  agents: [variant],
  execution: { repeats: 1, priority: 0, maxConcurrency: 2, maxConcurrencyPerBackend: 2, maxConcurrencyPerProvider: 2, leaseMs: 30_000, timeoutMs: 120_000, inactivityTimeoutMs: 10_000, retryPolicy: { maxAttempts: 1, retryableCategories: [], backoffMs: 0 } },
  sandbox: { provider: 'docker', imageDigest, readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 512, diskMb: 2048, pids: 128 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: tasks.map((task) => task.taskPackId + '/' + runId + ':' + task.taskId + ':' + variantId + ':0/native-result.json') },
  verification: { verifierId: mode === 'swe-marathon' ? 'swe-marathon-native' : 'program-bench-native', verifierVersion: '1.0.0', officialRequired: false, timeoutMs: 120_000, configHash: await sha256Hex(canonicalJson(tasks.map((task) => task.verification))) },
  analysis: { detectorIds: ['instruction-drift'], repeatsRequired: 1, configHash: await sha256Hex(canonicalJson({ detectorSet: 'required-v1' })) },
  createdAt: new Date().toISOString(),
}
const catalog = new RegisteredTaskCatalog()
catalog.register(sliceManifestHash, tasks)
const controlPlane = new EvaluationControlPlane({ journalPath: join(dataRoot, 'control-plane.jsonl'), reportRoot: artifactRoot, taskCatalog: catalog })
await controlPlane.initialize()
const workerId = 'remaining-benchmarks-' + process.pid
const graderId = 'remaining-grader-' + process.pid
const analyzerId = 'remaining-analyzer-' + process.pid
const auth = createEphemeralAuth({ workerId, analyzerIds: [graderId, analyzerId] })
const server = createEvaluationHttpServer(controlPlane, { authenticator: auth.authenticator })
await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise) })
const controlPlaneUrl = 'http://127.0.0.1:' + String(server.address().port)
const client = new ControlPlaneClient({ baseUrl: controlPlaneUrl, credentialProvider: auth.operatorCredentials })
const workerClient = new ControlPlaneClient({ baseUrl: controlPlaneUrl, credentialProvider: auth.workerCredentials })
const registry = new WorkerRuntimeRegistry()
const provider = tracked(new DockerSandboxProvider())
registry.registerSandbox(provider)
registry.registerAgent(createCustomCommandAgentBackend())
registry.registerBenchmark(createSweMarathonAdapter())
registry.registerBenchmark(createCustomTaskPackAdapter())
registry.registerBenchmark(createProgramBenchAdapter())
const workerErrors = []
const worker = new EvaluationWorker({ controlPlane: workerClient, registry, credentials: { resolve: async () => ({}), available: async () => true }, workerId, workerVersion: '0.0.0', cpu: 2, memoryMb: 2048, diskMb: 8192, gpu: 0, maxTrials: 2, leaseMs: 30_000, artifactRoot, workerDataDir, cancellationGraceMs: 5_000, onTrialError: (error, trialId) => workerErrors.push({ trialId, message: message(error) }) })

try {
  await client.command(command('run.create', { spec }))
  await client.command(command('run.start', { runId }))
  await worker.runUntilIdle({ idlePolls: 3, pollIntervalMs: 100 })
  await client.command(command('run.grade', { runId }))
  await client.command(command('run.analyze', { runId, detectorIds: spec.analysis.detectorIds }))
  await Promise.all([
    new EvaluationGrader({ controlPlane: new ControlPlaneClient({ baseUrl: controlPlaneUrl, credentialProvider: auth.analyzerCredentials(graderId) }), executorId: graderId, leaseMs: 30_000, pollIntervalMs: 100 }).runUntilIdle({ idlePolls: 1 }),
    new EvaluationAnalyzer({ controlPlane: new ControlPlaneClient({ baseUrl: controlPlaneUrl, credentialProvider: auth.analyzerCredentials(analyzerId) }), executorId: analyzerId, leaseMs: 30_000, pollIntervalMs: 100 }).runUntilIdle({ idlePolls: 1 }),
  ])
} finally {
  await provider.reapOrphans(worker.registration.workerId).catch(() => undefined)
  await new Promise((resolvePromise) => server.close(() => resolvePromise()))
}

const runProjection = controlPlane.projection.runs.get(runId)
const trials = runProjection?.trialIds.map((trialId) => controlPlane.projection.trials.get(trialId)) ?? []
if (runProjection?.state !== 'completed' || trials.length !== tasks.length || trials.some((trial) => trial?.state !== 'completed' || !trial.evidence)) throw new Error('remaining benchmark run did not complete: ' + JSON.stringify({ state: runProjection?.state, workerErrors }))
if (provider.created.length !== tasks.length || provider.destroyed.size !== tasks.length) throw new Error('remaining benchmark run did not use and destroy one fresh sandbox per trial')
const jobs = [...controlPlane.projection.analysisJobs.values()].filter((job) => job.runId === runId)
if (jobs.length !== 2 || jobs.some((job) => job.state !== 'completed' || !controlPlane.projection.analysisOutputs.has(job.jobId))) throw new Error('remaining benchmark grading/analyzer jobs did not complete')

const trialEvidence = []
for (const trial of trials) {
  const evidence = await verifyTrialEvidence(trial.evidence)
  const expected = tasks.find((task) => task.taskId === trial.taskId)
  if (!expected || evidence.benchmarkResult.benchmarkId !== expected.taskPackId || evidence.evidenceLevel !== 'native' || evidence.normalizedEventCount !== 2) throw new Error('remaining benchmark canonical evidence mismatch: ' + trial.trialId)
  for (const path of [evidence.nativeEventsRef, evidence.normalizedEventsRef, evidence.finalDiffRef, evidence.benchmarkResult.rawResultRef]) await verifyArtifact(evidence, path)
  trialEvidence.push({ trialId: trial.trialId, taskId: trial.taskId, benchmarkId: evidence.benchmarkResult.benchmarkId, sandboxId: provider.created.find((entry) => entry.trialId === trial.trialId)?.sandboxId, resultHash: evidence.resultHash, artifactManifestHash: evidence.artifactManifest.manifestHash, normalizedEventCount: evidence.normalizedEventCount, nativeMetrics: evidence.benchmarkResult.nativeMetrics })
}
const marathonTrial = trialEvidence.find((trial) => trial.benchmarkId === 'swe-marathon')
const metamorphicTrials = trialEvidence.filter((trial) => trial.benchmarkId === 'program-bench')
if (mode === 'swe-marathon' && (marathonTrial?.nativeMetrics.resolved_tasks !== 2 || marathonTrial.nativeMetrics.total_tasks !== 3 || marathonTrial.nativeMetrics.verifier_protocol_valid !== true)) throw new Error('SWE-Marathon native lifecycle metrics mismatch')
if (mode === 'metamorphic' && (metamorphicTrials.length !== 6 || metamorphicTrials.some((trial) => trial.nativeMetrics.compile_passed !== true || trial.nativeMetrics.tests_passed !== true || trial.nativeMetrics.verifier_protocol_valid !== true))) throw new Error('metamorphic variant lifecycle metrics mismatch')

const sourcePaths = ['scripts/evaluation/verify-remaining-benchmark-lifecycles.mjs', 'adapters/benchmarks/swe-marathon/src/index.ts', 'adapters/benchmarks/custom-task-pack/src/index.ts', 'packages/eval-worker/src/trial-runner.ts', 'packages/eval-orchestrator/src/control-plane.ts', 'packages/eval-analyzer/src/runner.ts', 'packages/eval-sdk/src/metamorphic.ts']
const output = resolve(option('--output') ?? 'docs/evidence/evaluation/' + mode + '-lifecycle-acceptance-20260803.json')
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'current-source accepted-spec Control Plane to Worker to fresh Docker sandbox to native verifier to canonical evidence to grader/analyzer lifecycle for ' + mode + '; no historical Session input', sourceRevision: (await runFile('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim(), sourceFiles: Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha256(await readFile(resolve(root, path)))]))), mode, runId, runState: runProjection.state, trialCount: trials.length, freshSandboxes: provider.created.length, cleanupVerified: true, workerErrors, gradingJobId: jobs.find((job) => job.kind === 'grading')?.jobId, analysisJobId: jobs.find((job) => job.kind === 'detectors')?.jobId, ...(mode === 'swe-marathon' ? { sweMarathon: marathonTrial } : { metamorphicVariants: metamorphicTrials }), runtimeResidue: await runtimeResidue() }
if (Object.values(report.runtimeResidue).some((items) => items.length > 0)) throw new Error('managed runtime residue remains after remaining benchmark lifecycle')
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await writeFile(output, JSON.stringify(report, null, 2) + String.fromCharCode(10), { mode: 0o600 })
process.stdout.write(JSON.stringify({ ok: true, mode, runId, trials: trials.length, freshSandboxes: provider.created.length, cleanupVerified: true, output }) + String.fromCharCode(10))

async function preparedMarathon(workerRoot) {
  const taskId = 'public-release-marathon'
  const files = { 'TASK.md': '# Reconcile a synthetic three-task release marathon\n', 'outcomes/task-a': '1\n', 'outcomes/task-b': '0\n', 'outcomes/task-c': '1\n', 'package.json': '{"name":"release-marathon","private":true}\n' }
  const prepared = await repository(workerRoot, taskId, files, 'swe-marathon')
  const script = 'total=$(find outcomes -type f | wc -l | tr -d " "); resolved=$(grep -l "^1$" outcomes/* | wc -l | tr -d " "); test "$total" -eq 3; test "$resolved" -eq 2; printf "{\\"metrics\\":{\\"resolved_tasks\\":%s,\\"total_tasks\\":%s}}\\n" "$resolved" "$total"'
  const verification = [{ stepId: 'native-resolution', nativeMetric: 'resolved_tasks', argv: ['sh', '-ceu', script], cwd: '.', timeoutMs: 30_000, requiredExitCode: 0 }]
  return { taskId, ...prepared, task: task(taskId, 'swe-marathon', prepared, verification, 'Verify the declared synthetic release marathon outcomes.') }
}

async function preparedMetamorphic(workerRoot) {
  const source = resolve(root, 'task-packs/metamorphic-v1/greeting-contract')
  const fixture = { prompt: await readFile(join(source, 'TASK.md'), 'utf8'), files: await readFiles(source) }
  const baseFormat = fixture.files.find((file) => file.path === 'src/format.mjs')?.content
  if (!baseFormat) throw new Error('metamorphic fixture lacks src/format.mjs')
  const tick = String.fromCharCode(96)
  const interpolation = '$' + '{prefix} $' + '{normalizeName(name)}'
  const reorderedFormat = ['function normalizeName(name) { return name }', '', 'export function format(prefix, name) {', '  return ' + tick + interpolation + tick, '}', ''].join(String.fromCharCode(10))
  const definitions = [
    { id: 'path-rename', transform: { kind: 'path_rename', from: 'src/cli.mjs', to: 'app/entry.mjs', references: [{ path: 'tests/contract.test.mjs', search: '../src/cli.mjs', replacement: '../app/entry.mjs' }, { path: 'app/entry.mjs', search: './format.mjs', replacement: '../src/format.mjs' }] } },
    { id: 'requirement-rewording', transform: { kind: 'requirement_rewording', path: 'TASK.md', search: '# Implement a greeting command', replacement: '# Build an equivalent salutation CLI' } },
    { id: 'irrelevant-file', transform: { kind: 'irrelevant_file', file: { path: 'docs/unrelated-release-notes.md', content: '# Unrelated notes\n' } } },
    { id: 'function-order', transform: { kind: 'function_order', path: 'src/format.mjs', search: baseFormat, replacement: reorderedFormat } },
    { id: 'test-output-format', transform: { kind: 'test_output_format', path: 'tests/contract.test.mjs', search: "test('accepts arbitrary names and rejects invalid arity', () => {", replacement: "test('same contract with reformatted diagnostics', () => {" } },
    { id: 'nonsemantic-config', transform: { kind: 'nonsemantic_config', path: 'config/runtime.json', key: 'displayLabel', value: 'synthetic-variant' } },
  ]
  const tasks = []
  const prepared = []
  for (const [index, definition] of definitions.entries()) {
    const variant = await generateMetamorphicVariant({ fixture, variantId: definition.id, seed: 20260803 + index, transform: definition.transform })
    const taskId = 'metamorphic-' + definition.id
    const repo = await repository(workerRoot, taskId, Object.fromEntries(variant.files.map((file) => [file.path, file.content])), 'program-bench')
    const verification = [
      { stepId: 'submission-contract', nativeMetric: 'submission_contract', argv: ['sh', '-ceu', 'test -s package.json; printf "%s\\n" "{\\"metrics\\":{\\"contract_ok\\":true,\\"implementation_file_count\\":1}}"'], cwd: '.', timeoutMs: 30_000, requiredExitCode: 0 },
      { stepId: 'compile', nativeMetric: 'compile_passed', argv: ['sh', '-ceu', 'node --check src/format.mjs; entry=src/cli.mjs; test -f "$entry" || entry=app/entry.mjs; node --check "$entry"; printf "%s\\n" "{\\"metrics\\":{\\"compile_passed\\":true}}"'], cwd: '.', timeoutMs: 30_000, requiredExitCode: 0 },
      { stepId: 'tests', nativeMetric: 'tests_passed', argv: ['sh', '-ceu', 'node --test tests/contract.test.mjs; printf "%s\\n" "{\\"metrics\\":{\\"tests_passed\\":true}}"'], cwd: '.', timeoutMs: 30_000, requiredExitCode: 0 },
    ]
    tasks.push(task(taskId, 'program-bench', repo, verification, fixture.prompt))
    prepared.push({ taskId, fixtureManifestHash: repo.fixtureManifestHash, variantId: definition.id, manifestHash: variant.manifest.manifestHash })
  }
  return { tasks, prepared }
}

function task(taskId, taskPackId, repo, verification, prompt) {
  return { schemaVersion: 1, taskId, taskPackId, taskPackVersion: '1.0.0', title: taskId, prompt, repository: { kind: 'artifact', archiveRef: repo.archiveRef, archiveSha256: repo.archiveSha256, revision: repo.revision }, requiredSandboxImageDigest: imageDigest, fixtureManifestHash: repo.fixtureManifestHash, faultScenarioIds: [], verification, analysis: { constraints: verification.map((step) => ({ id: step.stepId, kind: 'must', sourceRef: 'task#' + step.stepId, verifierId: taskPackId + '-native', verifierVersion: '1.0.0', verifierMetric: step.nativeMetric ?? step.stepId })), protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'public synthetic evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:remaining-benchmark-lifecycle'] }, publication: { artifact: { status: 'granted', basis: 'public synthetic evaluation' }, report: { status: 'granted', basis: 'public synthetic evaluation' }, leaderboard: { status: 'granted', basis: 'public synthetic evaluation' }, redistribution: { status: 'granted', basis: 'MIT' } } } }
}

async function repository(workerRoot, taskId, files, namespace) {
  const directory = join(workerRoot, 'source-' + taskId)
  for (const [path, content] of Object.entries(files)) { const destination = join(directory, path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, content, { mode: 0o600 }) }
  await run('git', ['init', '-q', '-b', 'main'], directory)
  await run('git', ['config', 'user.name', 'Agent Evaluation Fixture'], directory)
  await run('git', ['config', 'user.email', 'evaluation@localhost'], directory)
  await run('git', ['add', '.'], directory)
  await run('git', ['commit', '-qm', 'immutable task fixture'], directory, { GIT_AUTHOR_DATE: '2026-08-03T00:00:00Z', GIT_COMMITTER_DATE: '2026-08-03T00:00:00Z' })
  const revision = (await run('git', ['rev-parse', 'HEAD'], directory)).stdout.trim()
  const archiveRef = namespace + '/' + taskId + '.tar'
  const archive = join(workerRoot, archiveRef)
  await mkdir(dirname(archive), { recursive: true, mode: 0o700 })
  await run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', directory, '.'])
  const archiveSha256 = sha256(await readFile(archive))
  return { archiveRef, archiveSha256, revision, fixtureManifestHash: await sha256Hex(canonicalJson({ taskId, archiveSha256, revision })) }
}

async function readFiles(directory) {
  const output = []
  async function walk(current) { for (const entry of await readdir(current, { withFileTypes: true })) { const path = join(current, entry.name); if (entry.isDirectory()) await walk(path); else output.push({ path: relative(directory, path), content: await readFile(path, 'utf8') }) } }
  await walk(directory)
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function tracked(inner) {
  const created = []
  const destroyed = new Set()
  return { descriptor: inner.descriptor, created, destroyed, preflight: (policy) => inner.preflight(policy), create: async (input) => { const target = await inner.create(input); created.push({ trialId: input.trialId, sandboxId: target.sandboxId }); return target }, collect: (target) => inner.collect(target), destroy: async (target) => { await inner.destroy(target); destroyed.add(target.sandboxId) }, verifyDestroyed: (target) => inner.verifyDestroyed(target), reapOrphans: (workerId) => inner.reapOrphans(workerId) }
}
async function verifyArtifact(evidence, path) { const entry = evidence.artifactManifest.entries.find((candidate) => candidate.path === path); if (!entry) throw new Error('artifact manifest lacks ' + path); const content = await readFile(join(artifactRoot, path)); if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) throw new Error('artifact integrity mismatch: ' + path) }
async function runtimeResidue() { const [instances, networks, acls] = await Promise.all([lxc(['list', '--format', 'json'], /^(?:eval-|ae-)/u), lxc(['network', 'list', '--format', 'json'], /^ae-n-/u), lxc(['network', 'acl', 'list', '--format', 'json'], /^ae-a-/u)]); return { instances, networks, acls } }
async function lxc(args, pattern) { const result = await runFile('lxc', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }); return JSON.parse(result.stdout).map((item) => item.name).filter((name) => pattern.test(name)).sort() }
async function run(binary, args, cwd, env = {}) { return await runFile(binary, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }) }
function command(type, fields) { const id = type.replaceAll('.', '-') + '-' + process.pid; return { schemaVersion: 1, type, commandId: id, idempotencyKey: id, submittedAt: new Date().toISOString(), ...fields } }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function message(error) { return error instanceof Error ? error.message : String(error) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

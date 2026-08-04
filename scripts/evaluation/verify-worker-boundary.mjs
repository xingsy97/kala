#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const workerRunnerPath = 'packages/eval-worker/src/trial-runner.ts'
const workerRunner = await source(workerRunnerPath)
const successChain = [
  'this.options.registry.sandbox(',
  'this.options.registry.agent(',
  'provider.create(',
  'backend.start(',
  'runVerifier(',
  'provider.collect(',
  'this.stager.stage(',
  'this.stager.verify(',
  'await destroyAndVerify(provider, target)',
  'commitTrialResult(',
]
const positions = successChain.map((marker) => workerRunner.indexOf(marker))
if (positions.some((position) => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
  throw new Error('Worker success path does not retain the required sandbox-to-commit ownership order')
}
for (const marker of [
  'if (target && !cleanupCompleted)',
  'await destroyAndVerify(provider, target)',
  "new ClassifiedTrialError('environment_error', 'CLEANUP_FAILED'",
  'this.stager.stageFailure(',
]) if (!workerRunner.includes(marker)) throw new Error('Worker failure path is missing required ownership marker: ' + marker)

const workerPackage = await json('packages/eval-worker/package.json')
const workerProductionDependencies = Object.keys(workerPackage.dependencies ?? {}).sort()
if (JSON.stringify(workerProductionDependencies) !== JSON.stringify(['@agent-kernel/eval-protocol', '@agent-kernel/eval-sdk'])) {
  throw new Error('eval-worker production dependencies must be limited to eval-protocol and eval-sdk')
}

const nonWorkerPackages = ['packages/eval-orchestrator', 'packages/eval-analyzer', 'packages/eval-dashboard']
const forbiddenRuntimeMarkers = [
  '@agent-kernel/eval-environment',
  '@agent-kernel/eval-agent-',
  '@agent-kernel/eval-benchmark-',
  'DockerSandboxProvider',
  'LxdSandboxProvider',
  'EvaluationSandboxProvider',
  'runVerifier(',
  'ArtifactStager',
  '/var/run/docker.sock',
]
const nonWorkerSourceFiles = []
for (const packagePath of nonWorkerPackages) {
  const manifest = await json(join(packagePath, 'package.json'))
  const productionDependencies = Object.keys(manifest.dependencies ?? {})
  const forbiddenDependencies = productionDependencies.filter((name) => name === '@agent-kernel/eval-worker' || name.startsWith('@agent-kernel/eval-environment') || name.startsWith('@agent-kernel/eval-agent-') || name.startsWith('@agent-kernel/eval-benchmark-'))
  if (forbiddenDependencies.length > 0) throw new Error(packagePath + ' has Worker-runtime dependencies: ' + forbiddenDependencies.join(', '))
  for (const path of await walk(join(root, packagePath, 'src'))) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(path) || /\.test\.[^.]+$/u.test(path)) continue
    const body = await readFile(path, 'utf8')
    for (const marker of forbiddenRuntimeMarkers) if (body.includes(marker)) throw new Error(relative(root, path) + ' owns forbidden Worker runtime marker: ' + marker)
    nonWorkerSourceFiles.push(relative(root, path))
  }
}

const composeBase = await source('deploy/evaluation/compose.yaml')
const composeWorker = await source('deploy/evaluation/acceptance/compose.worker-acceptance.yaml')
if (composeBase.includes('/var/run/docker.sock')) throw new Error('Control Plane, Analyzer, or Dashboard receives the Docker socket')
if ((composeWorker.match(/\/var\/run\/docker\.sock/g) ?? []).length !== 2 || !composeWorker.includes('services:\n  worker:')) {
  throw new Error('Worker deployment must be the sole Docker socket consumer')
}
const workerImage = await source('deploy/evaluation/images/Dockerfile.worker')
for (const marker of ['@agent-kernel/eval-worker', '@agent-kernel/eval-environment-docker', '@agent-kernel/eval-agent-custom-command', '@agent-kernel/eval-benchmark-custom-task-pack', 'docker:29.1.3-cli']) {
  if (!workerImage.includes(marker)) throw new Error('Worker image is missing runtime owner: ' + marker)
}
for (const path of ['deploy/evaluation/images/Dockerfile.orchestrator', 'deploy/evaluation/images/Dockerfile.analyzer', 'deploy/evaluation/images/Dockerfile.dashboard']) {
  const body = await source(path)
  for (const marker of ['@agent-kernel/eval-worker', '@agent-kernel/eval-environment-', '@agent-kernel/eval-agent-', '@agent-kernel/eval-benchmark-', '/var/run/docker.sock']) {
    if (body.includes(marker)) throw new Error(path + ' contains forbidden Worker runtime owner: ' + marker)
  }
}

const ownership = await json('docs/architecture/agent-evaluation-platform-ownership.json')
const ownerByCapability = Object.fromEntries(ownership.targetOwners.map((entry) => [entry.capability, entry.owner]))
if (ownerByCapability['trial-execution'] !== 'packages/eval-worker' || ownerByCapability['sandbox-providers'] !== 'adapters/environments' || ownerByCapability['agent-adapters'] !== 'adapters/agents' || ownerByCapability['benchmark-adapters'] !== 'adapters/benchmarks') {
  throw new Error('ownership manifest does not preserve the Worker execution boundary')
}

const workerRuntime = await json('docs/evidence/evaluation/worker-deployment-runtime-20260803.json')
const workerAcceptance = await json('docs/evidence/evaluation/worker-deployment-acceptance-20260803.json')
if (workerRuntime.deployment?.service !== 'worker' || workerRuntime.acceptance?.trialState !== 'completed' || workerRuntime.acceptance?.managedTrialContainersAfterCompletion !== 0) throw new Error('real Worker deployment evidence is incomplete')
if (workerRuntime.acceptance.runId !== workerAcceptance.runId || workerAcceptance.runState !== 'completed' || workerAcceptance.trialState !== 'completed') throw new Error('Worker runtime and trial evidence do not identify the same completed run')
if (workerRuntime.acceptance.artifactSha256 !== await fileSha256('docs/evidence/evaluation/worker-deployment-acceptance-20260803.json')) throw new Error('Worker acceptance checksum does not match runtime evidence')

const conformance = await json('docs/evidence/evaluation/sandbox-conformance-20260803.json')
const conformanceChecks = conformance.providers.flatMap((provider) => Object.values(provider.result.checks))
if (conformance.providers.length !== 3 || conformanceChecks.length !== 21 || conformanceChecks.some((passed) => passed !== true)) throw new Error('three-provider isolation evidence is incomplete')

const sdlc = await json('docs/evidence/evaluation/final-fresh-sdlc-journey-20260803.json')
const sweBench = await json('docs/evidence/evaluation/final-fresh-swe-bench-astropy-12907-20260803.json')
for (const [label, run] of [['SDLC', sdlc], ['SWE-Bench', sweBench]]) {
  if (run.runState !== 'completed' || run.cleanupVerified !== true || run.environmentLockEqualAcrossAgents !== true || run.freshSandboxes < 3 || !run.trials.some((trial) => trial.agentVariantId === 'agent-runlab')) {
    throw new Error(label + ' RunLab topology evidence is incomplete')
  }
}
const topologyMarkers = ['adapter.started', 'hostVersion', 'executorVersion', 'runlab.driver.ready', 'runlab.completed']
for (const path of ['scripts/evaluation/run-real-task-pack.mjs', 'scripts/evaluation/run-real-swe-bench.mjs']) {
  const body = await source(path)
  for (const marker of topologyMarkers) if (!body.includes(marker)) throw new Error(path + ' does not require RunLab co-location marker: ' + marker)
}

const sourcePaths = [
  workerRunnerPath,
  'packages/eval-worker/src/artifact-stager.ts',
  'packages/eval-worker/src/cleanup.ts',
  'packages/eval-worker/src/plugin-loader.ts',
  'packages/eval-worker/src/registry.ts',
  'packages/eval-worker/package.json',
  'deploy/evaluation/compose.yaml',
  'deploy/evaluation/acceptance/compose.worker-acceptance.yaml',
  'deploy/evaluation/images/Dockerfile.worker',
  'docs/architecture/agent-evaluation-package-boundaries.json',
  'docs/architecture/agent-evaluation-platform-ownership.json',
  'scripts/evaluation/verify-worker-boundary.mjs',
]
const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, await fileSha256(path)])))
const evidenceFiles = Object.fromEntries(await Promise.all([
  'docs/evidence/evaluation/worker-deployment-runtime-20260803.json',
  'docs/evidence/evaluation/worker-deployment-acceptance-20260803.json',
  'docs/evidence/evaluation/sandbox-conformance-20260803.json',
  'docs/evidence/evaluation/final-fresh-sdlc-journey-20260803.json',
  'docs/evidence/evaluation/final-fresh-swe-bench-astropy-12907-20260803.json',
].map(async (path) => [path, await fileSha256(path)])))
const sourceRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || 'unknown'
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'Worker-only ownership of untrusted sandbox, Agent, verifier, artifact staging, and cleanup execution',
  sourceRevision,
  sourceFiles,
  ownership: {
    successChain,
    failureCleanupVerified: true,
    workerProductionDependencies,
    nonWorkerPackagesAudited: nonWorkerPackages,
    nonWorkerSourceFilesAudited: nonWorkerSourceFiles.length,
    dockerSocketConsumers: ['worker'],
  },
  runtime: {
    workerImage: workerRuntime.deployment.imageId,
    runId: workerAcceptance.runId,
    lifecycleStates: workerAcceptance.lifecycleStates,
    managedTrialContainersAfterCompletion: workerRuntime.acceptance.managedTrialContainersAfterCompletion,
    sandboxConformanceProviders: conformance.providers.map((provider) => provider.name),
    sandboxConformanceChecks: conformanceChecks.length,
    freshRunLabRuns: [sdlc.runId, sweBench.runId],
    freshRunLabSandboxes: sdlc.freshSandboxes + sweBench.freshSandboxes,
    cleanupVerified: sdlc.cleanupVerified && sweBench.cleanupVerified,
    runLabCoLocationMarkers: topologyMarkers,
  },
  evidenceFiles,
}
const output = option('--output')
if (output) {
  const path = resolve(output)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}
process.stdout.write(JSON.stringify({ ok: true, successChainSteps: successChain.length, nonWorkerSourceFiles: nonWorkerSourceFiles.length, dockerSocketConsumers: evidence.ownership.dockerSocketConsumers, conformanceChecks: conformanceChecks.length, freshRunLabSandboxes: evidence.runtime.freshRunLabSandboxes, output: output ? resolve(output) : undefined }) + '\n')

async function source(path) { return await readFile(resolve(root, path), 'utf8') }
async function json(path) { return JSON.parse(await source(path)) }
async function fileSha256(path) { return createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') }
async function walk(directory) {
  const results = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) results.push(...await walk(path))
    else if (entry.isFile()) results.push(path)
  }
  return results
}
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }

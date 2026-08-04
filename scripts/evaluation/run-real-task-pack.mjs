import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { canonicalJson, sha256Hex, verifyTrialEvidence } from '../../packages/eval-protocol/dist/index.js'
import { ControlPlaneClient } from '../../packages/eval-sdk/dist/index.js'
import { EvaluationControlPlane, RegisteredTaskCatalog, createEvaluationHttpServer } from '../../packages/eval-orchestrator/dist/src/index.js'
import { EvaluationWorker, WorkerRuntimeRegistry } from '../../packages/eval-worker/dist/src/index.js'
import { EvaluationAnalyzer, EvaluationGrader } from '../../packages/eval-analyzer/dist/src/index.js'
import { createLxdContainerProvider } from '../../adapters/environments/lxd-container/dist/index.js'
import { createAgentRunLabBackend } from '../../adapters/agents/agent-runlab/dist/src/index.js'
import { createClaudeCodeAgentBackend } from '../../adapters/agents/claude-code/dist/index.js'
import { createCodexAgentBackend } from '../../adapters/agents/codex/dist/src/index.js'
import { createSdlcJourneyAdapter } from '../../adapters/benchmarks/sdlc-journey/dist/index.js'
import { createFaultScenarioAdapter } from '../../adapters/benchmarks/fault-scenarios/dist/index.js'
import { createTerminalBenchAdapter } from '../../adapters/benchmarks/terminal-bench/dist/index.js'
import { createProgramBenchAdapter } from '../../adapters/benchmarks/program-bench/dist/index.js'
import { createCodeUnderstandingAdapter } from '../../adapters/benchmarks/code-understanding/dist/index.js'
import { createMemoryPlanningAdapter } from '../../adapters/benchmarks/memory-planning/dist/index.js'
import { createEphemeralAuth } from './fixtures/ephemeral-auth.mjs'
import { lockedEndpointDestinations, providerRootUrl } from './locked-endpoint.mjs'

const runFile = promisify(execFile)
const workspaceRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const taskPackId = option('--task-pack') ?? 'sdlc-journey'
const taskCount = positiveInteger(option('--tasks') ?? '1', '--tasks')
if (taskCount > 5) throw new Error('--tasks cannot exceed the five-task flagship slice')
const startedAt = new Date()
const definitions = {
  'sdlc-journey': { source: 'task-packs/sdlc-journey-v1/service-release', taskId: 'service-release-v2', version: '1.0.0', adapter: createSdlcJourneyAdapter, verifierId: 'sdlc-journey-native', verifierVersion: '1.0.0', title: 'Build, package, deploy, verify, and roll back service release v2', promptFile: 'ISSUE.md', faultScenarioIds: [], verification: sdlcVerification() },
  'fault-scenarios': { source: 'task-packs/fault-scenarios-v1/config-schema-recovery', taskId: 'config-schema-recovery', version: '1.0.0', adapter: createFaultScenarioAdapter, verifierId: 'fault-scenario-native', verifierVersion: '1.0.0', title: 'Diagnose and recover a strict configuration schema failure', promptFile: 'INCIDENT.md', faultScenarioIds: ['invalid-port-type-v1'], verification: faultVerification() },
  'terminal-bench': { source: 'task-packs/terminal-bench-v1/release-ledger', taskId: 'release-ledger-reconciliation', version: '1.0.0', adapter: createTerminalBenchAdapter, verifierId: 'terminal-bench-native', verifierVersion: '1.0.0', title: 'Reconcile a release ledger with shell tools', promptFile: 'TASK.md', faultScenarioIds: [], acceptanceMetric: 'reward', acceptanceValue: 1, verification: terminalBenchVerification() },
  'program-bench': { source: 'task-packs/program-bench-v1/greeting-cli', taskId: 'greeting-cli', version: '1.0.0', adapter: createProgramBenchAdapter, verifierId: 'program-bench-native', verifierVersion: '1.0.0', title: 'Implement and compile a deterministic greeting CLI', promptFile: 'TASK.md', faultScenarioIds: [], acceptanceMetric: 'compile_passed', verification: programBenchVerification() },
  'code-understanding': { source: 'task-packs/code-understanding-v1/configuration-runtime-trace', taskId: 'configuration-runtime-trace', version: '1.0.0', adapter: createCodeUnderstandingAdapter, verifierId: 'code-understanding-native', verifierVersion: '1.0.0', title: 'Localize a configuration-to-runtime dependency chain', promptFile: 'TASK.md', faultScenarioIds: [], protectedPaths: ['config', 'scripts', 'src', 'tests'], acceptanceMetric: 'verifier_protocol_valid', verification: codeUnderstandingVerification() },
  'memory-planning': { source: 'task-packs/memory-planning-v1/release-handoff', taskId: 'release-handoff', version: '1.0.0', adapter: createMemoryPlanningAdapter, verifierId: 'memory-planning-native', verifierVersion: '1.0.0', title: 'Recover an isolated compacted handoff and execute its plan graph', promptFile: 'TASK.md', faultScenarioIds: [], protectedPaths: ['incident', 'memory', 'scripts', 'tests'], acceptanceMetric: 'verifier_protocol_valid', verification: memoryPlanningVerification() },
}
const definition = definitions[taskPackId]
if (!definition) throw new Error('unsupported task pack: ' + taskPackId)

const endpoint = await resolveEndpointCredential()
const credential = endpoint.credential
const baseUrl = providerRootUrl(option('--base-url') ?? endpoint.baseUrl)
const allowedDestinations = await lockedEndpointDestinations(baseUrl)
const imageDigest = option('--image')
if (!/^local:[a-f0-9]{64}$/u.test(imageDigest ?? '')) throw new Error('--image requires a full pinned local:LXD-fingerprint')
const output = option('--output')
const acceptanceRoot = await mkdtemp(join(tmpdir(), 'agent-eval-real-task-pack-'))
const dataRoot = join(acceptanceRoot, 'platform')
const artifactRoot = join(dataRoot, 'artifacts')
const workerDataDir = join(acceptanceRoot, 'worker')
await Promise.all([mkdir(artifactRoot, { recursive: true, mode: 0o700 }), mkdir(workerDataDir, { recursive: true, mode: 0o700 })])
const expandedDefinitions = expandDefinitions(definition, taskCount)
const preparedTasks = await Promise.all(expandedDefinitions.map(async (item) => ({ definition: item, prepared: await prepareTask(item, workerDataDir) })))
const runId = safeId('fresh-' + taskPackId + '-' + new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14) + '-' + process.pid)
const agents = selectAgents(await agentVariants(baseUrl))
const slice = await evaluatedSlice(definition, preparedTasks, artifactRoot)
const spec = {
  schemaVersion: 1, runId, taskPack: { id: taskPackId, version: definition.version, evaluatedSlice: slice }, agents,
  execution: { repeats: 1, priority: 0, maxConcurrency: agents.length, maxConcurrencyPerBackend: agents.length, maxConcurrencyPerProvider: agents.length, leaseMs: 30_000, timeoutMs: positiveInteger(option('--timeout-ms') ?? '900000', '--timeout-ms'), inactivityTimeoutMs: positiveInteger(option('--inactivity-timeout-ms') ?? '180000', '--inactivity-timeout-ms'), retryPolicy: { maxAttempts: 1, retryableCategories: [], backoffMs: 0 } },
  sandbox: { provider: 'lxd-container', imageDigest, readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 2, memoryMb: 4096, diskMb: 8192, pids: 512 }, network: { mode: 'allowlist', allowedDestinations }, artifactAllowlist: ['runlab-session.jsonl', 'runlab-native.tar', ...preparedTasks.flatMap(({ definition: item }) => agents.map((agent) => taskPackId + '/' + runId + ':' + item.taskId + ':' + agent.variantId + ':0/native-result.json'))] },
  verification: { verifierId: definition.verifierId, verifierVersion: definition.verifierVersion, officialRequired: false, timeoutMs: 120_000, configHash: await sha256Hex(canonicalJson(definition.verification)) },
  analysis: { detectorIds: ['instruction-drift', 'context-forgetting', 'test-gaming', 'tool-recovery', 'planning-execution'], repeatsRequired: 1, configHash: await sha256Hex(canonicalJson({ detectorSet: 'required-v1' })) },
  createdAt: new Date().toISOString(),
}
const tasks = preparedTasks.map(({ definition: item, prepared }) => ({
  schemaVersion: 1, taskId: item.taskId, taskPackId, taskPackVersion: item.version, title: item.title, prompt: prepared.prompt,
  repository: { kind: 'artifact', archiveRef: prepared.archiveRef, archiveSha256: prepared.archiveSha256, revision: prepared.revision },
  requiredSandboxImageDigest: imageDigest, fixtureManifestHash: prepared.fixtureManifestHash, faultScenarioIds: item.faultScenarioIds, verification: item.verification,
  analysis: { constraints: item.verification.map((step) => ({ id: step.stepId, kind: 'must', sourceRef: 'task#' + step.stepId, verifierId: item.verifierId, verifierVersion: item.verifierVersion, verifierMetric: step.nativeMetric ?? step.stepId })), protectedPaths: item.protectedPaths ?? ['fixture'], hiddenVerifierPaths: [] },
  lxdInitMode: 'keepalive', policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'public synthetic evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['source:real-task-pack'] }, publication: { artifact: { status: 'granted', basis: 'public synthetic evaluation' }, report: { status: 'granted', basis: 'public synthetic evaluation' }, leaderboard: { status: 'granted', basis: 'public synthetic evaluation' }, redistribution: { status: 'granted', basis: 'MIT' } } },
}))
const catalog = new RegisteredTaskCatalog()
catalog.register(slice.sliceManifestHash, tasks)
const controlPlane = new EvaluationControlPlane({ journalPath: join(dataRoot, 'control-plane.jsonl'), reportRoot: artifactRoot, taskCatalog: catalog })
await controlPlane.initialize()
const workerId = 'real-task-pack-' + process.pid
const graderId = 'real-task-pack-grader-' + process.pid
const analyzerId = 'real-task-pack-analyzer-' + process.pid
const auth = createEphemeralAuth({ workerId, analyzerIds: [graderId, analyzerId] })
const server = createEvaluationHttpServer(controlPlane, { authenticator: auth.authenticator })
await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise) })
const port = server.address().port
const controlPlaneUrl = 'http://127.0.0.1:' + String(port)
const client = new ControlPlaneClient({ baseUrl: controlPlaneUrl, credentialProvider: auth.operatorCredentials })
const workerClient = new ControlPlaneClient({ baseUrl: controlPlaneUrl, credentialProvider: auth.workerCredentials })
const registry = new WorkerRuntimeRegistry()
const provider = createTrackedProvider(createLxdContainerProvider())
registry.registerSandbox(provider)
registry.registerAgent(createAgentRunLabBackend())
registry.registerAgent(createClaudeCodeAgentBackend())
registry.registerAgent(createCodexAgentBackend())
registry.registerBenchmark(definition.adapter())
const workerErrors = []
const worker = new EvaluationWorker({
  controlPlane: workerClient, registry, credentials: { resolve: async (references) => Object.fromEntries(references.map((reference) => [reference.referenceId, credential])), available: async () => true },
  workerId, workerVersion: '0.0.0', cpu: 6, memoryMb: 12288, diskMb: 131072, gpu: 0, maxTrials: agents.length, leaseMs: 30_000, artifactRoot, workerDataDir, cancellationGraceMs: 5_000, onTrialError: (error, trialId) => workerErrors.push({ trialId, message: safeMessage(error) }),
})

let evidence
try {
  await client.command(command('run.create', { spec }))
  await client.command(command('run.start', { runId }))
  await worker.runUntilIdle({ idlePolls: 10, pollIntervalMs: 100 })
  const completedRun = controlPlane.projection.runs.get(runId)
  if (!completedRun) throw new Error('fresh task-pack run projection disappeared')
  const incomplete = completedRun.trialIds.map((trialId) => controlPlane.projection.trials.get(trialId)).filter((trial) => !trial || trial.state !== 'completed')
  if (incomplete.length) throw new Error('fresh task-pack trials did not all complete: ' + JSON.stringify(incomplete.map((trial) => ({ trialId: trial?.trialId, state: trial?.state }))))
  await client.command(command('run.grade', { runId }))
  await client.command(command('run.analyze', { runId, detectorIds: spec.analysis.detectorIds }))
  await Promise.all([
    new EvaluationGrader({ controlPlane: new ControlPlaneClient({ baseUrl: controlPlaneUrl, credentialProvider: auth.analyzerCredentials(graderId) }), executorId: graderId, leaseMs: 30_000, pollIntervalMs: 100 }).runUntilIdle({ idlePolls: 1 }),
    new EvaluationAnalyzer({ controlPlane: new ControlPlaneClient({ baseUrl: controlPlaneUrl, credentialProvider: auth.analyzerCredentials(analyzerId) }), executorId: analyzerId, leaseMs: 30_000, pollIntervalMs: 100 }).runUntilIdle({ idlePolls: 1 }),
  ])
  evidence = await auditAcceptance({ controlPlane, provider, runId, taskPackId, definition, expectedAgents: agents, expectedTaskIds: tasks.map((task) => task.taskId), artifactRoot, credential, workerErrors, startedAt })
} finally {
  await provider.reapOrphans(worker.registration.workerId).catch(() => undefined)
  await new Promise((resolvePromise) => server.close(() => resolvePromise()))
}
if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }) }
process.stdout.write(JSON.stringify({ ok: true, runId, taskPackId, tasks: tasks.length, trials: evidence.trials.length, freshSandboxes: evidence.freshSandboxes, durationMs: evidence.durationMs, output: output ? resolve(output) : undefined }) + '\n')

async function prepareTask(item, workerRoot) {
  const source = resolve(workspaceRoot, item.source)
  const repository = join(workerRoot, 'source-' + item.taskId)
  await run('cp', ['-a', source + '/.', repository])
  await run('git', ['init', '-q', '-b', 'main'], repository)
  await run('git', ['config', 'user.name', 'Agent Evaluation Fixture'], repository)
  await run('git', ['config', 'user.email', 'evaluation@localhost'], repository)
  await run('git', ['add', '.'], repository)
  await run('git', ['commit', '-qm', 'immutable task fixture'], repository, { GIT_AUTHOR_DATE: '2026-08-03T00:00:00Z', GIT_COMMITTER_DATE: '2026-08-03T00:00:00Z' })
  const revision = (await run('git', ['rev-parse', 'HEAD'], repository)).stdout.trim()
  // `git add` records filesystem stat data in the index. Rebuild it from the
  // committed tree so equivalent fresh fixture preparations produce identical
  // archives and therefore the same immutable dataset/slice identity.
  const deterministicIndex = join(workerRoot, '.deterministic-index-' + item.taskId)
  await run('git', ['read-tree', 'HEAD'], repository, { GIT_INDEX_FILE: deterministicIndex })
  await run('mv', [deterministicIndex, join(repository, '.git', 'index')], repository)
  const archiveRef = 'fixtures/' + item.taskId + '.tar'
  const archive = join(workerRoot, archiveRef)
  await mkdir(dirname(archive), { recursive: true, mode: 0o700 })
  await run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', repository, '.'])
  const body = await readFile(archive)
  const archiveSha256 = createHash('sha256').update(body).digest('hex')
  const prompt = await readFile(join(source, item.promptFile), 'utf8') + (item.promptSuffix ? '\nFlagship slice focus: ' + item.promptSuffix + '. Complete the entire incident recovery and verification contract.\n' : '')
  return { archiveRef, archiveSha256, revision, prompt, fixtureManifestHash: await sha256Hex(canonicalJson({ archiveSha256, revision, taskId: item.taskId })) }
}

async function evaluatedSlice(item, preparedTasks, root) {
  const taskIds = preparedTasks.map(({ definition }) => definition.taskId)
  const datasetManifestHash = await sha256Hex(canonicalJson({ taskPackId, version: item.version, fixtures: preparedTasks.map(({ definition, prepared }) => ({ taskId: definition.taskId, fixtureManifestHash: prepared.fixtureManifestHash })) }))
  const sliceManifest = { schemaVersion: 1, datasetManifestHash, selectionKind: 'full', taskIds }
  const sliceManifestHash = await sha256Hex(canonicalJson(sliceManifest))
  const taskIdsManifestRef = 'catalog/' + taskPackId + '-' + sliceManifestHash.slice(0, 16) + '.json'
  await mkdir(join(root, 'catalog'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, taskIdsManifestRef), JSON.stringify(sliceManifest, null, 2) + '\n', { mode: 0o600 })
  return {
    sliceId: taskPackId + '-full-v1', dataset: { datasetId: taskPackId + '-v1', displayName: taskPackId + ' v1', version: item.version, sourceRevision: preparedTasks[0].prepared.revision, manifestHash: datasetManifestHash, taskIdsHash: await sha256Hex(canonicalJson(taskIds)), totalItems: taskIds.length, officialBenchmark: false, license: 'MIT', evaluationPermission: 'public synthetic evaluation' },
    selectionKind: 'full', selectionSpec: { kind: 'full', taskIdsHash: await sha256Hex(canonicalJson(taskIds)) }, selectedItems: taskIds.length, coverageRatio: 1, taskIdsManifestRef, sliceManifestHash,
  }
}

async function agentVariants(url) {
  const values = [
    { variantId: 'agent-runlab', backendId: 'agent-runlab', model: { provider: 'openai', modelId: option('--runlab-model') ?? 'gpt-5.6-sol' }, config: { provider: 'openai', baseUrl: url + '/v1', ...(option('--runlab-recovery-policy') ? { recoveryPolicy: option('--runlab-recovery-policy') } : {}) }, referenceId: 'runlab-api-key', provider: 'openai' },
    { variantId: 'claude-code', backendId: 'claude-code', model: { provider: 'anthropic', modelId: option('--claude-model') ?? 'claude-opus-4.8' }, config: { baseUrl: url }, referenceId: 'claude-api-key', provider: 'anthropic' },
    { variantId: 'codex', backendId: 'codex', model: { provider: 'openai', modelId: option('--codex-model') ?? 'gpt-5.6-sol' }, config: { baseUrl: url + '/v1', transport: option('--codex-transport') ?? 'app-server', reasoningEffort: option('--codex-effort') ?? 'medium' }, referenceId: 'codex-api-key', provider: 'openai' },
  ]
  return await Promise.all(values.map(async (value) => ({ variantId: value.variantId, backendId: value.backendId, agentVersion: '0.0.0', model: value.model, configHash: await sha256Hex(canonicalJson(value.config)), config: value.config, credentialRefs: [{ referenceId: value.referenceId, provider: value.provider, scope: ['model-inference'] }] })))
}
function selectAgents(agents) {
  const requested = values('--agent')
  if (requested.length === 0) return agents
  const selected = agents.filter((agent) => requested.includes(agent.variantId))
  if (selected.length !== new Set(requested).size) throw new Error('unknown or duplicate --agent value; expected agent-runlab, claude-code, or codex')
  return selected
}

function createTrackedProvider(inner) {
  const created = []
  const destroyed = new Set()
  return {
    descriptor: inner.descriptor, created, destroyed,
    preflight: (policy) => inner.preflight(policy),
    create: async (input) => { const target = await inner.create(input); created.push({ trialId: input.trialId, sandboxId: target.sandboxId }); return target },
    collect: (target) => inner.collect(target),
    destroy: async (target) => { await inner.destroy(target); destroyed.add(target.sandboxId) },
    verifyDestroyed: (target) => inner.verifyDestroyed(target),
    reapOrphans: (workerId) => inner.reapOrphans(workerId),
  }
}

async function auditAcceptance(input) {
  const runProjection = input.controlPlane.projection.runs.get(input.runId)
  if (!runProjection || runProjection.state !== 'completed') throw new Error('real run did not complete: ' + JSON.stringify({ state: runProjection?.state, workerErrors: input.workerErrors }))
  const trials = runProjection.trialIds.map((trialId) => input.controlPlane.projection.trials.get(trialId))
  const expectedTrials = input.expectedAgents.length * input.expectedTaskIds.length
  if (trials.length !== expectedTrials || trials.some((trial) => !trial || trial.state !== 'completed' || !trial.evidence)) throw new Error('real run lacks complete canonical evidence: ' + JSON.stringify(trials.map((trial) => ({ trialId: trial?.trialId, state: trial?.state }))))
  if (input.provider.created.length !== expectedTrials || new Set(input.provider.created.map((item) => item.sandboxId)).size !== expectedTrials) throw new Error('every Agent trial requires a distinct fresh sandbox')
  if (input.provider.created.some((item) => !input.provider.destroyed.has(item.sandboxId))) throw new Error('one or more fresh sandboxes were not destroyed')
  const environmentLocks = new Set()
  const trialEvidence = []
  for (const trial of trials) {
    const evidence = await verifyTrialEvidence(trial.evidence)
    environmentLocks.add(canonicalJson(evidence.environmentLock))
    if (evidence.benchmarkResult.benchmarkId !== input.taskPackId || evidence.benchmarkResult.officialEvidence) throw new Error('task-pack evidence authority mismatch')
    const primaryMetric = input.definition.acceptanceMetric ?? (input.taskPackId === 'sdlc-journey' ? 'journey_completed' : 'recovered')
    const primary = evidence.benchmarkResult.nativeMetrics[primaryMetric]
    if (primary !== (input.definition.acceptanceValue ?? true)) throw new Error('task-pack native verifier did not pass for ' + trial.agentVariantId)
    if (evidence.normalizedEventCount < 1) throw new Error('normalized trace is empty for ' + trial.agentVariantId)
    const diff = await readFile(join(input.artifactRoot, evidence.finalDiffRef), 'utf8')
    if (!diff.trim()) throw new Error('final diff is empty for ' + trial.agentVariantId)
    for (const entry of evidence.artifactManifest.entries) {
      const content = await readFile(join(input.artifactRoot, entry.path))
      if (content.byteLength !== entry.bytes || createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error('artifact integrity mismatch: ' + entry.path)
      if (content.includes(Buffer.from(input.credential))) throw new Error('resolved credential leaked into artifact: ' + entry.path)
    }
    if (trial.agentVariantId === 'agent-runlab') {
      const native = await readFile(join(input.artifactRoot, evidence.nativeEventsRef), 'utf8')
      for (const required of ['adapter.started', 'hostVersion', 'executorVersion', 'runlab.driver.ready', 'runlab.completed']) if (!native.includes(required)) throw new Error('RunLab co-located process evidence is missing ' + required)
    }
    trialEvidence.push({ trialId: trial.trialId, taskId: trial.taskId, agentVariantId: trial.agentVariantId, resultHash: evidence.resultHash, artifactManifestHash: evidence.artifactManifest.manifestHash, evidenceLevel: evidence.evidenceLevel, nativeMetrics: evidence.benchmarkResult.nativeMetrics, normalizedEventCount: evidence.normalizedEventCount })
  }
  if (environmentLocks.size !== 1) throw new Error('Agent run did not use an equal locked environment')
  const jobs = [...input.controlPlane.projection.analysisJobs.values()].filter((job) => job.runId === input.runId)
  const analysisJob = jobs.find((job) => job.kind === 'detectors')
  const gradingJob = jobs.find((job) => job.kind === 'grading')
  if (jobs.length !== 2 || !analysisJob || analysisJob.state !== 'completed' || !input.controlPlane.projection.analysisOutputs.has(analysisJob.jobId)) throw new Error('fresh task-pack analyzer job did not complete')
  const gradingOutput = gradingJob && input.controlPlane.projection.analysisOutputs.get(gradingJob.jobId)
  if (!gradingJob || gradingJob.state !== 'completed' || !gradingOutput || gradingOutput.outputs.length !== trials.length || gradingOutput.outputs.some((output) => output.kind !== 'grading-result')) throw new Error('fresh task-pack grading job did not complete with one result per canonical trial')
  const completedAt = new Date()
  return { schemaVersion: 1, generatedAt: completedAt.toISOString(), scope: 'fresh standalone Control Plane + Worker + grader + analyzer + real Agent backends + LXD sandbox + native verifier', runId: input.runId, taskPackId: input.taskPackId, taskIds: input.expectedTaskIds, agentIds: input.expectedAgents.map((agent) => agent.variantId), agentConfigs: input.expectedAgents.map((agent) => ({ variantId: agent.variantId, backendId: agent.backendId, model: agent.model, configHash: agent.configHash, config: agent.config })), runState: runProjection.state, startedAt: input.startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: completedAt.getTime() - input.startedAt.getTime(), freshSandboxes: input.provider.created.length, cleanupVerified: true, environmentLockEqualAcrossAgents: true, gradingJobId: gradingJob.jobId, gradingOutputHash: gradingJob.outputManifestHash, analysisJobId: analysisJob.jobId, analysisOutputHash: analysisJob.outputManifestHash, defects: [...input.controlPlane.projection.defects.values()].filter((finding) => finding.runId === input.runId).length, workerErrors: input.workerErrors, trials: trialEvidence }
}

function expandDefinitions(item, count) {
  if (count === 1) return [item]
  const names = item.id === 'sdlc-journey'
    ? ['investigate-release', 'implement-release', 'verify-release', 'deploy-release', 'rollback-release']
    : ['diagnose-schema', 'preserve-strictness', 'repair-configuration', 'verify-recovery', 'success-control']
  return names.slice(0, count).map((suffix, index) => ({ ...item, taskId: item.taskId + '-' + String(index + 1), title: item.title + ' — ' + suffix, promptSuffix: suffix }))
}

function sdlcVerification() { return [
  metric('investigation_passed', `test -s evidence/investigation.md; grep -Eqi "releaseVersion|src/service|root cause|v1" evidence/investigation.md`),
  metric('implementation_verified', `git diff --exit-code HEAD -- fixture; node -e 'import("./src/service.mjs").then(m=>{if(m.releaseVersion!=="v2")process.exit(1)})'`),
  metric('tests_passed', `npm test`),
  metric('build_passed', `npm run build; node -e 'import("./dist/service.mjs").then(m=>{if(m.releaseVersion!=="v2")process.exit(1)})'`),
  metric('package_created', `npm run package; test -s release/service.tar; rm -rf /tmp/sdlc-package; mkdir /tmp/sdlc-package; tar -xf release/service.tar -C /tmp/sdlc-package; node -e 'import("/tmp/sdlc-package/service.mjs").then(m=>{if(m.releaseVersion!=="v2")process.exit(1)})'`),
  metric('deploy_succeeded', `test ! -e deploy.pid || ! kill -0 "$(cat deploy.pid)" 2>/dev/null; SERVICE_PORT=18080 node dist/service.mjs >/tmp/sdlc-service.log 2>&1 & echo $! > deploy.pid; for i in 1 2 3 4 5; do kill -0 "$(cat deploy.pid)" && break; sleep 1; done; kill -0 "$(cat deploy.pid)"`),
  metric('health_verified', `node -e 'Promise.all([fetch("http://127.0.0.1:18080/health").then(r=>r.json()),fetch("http://127.0.0.1:18080/version").then(r=>r.json())]).then(([h,v])=>{if(h.status!=="ok"||v.version!=="v2")process.exit(1)})'`),
  metric('rollback_verified', `kill "$(cat deploy.pid)"; wait "$(cat deploy.pid)" 2>/dev/null || true; SERVICE_PORT=18081 node fixture/baseline-v1-service.mjs >/tmp/sdlc-rollback.log 2>&1 & pid=$!; trap 'kill $pid 2>/dev/null || true' EXIT; sleep 1; node -e 'Promise.all([fetch("http://127.0.0.1:18081/health").then(r=>r.json()),fetch("http://127.0.0.1:18081/version").then(r=>r.json())]).then(([h,v])=>{if(h.status!=="ok"||v.version!=="v1")process.exit(1)})'; kill $pid; wait $pid 2>/dev/null || true; trap - EXIT`),
] }
function faultVerification() { return [
  metric('fault_injected', `git show HEAD:config/service.json | grep -F '"port": "18110"'; grep -F CONFIG_SCHEMA_INVALID fixture/incident.log; git diff --exit-code HEAD -- fixture src`),
  metric('fault_observed', `test -s evidence/recovery.md; grep -F CONFIG_SCHEMA_INVALID evidence/recovery.md; grep -F config/service.json evidence/recovery.md`),
  metric('recovery_action_grounded', `node -e 'const c=require("./config/service.json");if(!Number.isInteger(c.port)||c.port!==18110)process.exit(1)'; git diff --exit-code HEAD -- fixture src`),
  metric('service_recovered', `npm run check`),
  metric('success_control_passed', `npm test; tmp=$(mktemp); printf '{"port":18111,"greeting":"control"}\n' > "$tmp"; node scripts/check.mjs "$tmp"; rm -f "$tmp"`),
] }
function terminalBenchVerification() { return [
  { stepId: 'native-reward', nativeMetric: 'reward', argv: ['sh', '-ceu', `test ! -e fixture/expected-answer.txt; test "$(tr -d '[:space:]' < answer.txt)" = 117; git diff --exit-code HEAD -- fixture; printf '%s\n' '{"metrics":{"reward":1}}'`], cwd: '.', timeoutMs: 120_000, requiredExitCode: 0 },
] }
function programBenchVerification() { return [
  { stepId: 'submission-contract', nativeMetric: 'submission_contract', argv: ['sh', '-ceu', `test -s program.mjs; test -x compile.sh; count=$(find . -maxdepth 1 -type f -name 'program.*' | wc -l | tr -d ' '); test "$count" -eq 1; printf '{"metrics":{"contract_ok":true,"implementation_file_count":%s}}\n' "$count"`], cwd: '.', timeoutMs: 120_000, requiredExitCode: 0 },
  { stepId: 'compile', nativeMetric: 'compile_passed', argv: ['sh', '-ceu', `./compile.sh; test -x executable; printf '%s\n' '{"metrics":{"compile_passed":true}}'`], cwd: '.', timeoutMs: 120_000, requiredExitCode: 0 },
  { stepId: 'tests', nativeMetric: 'tests_passed', argv: ['sh', '-ceu', `test "$(./executable fixture)" = 'hello fixture'; test "$(./executable 'two words')" = 'hello two words'; if ./executable >out 2>error; then exit 1; else grep -F 'usage:' error; fi; git diff --exit-code HEAD -- fixture; printf '%s\n' '{"metrics":{"tests_passed":true}}'`], cwd: '.', timeoutMs: 120_000, requiredExitCode: 0 },
] }
function codeUnderstandingVerification() {
  const oracle = {
    repositoryFiles: ['TASK.md', 'package.json', 'localization.json', 'config/defaults.json', 'src/admin-report.mjs', 'src/audit-log.mjs', 'src/cli.mjs', 'src/config.mjs', 'src/formatter.mjs', 'src/runtime.mjs', 'scripts/validate-submission.mjs', 'tests/runtime.test.mjs'],
    relevantFiles: ['config/defaults.json', 'src/cli.mjs', 'src/config.mjs', 'src/formatter.mjs', 'src/runtime.mjs'],
    relevantSymbols: ['config/defaults.json#greetingPrefix', 'src/cli.mjs#main', 'src/config.mjs#loadConfig', 'src/formatter.mjs#formatGreeting', 'src/runtime.mjs#createGreeting'],
    dependencyEdges: [
      ['src/cli.mjs#main', 'src/config.mjs#loadConfig'],
      ['src/cli.mjs#main', 'src/runtime.mjs#createGreeting'],
      ['src/config.mjs#loadConfig', 'config/defaults.json#greetingPrefix'],
      ['src/runtime.mjs#createGreeting', 'src/formatter.mjs#formatGreeting'],
    ],
  }
  const script = `npm test; git diff --exit-code HEAD -- TASK.md package.json config scripts src tests; submission=$(node scripts/validate-submission.mjs); node -e 'const submission=JSON.parse(process.argv[1]);const oracle=JSON.parse(process.argv[2]);console.log(JSON.stringify({metrics:{code_understanding_observation:JSON.stringify({k:submission.k,rankedFiles:submission.rankedFiles,rankedSymbols:submission.rankedSymbols,readSequence:[],predictedDependencyEdges:submission.predictedDependencyEdges,oracle})}}))' "$submission" '$ORACLE'`
  return [{ stepId: 'localization-observation', nativeMetric: 'code_understanding_observation', argv: ['sh', '-ceu', script.replace('$ORACLE', JSON.stringify(oracle))], cwd: '.', timeoutMs: 120_000, requiredExitCode: 0 }]
}
function memoryPlanningVerification() {
  const oracle = {
    activeFacts: [{ factId: 'owner', value: 'release-ops' }, { factId: 'region', value: 'ap-southeast-1' }, { factId: 'format', value: 'tar' }, { factId: 'channel', value: 'stable' }],
    correctedFactIds: ['region'], preCompactionFactIds: ['owner', 'channel'], longTermFactIds: ['owner', 'format', 'channel'],
    staleValues: ['us-east-1'], deletedValues: ['legacy-token-9'], foreignValues: ['green-team', 'eu-west-1', 'zip'],
    expectedPlanNodes: ['recall', 'update', 'test', 'policy', 'package', 'verify'],
    expectedDependencyEdges: [['recall', 'update'], ['update', 'test'], ['update', 'policy'], ['test', 'package'], ['policy', 'package'], ['package', 'verify']],
    expectedParallelPairs: [['test', 'policy']],
    expectedReplans: [{ triggerId: 'path-drift', supersededStepId: 'legacy-deploy', replacementStepId: 'verify' }],
  }
  const script = `npm test; git diff --exit-code HEAD -- TASK.md package.json incident memory scripts tests; submission=$(node scripts/validate-submission.mjs); node -e 'const submission=JSON.parse(process.argv[1]);const oracle=JSON.parse(process.argv[2]);console.log(JSON.stringify({metrics:{memory_planning_observation:JSON.stringify({submission,oracle,observedExecutionOrder:[]})}}))' "$submission" '$ORACLE'`
  return [{ stepId: 'memory-planning-observation', nativeMetric: 'memory_planning_observation', argv: ['sh', '-ceu', script.replace('$ORACLE', JSON.stringify(oracle))], cwd: '.', timeoutMs: 120_000, requiredExitCode: 0 }]
}
function metric(name, script) { return { stepId: name, nativeMetric: name, argv: ['sh', '-ceu', script + `; printf '%s\n' '{"metrics":{"${name}":true}}'`], cwd: '.', timeoutMs: 120_000, requiredExitCode: 0 } }
function command(type, fields) { const suffix = type.replaceAll('.', '-'); return { schemaVersion: 1, type, commandId: suffix + '-' + process.pid, idempotencyKey: suffix + '-' + process.pid, submittedAt: new Date().toISOString(), ...fields } }
async function resolveEndpointCredential() {
  if (process.env.AGENT_EVAL_CREDENTIAL_LOCAL_API_KEY) return { credential: process.env.AGENT_EVAL_CREDENTIAL_LOCAL_API_KEY, baseUrl: process.env.AGENT_EVAL_BASE_URL ?? 'http://192.0.2.5:3000' }
  const helper = option('--credential-helper')
  if (helper) {
    const result = await runFile(resolve(helper), [], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
    if (!result.stdout.trim()) throw new Error('credential helper returned an empty value')
    return { credential: result.stdout.trim(), baseUrl: process.env.AGENT_EVAL_BASE_URL ?? 'http://192.0.2.5:3000' }
  }
  const settings = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8'))
  if (typeof settings.apiKeyHelper !== 'string' || !settings.apiKeyHelper.trim()) throw new Error('set AGENT_EVAL_CREDENTIAL_LOCAL_API_KEY or configure a fresh evaluation credential source')
  const result = await runFile('/bin/bash', ['-lc', settings.apiKeyHelper], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
  if (!result.stdout.trim()) throw new Error('credential helper returned an empty value')
  return { credential: result.stdout.trim(), baseUrl: settings.env?.ANTHROPIC_BASE_URL ?? 'http://192.0.2.5:3000' }
}
async function run(binary, args, cwd, env = {}) { return await runFile(binary, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }) }
function safeId(value) { return value.toLowerCase().replace(/[^a-z0-9._:-]/gu, '-').replace(/-+/gu, '-').slice(0, 120) }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(name + ' must be a positive integer'); return parsed }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
function values(name) { const output = []; for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) output.push(process.argv[++index]); else if (process.argv[index]?.startsWith(name + '=')) output.push(process.argv[index].slice(name.length + 1)); return output }
function safeMessage(error) { return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }

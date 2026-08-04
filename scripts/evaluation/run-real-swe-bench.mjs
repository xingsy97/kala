import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
import { createSweBenchBenchmarkAdapter } from '../../adapters/benchmarks/swe-bench/dist/src/index.js'
import { createEphemeralAuth } from './fixtures/ephemeral-auth.mjs'
import { lockedEndpointDestinations, providerRootUrl } from './locked-endpoint.mjs'

const runFile = promisify(execFile)
const INSTANCE_ID = option('--instance-id') ?? 'astropy__astropy-12907'
const DATASET_ID = 'swe-bench-verified'
const DATASET_VERSION = option('--dataset-version') ?? 'verified-1'
const HARNESS_REVISION = 'f7bbbb2ccdf479001d6467c9e34af59e44a840f9'
const OFFICIAL_IMAGE = option('--official-image') ?? 'docker.io/swebench/sweb.eval.x86_64.astropy_1776_astropy-12907@sha256:f3f63bb87d581c0e7b47f900dd82165b71040e1758d3c29e915e2b18da9baf63'
const TRIAL_IMAGE = option('--image') ?? 'local:eadfb7f63cf63e47312d33b332c01a05110ed8f73de62bd8a09749e9e615b6cc'
const SOURCE_URL = option('--source-url') ?? 'https://datasets-server.huggingface.co'
const baseUrl = providerRootUrl(option('--base-url') ?? 'http://192.0.2.5:3000')
const allowedDestinations = await lockedEndpointDestinations(baseUrl)
if (!TRIAL_IMAGE.startsWith('local:') || TRIAL_IMAGE.length < 18) throw new Error('--image requires a pinned local:LXD-fingerprint')
if (!OFFICIAL_IMAGE.includes('@sha256:')) throw new Error('--official-image requires a pinned OCI digest')

const credential = await resolveCredential()
const source = await fetchFreshSource(INSTANCE_ID)
const repositoryManifestHash = await sha256Hex(canonicalJson({ repo: source.record.repo, baseCommit: source.record.base_commit, officialImage: OFFICIAL_IMAGE, trialImage: TRIAL_IMAGE }))
const adapter = createSweBenchBenchmarkAdapter()
const [task] = await adapter.resolveTasks({
  schemaVersion: 1, datasetId: DATASET_ID, datasetVersion: DATASET_VERSION, split: 'test', harnessRevision: HARNESS_REVISION,
  officialInstanceImageDigest: OFFICIAL_IMAGE, trialSandboxImageDigest: TRIAL_IMAGE, repositoryManifestHash,
  officialRecord: source.record, testTimeoutSeconds: positiveInteger(option('--test-timeout-seconds') ?? '1800', '--test-timeout-seconds'),
  license: 'MIT', evaluationPermission: 'SWE-Bench benchmark evaluation',
})
if (!task) throw new Error('SWE-Bench adapter did not resolve the requested task')

const acceptanceRoot = await mkdtemp(join(tmpdir(), 'agent-eval-real-swe-bench-'))
const dataRoot = join(acceptanceRoot, 'platform')
const artifactRoot = join(dataRoot, 'artifacts')
const workerDataDir = join(acceptanceRoot, 'worker')
await Promise.all([mkdir(artifactRoot, { recursive: true, mode: 0o700 }), mkdir(workerDataDir, { recursive: true, mode: 0o700 })])
const runId = safeId('fresh-swe-bench-' + INSTANCE_ID + '-' + new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14) + '-' + process.pid)
const agents = selectAgents(await agentVariants(baseUrl))
const evaluatedSlice = await createEvaluatedSlice(source, task, artifactRoot)
const verifierConfig = { harnessRevision: HARNESS_REVISION, officialImage: OFFICIAL_IMAGE, testTimeoutSeconds: task.benchmarkInput.testTimeoutSeconds }
const spec = {
  schemaVersion: 1, runId, taskPack: { id: 'swe-bench', version: DATASET_VERSION, evaluatedSlice }, agents,
  execution: { repeats: 1, priority: 0, maxConcurrency: agents.length, maxConcurrencyPerBackend: agents.length, maxConcurrencyPerProvider: agents.length, leaseMs: 30_000, timeoutMs: positiveInteger(option('--timeout-ms') ?? '1800000', '--timeout-ms'), inactivityTimeoutMs: positiveInteger(option('--inactivity-timeout-ms') ?? '180000', '--inactivity-timeout-ms'), retryPolicy: { maxAttempts: 1, retryableCategories: [], backoffMs: 0 } },
  sandbox: {
    provider: 'lxd-container', imageDigest: TRIAL_IMAGE, readOnlyBase: true, ephemeralOverlay: true,
    resources: { cpu: 2, memoryMb: 4096, diskMb: 8192, pids: 512 }, network: { mode: 'allowlist', allowedDestinations },
    artifactAllowlist: ['runlab-session.jsonl', 'runlab-native.tar', ...agents.map((agent) => 'swe-bench/' + runId + ':' + INSTANCE_ID + ':' + agent.variantId + ':0/official-result.json')],
  },
  verification: { verifierId: adapter.descriptor.verifierId, verifierVersion: adapter.descriptor.verifierVersion, officialRequired: true, timeoutMs: 120_000, configHash: await sha256Hex(canonicalJson(verifierConfig)) },
  analysis: { detectorIds: ['instruction-drift', 'context-forgetting', 'test-gaming', 'tool-recovery', 'planning-execution'], repeatsRequired: 1, configHash: await sha256Hex(canonicalJson({ detectorSet: 'required-v1' })) },
  createdAt: new Date().toISOString(),
}

const catalog = new RegisteredTaskCatalog()
catalog.register(evaluatedSlice.sliceManifestHash, [task])
const controlPlane = new EvaluationControlPlane({ journalPath: join(dataRoot, 'control-plane.jsonl'), reportRoot: artifactRoot, taskCatalog: catalog })
await controlPlane.initialize()
const workerId = 'real-swe-bench-' + process.pid
const graderId = 'real-swe-bench-grader-' + process.pid
const analyzerId = 'real-swe-bench-analyzer-' + process.pid
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
registry.registerBenchmark(adapter)
const workerErrors = []
const worker = new EvaluationWorker({
  controlPlane: workerClient, registry, credentials: { resolve: async (references) => Object.fromEntries(references.map((reference) => [reference.referenceId, credential])), available: async () => true },
  workerId, workerVersion: '0.0.0', cpu: 6, memoryMb: 12288, diskMb: 131072, gpu: 0, maxTrials: agents.length, leaseMs: 30_000,
  artifactRoot, workerDataDir, cancellationGraceMs: 5_000, onTrialError: (error, trialId) => workerErrors.push({ trialId, message: safeMessage(error) }),
})

let evidence
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
  evidence = await auditAcceptance({ controlPlane, provider, runId, expectedAgentIds: agents.map((agent) => agent.variantId), artifactRoot, credential, workerErrors, source })
} finally {
  await provider.reapOrphans(worker.registration.workerId).catch(() => undefined)
  await new Promise((resolvePromise) => server.close(() => resolvePromise()))
}
const output = option('--output')
if (output) { const path = resolve(output); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }) }
process.stdout.write(JSON.stringify({ ok: true, runId, instanceId: INSTANCE_ID, trials: evidence.trials, freshSandboxes: evidence.freshSandboxes, output: output ? resolve(output) : undefined }) + '\n')

async function fetchFreshSource(instanceId) {
  const filter = new URL('/filter', SOURCE_URL)
  filter.searchParams.set('dataset', 'princeton-nlp/SWE-bench_Verified')
  filter.searchParams.set('config', 'default')
  filter.searchParams.set('split', 'test')
  filter.searchParams.set('where', '"instance_id"=\'' + instanceId + '\'')
  const size = new URL('/size', SOURCE_URL)
  size.searchParams.set('dataset', 'princeton-nlp/SWE-bench_Verified')
  const [rowResponse, sizeResponse] = await Promise.all([fetch(filter), fetch(size)])
  if (!rowResponse.ok) throw new Error('fresh SWE-Bench source request failed: HTTP ' + String(rowResponse.status))
  if (!sizeResponse.ok) throw new Error('fresh SWE-Bench size request failed: HTTP ' + String(sizeResponse.status))
  const rows = await rowResponse.json()
  const sizeBody = await sizeResponse.json()
  if (!Array.isArray(rows.rows) || rows.rows.length !== 1 || !rows.rows[0]?.row) throw new Error('fresh SWE-Bench source did not return exactly one official record')
  const split = sizeBody.size?.splits?.find((entry) => entry.config === 'default' && entry.split === 'test')
  if (!split || !Number.isInteger(split.num_rows) || split.num_rows < 1) throw new Error('fresh SWE-Bench source did not return test split cardinality')
  const record = rows.rows[0].row
  const recordHash = await sha256Hex(canonicalJson(record))
  return { record, totalItems: split.num_rows, recordHash, sourceUrl: filter.origin + filter.pathname }
}

async function createEvaluatedSlice(source, task, root) {
  const taskIds = [task.taskId]
  const taskIdsHash = await sha256Hex(canonicalJson(taskIds))
  const datasetManifestHash = await sha256Hex(canonicalJson({ datasetId: DATASET_ID, version: DATASET_VERSION, split: 'test', totalItems: source.totalItems, selectedRecordHash: source.recordHash, source: source.sourceUrl }))
  const sliceManifest = { schemaVersion: 1, datasetManifestHash, selectionKind: 'explicit_ids', taskIds, taskIdsHash }
  const sliceManifestHash = await sha256Hex(canonicalJson(sliceManifest))
  const taskIdsManifestRef = 'catalog/swe-bench-' + sliceManifestHash.slice(0, 16) + '.json'
  await mkdir(join(root, 'catalog'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, taskIdsManifestRef), JSON.stringify(sliceManifest, null, 2) + '\n', { mode: 0o600 })
  return {
    sliceId: 'swe-bench-verified-explicit-' + safeId(task.taskId),
    dataset: { datasetId: DATASET_ID, displayName: 'SWE-Bench Verified', version: DATASET_VERSION, sourceRevision: datasetManifestHash, manifestHash: datasetManifestHash, taskIdsHash: datasetManifestHash, split: 'test', totalItems: source.totalItems, officialBenchmark: true, license: 'MIT', evaluationPermission: 'SWE-Bench benchmark evaluation' },
    selectionKind: 'explicit_ids', selectionSpec: { kind: 'explicit_ids', taskIdsHash }, selectedItems: 1, coverageRatio: 1 / source.totalItems, taskIdsManifestRef, sliceManifestHash,
  }
}

async function agentVariants(url) {
  const values = [
    { variantId: 'agent-runlab', backendId: 'agent-runlab', model: { provider: 'openai', modelId: option('--runlab-model') ?? 'gpt-5.6-sol' }, config: { provider: 'openai', baseUrl: url + '/v1' }, referenceId: 'runlab-api-key', provider: 'openai' },
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
    collect: (target) => inner.collect(target), destroy: async (target) => { await inner.destroy(target); destroyed.add(target.sandboxId) },
    verifyDestroyed: (target) => inner.verifyDestroyed(target), reapOrphans: (workerId) => inner.reapOrphans(workerId),
  }
}

async function auditAcceptance(input) {
  const runProjection = input.controlPlane.projection.runs.get(input.runId)
  if (!runProjection || runProjection.state !== 'completed') throw new Error('fresh SWE-Bench run did not complete: ' + JSON.stringify({ state: runProjection?.state, workerErrors: input.workerErrors }))
  const trials = runProjection.trialIds.map((trialId) => input.controlPlane.projection.trials.get(trialId))
  if (trials.length !== input.expectedAgentIds.length || trials.some((trial) => !trial || trial.state !== 'completed' || !trial.evidence)) throw new Error('fresh SWE-Bench run lacks complete canonical evidence: ' + JSON.stringify(trials.map((trial) => ({ trialId: trial?.trialId, state: trial?.state }))))
  if (input.provider.created.length !== input.expectedAgentIds.length || new Set(input.provider.created.map((item) => item.sandboxId)).size !== input.expectedAgentIds.length) throw new Error('every Agent trial requires a distinct fresh sandbox')
  if (input.provider.created.some((item) => !input.provider.destroyed.has(item.sandboxId))) throw new Error('one or more fresh SWE-Bench sandboxes were not destroyed')
  const environmentLocks = new Set()
  const trialEvidence = []
  for (const trial of trials) {
    const evidence = await verifyTrialEvidence(trial.evidence)
    environmentLocks.add(canonicalJson(evidence.environmentLock))
    if (evidence.evidenceLevel !== 'official' || evidence.benchmarkResult.benchmarkId !== 'swe-bench' || evidence.benchmarkResult.officialEvidence !== true) throw new Error('SWE-Bench trial did not produce official evidence: ' + trial.agentVariantId)
    if (evidence.benchmarkResult.verifierVersion !== HARNESS_REVISION) throw new Error('SWE-Bench verifier revision mismatch')
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
    trialEvidence.push({ trialId: trial.trialId, agentVariantId: trial.agentVariantId, resultHash: evidence.resultHash, artifactManifestHash: evidence.artifactManifest.manifestHash, evidenceLevel: evidence.evidenceLevel, nativeMetrics: evidence.benchmarkResult.nativeMetrics, normalizedEventCount: evidence.normalizedEventCount })
  }
  if (environmentLocks.size !== 1) throw new Error('SWE-Bench Agents did not use an equal locked environment')
  const jobs = [...input.controlPlane.projection.analysisJobs.values()].filter((job) => job.runId === input.runId)
  const analysisJob = jobs.find((job) => job.kind === 'detectors')
  const gradingJob = jobs.find((job) => job.kind === 'grading')
  if (jobs.length !== 2 || !analysisJob || analysisJob.state !== 'completed' || !input.controlPlane.projection.analysisOutputs.has(analysisJob.jobId)) throw new Error('fresh SWE-Bench analyzer job did not complete')
  const gradingOutput = gradingJob && input.controlPlane.projection.analysisOutputs.get(gradingJob.jobId)
  if (!gradingJob || gradingJob.state !== 'completed' || !gradingOutput || gradingOutput.outputs.length !== trials.length || gradingOutput.outputs.some((output) => output.kind !== 'grading-result')) throw new Error('fresh SWE-Bench grading job did not complete with one result per canonical trial')
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'fresh standalone Control Plane + Worker + grader + analyzer + three real Agent backends + fresh LXD sandbox + official SWE-Bench verifier', runId: input.runId, instanceId: INSTANCE_ID, sourceRecordHash: input.source.recordHash, sourceFetchedFresh: true, runState: runProjection.state, freshSandboxes: input.provider.created.length, cleanupVerified: true, environmentLockEqualAcrossAgents: true, gradingJobId: gradingJob.jobId, gradingOutputHash: gradingJob.outputManifestHash, analysisJobId: analysisJob.jobId, analysisOutputHash: analysisJob.outputManifestHash, defects: [...input.controlPlane.projection.defects.values()].filter((finding) => finding.runId === input.runId).length, workerErrors: input.workerErrors, trials: trialEvidence }
}

function command(type, fields) { const suffix = type.replaceAll('.', '-'); return { schemaVersion: 1, type, commandId: suffix + '-' + process.pid, idempotencyKey: suffix + '-' + process.pid, submittedAt: new Date().toISOString(), ...fields } }
async function resolveCredential() {
  if (process.env.AGENT_EVAL_CREDENTIAL_LOCAL_API_KEY) return process.env.AGENT_EVAL_CREDENTIAL_LOCAL_API_KEY
  const helper = option('--credential-helper')
  let result
  if (helper) result = await runFile(resolve(helper), [], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
  else {
    const settings = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    if (typeof settings.apiKeyHelper !== 'string' || !settings.apiKeyHelper.trim()) throw new Error('set AGENT_EVAL_CREDENTIAL_LOCAL_API_KEY or configure the local Claude apiKeyHelper')
    result = await runFile('/bin/bash', ['-lc', settings.apiKeyHelper], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
  }
  const value = result.stdout.trim()
  if (!value) throw new Error('credential helper returned an empty value')
  return value
}
function safeId(value) { return value.toLowerCase().replace(/[^a-z0-9._:-]/gu, '-').replace(/-+/gu, '-').slice(0, 120) }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(name + ' must be a positive integer'); return parsed }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
function values(name) { const output = []; for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) output.push(process.argv[++index]); else if (process.argv[index]?.startsWith(name + '=')) output.push(process.argv[index].slice(name.length + 1)); return output }
function safeMessage(error) { return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }

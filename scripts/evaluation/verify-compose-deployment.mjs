import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { AnalyzerInputSchema, canonicalJson, sha256Hex } from '../../packages/eval-protocol/dist/index.js'
import { ControlPlaneClient } from '../../packages/eval-sdk/dist/index.js'

const baseUrl = required('--url').replace(/\/$/u, '')
const output = option('--output')
const client = new ControlPlaneClient({ baseUrl })
const runId = 'fresh-compose-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8)
const taskId = 'compose-smoke-task'
const sliceManifestHash = 'b'.repeat(64)
const taskIdsHash = await sha256Hex(canonicalJson([taskId]))
const spec = {
  schemaVersion: 1, runId,
  taskPack: { id: 'custom-task-pack', version: '1.0.0', evaluatedSlice: {
    sliceId: 'compose-smoke-full',
    dataset: { datasetId: 'compose-smoke', displayName: 'Compose Smoke', version: '1.0.0', sourceRevision: 'compose-smoke-revision', manifestHash: 'c'.repeat(64), taskIdsHash, totalItems: 1, officialBenchmark: false, license: 'MIT', evaluationPermission: 'local standalone deployment acceptance' },
    selectionKind: 'full', selectionSpec: { kind: 'full', taskIdsHash }, selectedItems: 1, coverageRatio: 1, taskIdsManifestRef: 'catalog/compose-smoke.json', sliceManifestHash,
  } },
  agents: [{ variantId: 'compose-agent', backendId: 'custom-command', agentVersion: 'acceptance', model: { modelId: 'deterministic-fixture' }, configHash: 'd'.repeat(64), config: {}, credentialRefs: [] }],
  execution: { repeats: 1, priority: 0, maxConcurrency: 1, maxConcurrencyPerBackend: 1, maxConcurrencyPerProvider: 1, leaseMs: 30_000, timeoutMs: 30_000, inactivityTimeoutMs: 5_000, retryPolicy: { maxAttempts: 1, retryableCategories: [], backoffMs: 0 } },
  sandbox: { provider: 'docker', imageDigest: 'alpine@sha256:' + 'e'.repeat(64), readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 256, diskMb: 256, pids: 64 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] },
  verification: { verifierId: 'compose-native', verifierVersion: '1.0.0', officialRequired: false, timeoutMs: 30_000, configHash: 'f'.repeat(64) },
  analysis: { detectorIds: ['instruction-drift'], repeatsRequired: 1, configHash: '1'.repeat(64) },
  createdAt: new Date().toISOString(),
}

await client.command(command('run.create', { spec }))
await client.command(command('run.start', { runId }))
await client.registerWorker({ schemaVersion: 1, workerId: 'compose-fixture-worker', workerVersion: 'acceptance', protocolVersions: [1], sandboxProviders: ['docker'], agentBackends: ['custom-command'], benchmarkAdapters: ['custom-task-pack'], capacity: { cpu: 1, memoryMb: 256, diskMb: 256, gpu: 0, maxTrials: 1 } })
const lease = await client.acquireLease('compose-fixture-worker', 30_000)
if (!lease) throw new Error('Compose acceptance did not receive a trial lease')
const prefix = runId + '/' + lease.trialId + '/'
const at = new Date().toISOString()
const analyzerUnsigned = {
  schemaVersion: 1, runId, trialId: lease.trialId, taskId, events: [{ schemaVersion: 1, sequence: 0, at, kind: 'status', data: { state: 'completed' } }],
  constraints: [{ id: 'canonical-smoke', kind: 'must', sourceRef: 'task#canonical-smoke', verifierId: 'compose-native', verifierVersion: '1.0.0', verifierMetric: 'passed' }],
  constraintLifecycle: [{ constraintId: 'canonical-smoke', state: 'satisfied', eventSequence: 0, evidenceRefs: [prefix + 'verifier-result.json'] }],
  memoryProbes: [], toolAttempts: [], planSteps: [], workspaceIntegrity: { changedPaths: [], deletedPaths: [], protectedPaths: [], hiddenVerifierPaths: [], verifierLeakagePaths: [], suspiciousLiteralEvidenceRefs: [] },
  verifierIntegrity: { passed: true, protectedIntegrityPassed: true, hiddenVerifierPassed: true, selectedTestFraction: 1, evidenceRefs: [prefix + 'verifier-result.json'] },
}
const analyzerInput = AnalyzerInputSchema.parse({ ...analyzerUnsigned, inputManifestHash: await sha256Hex(canonicalJson(analyzerUnsigned)) })
const files = new Map([
  ['native-events.jsonl', Buffer.from(canonicalJson({ kind: 'completed' }) + '\n')],
  ['normalized-events.jsonl', Buffer.from(canonicalJson(analyzerUnsigned.events[0]) + '\n')],
  ['analyzer-input.json', Buffer.from(canonicalJson(analyzerInput))],
  ['final.diff', Buffer.from('diff --git a/fixture b/fixture\n')],
  ['stdout.log', Buffer.from('compose acceptance\n')],
  ['stderr.log', Buffer.alloc(0)],
  ['verifier-result.json', Buffer.from(canonicalJson({ passed: true }))],
])
const mediaType = (name) => name.endsWith('.json') ? 'application/json' : name.endsWith('.jsonl') ? 'application/x-ndjson' : 'text/plain; charset=utf-8'
const entries = [...files].map(([name, content]) => ({ artifactId: name, path: prefix + name, mediaType: mediaType(name), bytes: content.byteLength, sha256: sha256(content), redaction: 'passed', classification: 'operator' }))
for (const entry of entries) await client.stageTrialArtifact({ leaseId: lease.leaseId, commitToken: lease.commitToken, ...entry, content: files.get(entry.artifactId) })
const unsignedManifest = { schemaVersion: 1, runId, trialId: lease.trialId, leaseId: lease.leaseId, generatedAt: at, entries }
const artifactManifest = { ...unsignedManifest, manifestHash: await sha256Hex(canonicalJson(unsignedManifest)) }
const unsignedEvidence = {
  schemaVersion: 1, runId, trialId: lease.trialId, agentVariantId: 'compose-agent', taskId, repeatIndex: 0,
  environmentLock: { schemaVersion: 1, provider: 'docker', imageDigest: spec.sandbox.imageDigest, repositoryRevision: 'compose-smoke-revision', dependencyLockHashes: {}, redactedEnvironment: {}, resourcePolicyHash: '2'.repeat(64), networkPolicyHash: '3'.repeat(64), toolchainVersions: {}, fixtureVersions: {}, faultInjectorVersions: {} },
  nativeEventsRef: prefix + 'native-events.jsonl', normalizedEventsRef: prefix + 'normalized-events.jsonl', normalizedEventCount: 1, analyzerInputRef: prefix + 'analyzer-input.json', finalDiffRef: prefix + 'final.diff', stdoutRef: prefix + 'stdout.log', stderrRef: prefix + 'stderr.log',
  usage: { availability: 'unavailable', reason: 'deterministic deployment acceptance' },
  benchmarkResult: { schemaVersion: 1, benchmarkId: 'custom-task-pack', verifierId: 'compose-native', verifierVersion: '1.0.0', nativeMetrics: { passed: true }, rawResultRef: prefix + 'verifier-result.json', officialEvidence: false },
  artifactManifest, evidenceLevel: 'native',
}
const evidence = { ...unsignedEvidence, resultHash: await sha256Hex(canonicalJson(unsignedEvidence)) }
await client.commitTrialResult({ schemaVersion: 1, leaseId: lease.leaseId, trialId: lease.trialId, attempt: lease.attempt, commitToken: lease.commitToken, resultHash: evidence.resultHash, artifactManifestHash: artifactManifest.manifestHash, evidence, resourceUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 1 }, terminalState: 'completed', committedAt: at })
await client.command(command('run.grade', { runId }))
await client.command(command('run.analyze', { runId, detectorIds: spec.analysis.detectorIds }))
const jobs = await waitForJobs(runId)
for (const job of jobs) {
  if (job.state !== 'completed' || !job.outputManifestHash) throw new Error('Compose executor job did not complete: ' + JSON.stringify(job))
}
const outputs = await Promise.all(jobs.map(async (job) => await client.query({ resource: 'analysis-output', jobId: job.jobId })))
const grading = jobs.find((job) => job.kind === 'grading')
const gradingOutput = grading && outputs[jobs.indexOf(grading)]
if (!gradingOutput || gradingOutput.outputs.length !== 1 || gradingOutput.outputs[0].kind !== 'grading-result') throw new Error('Compose grader did not produce canonical grading output')
const [run, trial] = await Promise.all([
  client.query({ resource: 'run', runId }),
  client.query({ resource: 'trial', trialId: lease.trialId }),
])
const deploymentEvidence = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  scope: 'fresh standalone Compose deployment acceptance; deterministic canonical trial; durable grader and analyzer',
  baseUrl, runId, trialId: lease.trialId, run, trial,
  jobs: jobs.map((job, index) => ({ ...job, output: outputs[index] })),
}
if (output) {
  const path = resolve(output)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(deploymentEvidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}
process.stdout.write(JSON.stringify({ ok: true, runId, trialId: lease.trialId, jobs: jobs.map((job) => ({ jobId: job.jobId, kind: job.kind, state: job.state, outputManifestHash: job.outputManifestHash })), output: output ? resolve(output) : undefined }) + '\n')

async function waitForJobs(run) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const response = await client.query({ resource: 'analysis-jobs', runId: run, page: { limit: 10 } })
    if (response.items.length === 2 && response.items.every((job) => ['completed', 'failed'].includes(job.state))) return response.items
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Compose analyzer/grader jobs did not finish before timeout')
}
function command(type, fields) { const id = type.replaceAll('.', '-') + '-' + randomUUID(); return { schemaVersion: 1, type, commandId: id, idempotencyKey: id, submittedAt: new Date().toISOString(), ...fields } }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
function required(name) { const value = option(name); if (!value) throw new Error(name + ' is required'); return value }

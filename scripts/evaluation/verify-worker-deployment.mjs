import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { canonicalJson, sha256Hex, verifyTrialEvidence } from '../../packages/eval-protocol/dist/index.js'
import { ControlPlaneClient } from '../../packages/eval-sdk/dist/index.js'

const baseUrl = required('--url').replace(/\/$/u, '')
const trialImage = required('--trial-image')
if (!/@sha256:[a-f0-9]{64}$/u.test(trialImage)) throw new Error('--trial-image must use an immutable repository digest')
const output = option('--output')
const workerId = option('--worker-id') ?? 'worker-compose'
const client = new ControlPlaneClient({ baseUrl })
const runId = 'fresh-worker-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8)
const taskId = 'compose-smoke-task'
const agentVariantId = 'compose-worker-agent'
const trialId = [runId, taskId, agentVariantId, '0'].join(':')
const taskIdsHash = await sha256Hex(canonicalJson([taskId]))
const sliceManifestHash = 'b'.repeat(64)
const commandConfig = { argv: ['sh', '-ceu', 'printf "# Deterministic evaluation fixture\n\nstandalone worker accepted\n" > README.md; printf "worker deployment accepted\n"'] }
const spec = {
  schemaVersion: 1, runId,
  taskPack: { id: 'custom-task-pack', version: '1.0.0', evaluatedSlice: {
    sliceId: 'compose-smoke-full',
    dataset: { datasetId: 'compose-smoke', displayName: 'Compose Smoke', version: '1.0.0', sourceRevision: 'compose-smoke-revision', manifestHash: 'c'.repeat(64), taskIdsHash, totalItems: 1, officialBenchmark: false, license: 'MIT', evaluationPermission: 'local standalone Worker deployment acceptance' },
    selectionKind: 'full', selectionSpec: { kind: 'full', taskIdsHash }, selectedItems: 1, coverageRatio: 1, taskIdsManifestRef: 'catalog/compose-smoke.json', sliceManifestHash,
  } },
  agents: [{ variantId: agentVariantId, backendId: 'custom-command', agentVersion: '1.0.0', model: { modelId: 'deterministic-command' }, configHash: await sha256Hex(canonicalJson(commandConfig)), config: commandConfig, credentialRefs: [] }],
  execution: { repeats: 1, priority: 0, maxConcurrency: 1, maxConcurrencyPerBackend: 1, maxConcurrencyPerProvider: 1, leaseMs: 30_000, timeoutMs: 30_000, inactivityTimeoutMs: 5_000, retryPolicy: { maxAttempts: 1, retryableCategories: [], backoffMs: 0 } },
  sandbox: { provider: 'docker', imageDigest: trialImage, readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 256, diskMb: 256, pids: 64 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: ['custom-task-pack/' + trialId + '/native-result.json'] },
  verification: { verifierId: 'custom-task-verifier', verifierVersion: '1.0.0', officialRequired: false, timeoutMs: 30_000, configHash: 'f'.repeat(64) },
  analysis: { detectorIds: ['instruction-drift'], repeatsRequired: 1, configHash: '1'.repeat(64) },
  createdAt: new Date().toISOString(),
}

const worker = await waitForWorker()
await client.command(command('run.create', { spec }))
await client.command(command('run.start', { runId }))
const trial = await waitForTrial()
if (trial.state !== 'completed' || !trial.evidence) throw new Error('standalone Worker trial did not complete: ' + JSON.stringify({ state: trial.state, failure: trial.failure }))
const evidence = await verifyTrialEvidence(trial.evidence)
if (evidence.environmentLock.provider !== 'docker' || evidence.environmentLock.imageDigest !== trialImage) throw new Error('Worker trial environment lock does not preserve the pinned Docker image')
if (evidence.benchmarkResult.nativeMetrics.passed !== true || evidence.benchmarkResult.officialEvidence !== false) throw new Error('Worker trial native verifier did not produce non-official passing evidence')
if (evidence.evidenceLevel !== 'native' || evidence.normalizedEventCount < 2) throw new Error('Worker trial lacks native normalized command evidence')
const finalDiff = evidence.artifactManifest.entries.find((entry) => entry.path === evidence.finalDiffRef)
if (!finalDiff || finalDiff.bytes === 0) throw new Error('Worker trial final diff is empty')
const nativeResult = evidence.artifactManifest.entries.find((entry) => entry.path.endsWith('/extra/custom-task-pack/' + trialId + '/native-result.json'))
if (!nativeResult) throw new Error('Worker did not import the allowlisted native verifier artifact')
const run = await client.query({ resource: 'run', runId })
const events = await client.query({ resource: 'events', runId, afterSequence: -1, page: { limit: 100 } })
const trialStates = events.items.filter((event) => event.type === 'trial.state').map((event) => event.data.state)
for (const state of ['leased', 'environment_preparing', 'agent_running', 'artifacts_collecting', 'verifying', 'analyzing', 'completed']) {
  if (!trialStates.includes(state)) throw new Error('Worker trial lifecycle is missing state ' + state)
}
const deploymentEvidence = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  scope: 'fresh standalone eval-worker process deployment; public plugins; real Docker trial sandbox; canonical evidence; verified lifecycle',
  baseUrl, worker, runId, trialId, runState: run.state, trialState: trial.state, trialAttempt: trial.attempt,
  sandbox: { provider: evidence.environmentLock.provider, imageDigest: evidence.environmentLock.imageDigest, toolchainVersions: evidence.environmentLock.toolchainVersions },
  lifecycleStates: trialStates,
  evidence: { resultHash: evidence.resultHash, artifactManifestHash: evidence.artifactManifest.manifestHash, evidenceLevel: evidence.evidenceLevel, normalizedEventCount: evidence.normalizedEventCount, finalDiffBytes: finalDiff.bytes, nativeVerifierArtifact: nativeResult.path, nativeMetrics: evidence.benchmarkResult.nativeMetrics },
}
if (output) {
  const path = resolve(output)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(deploymentEvidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}
process.stdout.write(JSON.stringify({ ok: true, workerId, runId, trialId, trialState: trial.state, finalDiffBytes: finalDiff.bytes, output: output ? resolve(output) : undefined }) + '\n')

async function waitForWorker() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const response = await client.query({ resource: 'workers', page: { limit: 100 } })
    const found = response.items.find((item) => item.registration.workerId === workerId)
    if (found) {
      const registration = found.registration
      if (!registration.protocolVersions.includes(1) || !registration.sandboxProviders.includes('docker') || !registration.agentBackends.includes('custom-command') || !registration.benchmarkAdapters.includes('custom-task-pack')) throw new Error('Worker registration lacks required protocol/plugin capabilities')
      return found
    }
    await delay(250)
  }
  throw new Error('standalone Worker did not register before timeout')
}
async function waitForTrial() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const trial = await client.query({ resource: 'trial', trialId })
    if (trial && ['completed', 'blocked', 'timeout', 'cancelled', 'agent_error', 'environment_error', 'verifier_error', 'indeterminate'].includes(trial.state)) return trial
    await delay(250)
  }
  throw new Error('standalone Worker trial did not finish before timeout')
}
function command(type, fields) { const id = type.replaceAll('.', '-') + '-' + randomUUID(); return { schemaVersion: 1, type, commandId: id, idempotencyKey: id, submittedAt: new Date().toISOString(), ...fields } }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function option(name) { for (let index = 2; index < process.argv.length; index += 1) if (process.argv[index] === name) return process.argv[index + 1]; else if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1) }
function required(name) { const value = option(name); if (!value) throw new Error(name + ' is required'); return value }

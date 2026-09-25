import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentBackendDescriptorSchema, EnvironmentLockSchema, ResolvedTaskSchema, SandboxDescriptorSchema, StaticSigningKeyRegistry, TraceSpanSchema,
  type EvaluationRunSpec, type NormalizedAgentEvent, type TrialLease,
} from '@agent-kernel/eval-protocol'
import { AgentProviderError, ControlPlaneClient, type AgentRunArtifacts, type AgentRunHandle, type EvaluationAgentBackend, type EvaluationBenchmarkAdapter, type EvaluationSandboxProvider, type SandboxExecutionTarget } from '@agent-kernel/eval-sdk'
import { BearerTokenAuthenticator, EvaluationControlPlane, RegisteredTaskCatalog, createEvaluationHttpServer } from '@agent-kernel/eval-orchestrator'

import { EnvironmentCredentialResolver } from './credentials.js'
import { WorkerRuntimeRegistry } from './registry.js'
import { TrialRunner } from './trial-runner.js'
import { EvaluationWorker } from './worker.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const HASH = 'a'.repeat(64)
const OPERATOR_TOKEN = 'operator-test-token'
const WORKER_TOKEN = 'worker-test-token'
const WORKER_ID = 'worker'
const FIXTURE_POLICY = { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'test' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:worker-integration'] }, publication: { artifact: { status: 'granted', basis: 'test' }, report: { status: 'granted', basis: 'test' }, leaderboard: { status: 'granted', basis: 'test' }, redistribution: { status: 'granted', basis: 'MIT' } } } as const
const signingKey = generateKeyPairSync('ed25519')
const signingKeyReference = 'fixture-key'
const signingProvider = { keyReference: signingKeyReference, validate: async () => undefined, signSha256: async (digest: string) => ({ algorithm: 'ed25519' as const, keyReference: signingKeyReference, valueBase64: sign(null, Buffer.from(digest, 'hex'), signingKey.privateKey).toString('base64') }) }
const signingKeyRegistry = new StaticSigningKeyRegistry({ schemaVersion: 1, keys: [{ keyReference: signingKeyReference, algorithm: 'ed25519', publicKeySpkiBase64: createPublicKey(signingKey.privateKey).export({ format: 'der', type: 'spki' }).toString('base64'), scopes: ['artifact_manifest', 'trial_result'], status: 'active', validFrom: '2020-01-01T00:00:00.000Z' }] })
const servers: Server[] = []
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))))

async function harness(options: { backend?: Partial<EvaluationAgentBackend>; destroyVerified?: boolean; collect?: EvaluationSandboxProvider['collect']; now?: () => Date } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'eval-worker-integration-'))
  const spec = JSON.parse(await readFile(join(packageRoot, '..', 'eval-protocol', 'fixtures', 'canonical-run-spec-v1.json'), 'utf8')) as EvaluationRunSpec
  const task = ResolvedTaskSchema.parse({
    schemaVersion: 1, taskId: 'task-one', taskPackId: 'swe-bench', taskPackVersion: 'verified-1', title: 'Fixture', prompt: 'Make the fixture pass.',
    repository: { kind: 'artifact', archiveRef: 'fixtures/task-one.tar', archiveSha256: HASH, revision: 'fixture-revision' },
    fixtureManifestHash: HASH, faultScenarioIds: [], verification: [{ stepId: 'test', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }],
    analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] },
    policy: FIXTURE_POLICY,
  })
  const catalog = new RegisteredTaskCatalog()
  catalog.register(spec.taskPack.evaluatedSlice.sliceManifestHash, [task, { ...task, taskId: 'task-two' }])
  const controlPlane = new EvaluationControlPlane({ journalPath: join(directory, 'journal.jsonl'), taskCatalog: catalog, signingKeyRegistry, ...(options.now ? { now: options.now } : {}) })
  await controlPlane.initialize()
  const authenticator = new BearerTokenAuthenticator({ schemaVersion: 1, keys: [
    { key: OPERATOR_TOKEN, principal: { schemaVersion: 1, principalId: 'operator-one', kind: 'user', role: 'operator', scopes: ['platform:read', 'evaluation:read', 'evaluation:write', 'evidence:read'] } },
    { key: WORKER_TOKEN, principal: { schemaVersion: 1, principalId: 'worker-one-principal', kind: 'service', role: 'worker', serviceId: WORKER_ID, scopes: ['platform:read', 'worker:execute'] } },
  ] })
  const server = createEvaluationHttpServer(controlPlane, { authenticator })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseUrl = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
  const operatorClient = new ControlPlaneClient({ baseUrl, credentialProvider: () => OPERATOR_TOKEN })
  const client = new ControlPlaneClient({ baseUrl, credentialProvider: () => WORKER_TOKEN })
  client.query = operatorClient.query.bind(operatorClient)
  await operatorClient.command({ schemaVersion: 1, type: 'run.create', commandId: 'create', idempotencyKey: 'create', submittedAt: spec.createdAt, spec })
  await operatorClient.command({ schemaVersion: 1, type: 'run.start', commandId: 'start', idempotencyKey: 'start', submittedAt: spec.createdAt, runId: spec.runId })
  const registry = new WorkerRuntimeRegistry()
  let destroyed = false
  const target: SandboxExecutionTarget = {
    sandboxId: 'sandbox-one', descriptor: SandboxDescriptorSchema.parse({ schemaVersion: 1, providerId: 'docker-fixture', kind: 'docker', version: '1', protocolVersions: [1] }), workspacePath: '/workspace',
    execute: async () => ({ exitCode: 0, stdout: '', stderr: '', startedAt: spec.createdAt, completedAt: spec.createdAt, timedOut: false }),
    putArchive: async () => undefined, getArchive: async () => undefined,
    snapshot: async () => ({ snapshotId: 'snapshot', createdAt: spec.createdAt, manifestHash: HASH, files: [] }),
  }
  let sandboxSequence = 0
  const provider: EvaluationSandboxProvider = {
    descriptor: target.descriptor,
    preflight: async () => ({ ok: true, errors: [], warnings: [], resolvedVersion: '1' }),
    create: async () => ({ ...target, sandboxId: 'sandbox-' + String(++sandboxSequence) }),
    collect: options.collect ?? (async () => ({ artifactRoot: directory, cleanupEvidence: {}, environmentLock: EnvironmentLockSchema.parse({ schemaVersion: 1, provider: 'docker', imageDigest: spec.sandbox.imageDigest, repositoryRevision: 'fixture-revision', dependencyLockHashes: {}, redactedEnvironment: {}, resourcePolicyHash: HASH, networkPolicyHash: HASH, toolchainVersions: { node: '22' }, fixtureVersions: { task: '1' }, faultInjectorVersions: {} }) })),
    destroy: async () => { destroyed = true },
    verifyDestroyed: async () => options.destroyVerified ?? destroyed,
    reapOrphans: async () => [],
  }
  const defaultArtifacts: AgentRunArtifacts = { completedAt: spec.createdAt, finalDiff: 'diff --git a/a b/a\n', nativeEvents: [{ kind: 'done' }], normalizedEvents: [{ schemaVersion: 1, sequence: 0, at: spec.createdAt, kind: 'status', data: { state: 'done' } }], stdout: 'ok', stderr: '', usage: { availability: 'unavailable', reason: 'fixture' }, version: '1', configHash: HASH, extraArtifactPaths: [] }
  const handle: AgentRunHandle = { handleId: 'handle-one', startedAt: spec.createdAt, nativeProcessIds: ['123'] }
  const backend: EvaluationAgentBackend = {
    descriptor: AgentBackendDescriptorSchema.parse({ schemaVersion: 1, id: 'agent-runlab', label: 'Fixture RunLab', version: '1', configSchemaVersion: 1, ranked: true, evidenceLevel: 'native', capabilities: { nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true, absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: true, finalDiff: true, usage: 'unavailable_explicit' } }),
    preflight: async () => ({ ok: true, errors: [], warnings: [], resolvedVersion: '1' }),
    start: async () => handle,
    events: async function* (): AsyncIterable<NormalizedAgentEvent> { yield defaultArtifacts.normalizedEvents[0]! },
    cancel: async () => undefined, collect: async () => defaultArtifacts,
    ...options.backend,
  }
  const benchmark: EvaluationBenchmarkAdapter = {
    descriptor: { schemaVersion: 1, protocolVersions: [1], id: 'swe-bench', label: 'Fixture SWE-Bench', version: '1', official: true, nativePrimaryMetric: 'resolved', verifierId: 'swe-bench-official', verifierVersion: '1' },
    resolveTasks: async () => [task],
    prepareTask: async () => undefined,
    verify: async () => ({ result: { schemaVersion: 1, benchmarkId: 'swe-bench', verifierId: 'swe-bench-official', verifierVersion: '1', nativeMetrics: { resolved: true }, rawResultRef: 'verifier-result.json', officialEvidence: true }, stdout: 'passed', stderr: '', artifactPaths: [] }),
    explain: (result) => result.nativeMetrics,
    normalizeFailure: () => null,
  }
  registry.registerSandbox(provider); registry.registerAgent(backend); registry.registerBenchmark(benchmark)
  await client.registerWorker({ schemaVersion: 1, workerId: WORKER_ID, signingKeyReference: 'fixture-key', workerVersion: '1', protocolVersions: [1], sandboxProviders: ['docker'], agentBackends: ['agent-runlab'], benchmarkAdapters: ['swe-bench'], capacity: { cpu: 2, memoryMb: 4096, diskMb: 32768, gpu: 0, maxTrials: 1 } })
  const lease = (await client.acquireLease(WORKER_ID, 10_000))!
  const credentials = new EnvironmentCredentialResolver({ AGENT_EVAL_CREDENTIAL_FIXTURE_KEY: 'fixture-secret-value' })
  const runner = new TrialRunner({ controlPlane: client, registry, credentials, artifactRoot: join(directory, 'artifacts'), workerDataDir: join(directory, 'worker'), signingProvider, cancellationGraceMs: 10 })
  return { client, operatorClient, controlPlane, lease, runner, directory, backend, benchmark, target, provider, registry, credentials, server, spec }
}

describe('Worker durable Control Plane integration', () => {
  it('runs a fresh sandbox through Agent, verifier, artifact integrity, cleanup, and committed completion', async () => {
    const { runner, lease, client, operatorClient, controlPlane, directory, spec } = await harness()
    const receipts: string[] = []
    const states: string[] = []
    await runner.run(lease, undefined, {
      executionReceipt: async (receipt) => { receipts.push(receipt) },
      progress: async (state) => {
        states.push(state)
        await client.progressTrial({ schemaVersion: 1, leaseId: lease.leaseId, workerId: lease.workerId, trialId: lease.trialId, state, at: new Date().toISOString() })
      },
    })
    expect(receipts).toEqual(['indeterminate', 'known'])
    expect(states).toEqual(['environment_preparing', 'agent_running', 'artifacts_collecting', 'verifying', 'analyzing'])
    expect(controlPlane.projection.trials.get(lease.trialId)?.state).toBe('completed')
    expect(controlPlane.projection.trials.get(lease.trialId)?.evidence).toMatchObject({ evidenceLevel: 'official', benchmarkResult: { officialEvidence: true } })
    expect(controlPlane.projection.leases.get(lease.leaseId)?.state).toBe('closed')
    const result = JSON.parse(await readFile(join(directory, 'artifacts', lease.runId, lease.trialId, 'result.json'), 'utf8')) as { traceRef: string; artifactManifest: { entries: Array<{ path: string; sha256: string }> } }
    for (const entry of result.artifactManifest.entries) {
      const body = await readFile(join(directory, 'artifacts', entry.path))
      expect(createHash('sha256').update(body).digest('hex')).toBe(entry.sha256)
    }
    expect(result.traceRef).toBe(lease.runId + '/' + lease.trialId + '/trace.jsonl')
    const traceLines = (await readFile(join(directory, 'artifacts', result.traceRef), 'utf8')).trim().split('\n').map((line) => TraceSpanSchema.parse(JSON.parse(line)))
    expect(traceLines.map((span) => span.name)).toEqual(expect.arrayContaining(['evaluation.run', 'evaluation.trial', 'environment.prepare', 'agent.execute', 'workspace.snapshot', 'verifier.execute']))
    expect(result.artifactManifest.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([lease.runId + '/' + lease.trialId + '/workspace.before.json', lease.runId + '/' + lease.trialId + '/workspace.after.json']))
    await expect(operatorClient.query({ resource: 'artifacts', runId: lease.runId, trialId: lease.trialId, page: { limit: 50 } })).resolves.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ artifactId: 'final.diff' })]) })
    const restarted = new EvaluationControlPlane({ journalPath: join(directory, 'journal.jsonl'), taskCatalog: new RegisteredTaskCatalog() })
    await restarted.initialize()
    expect(restarted.projection.trials.get(lease.trialId)?.evidence?.resultHash).toBe(controlPlane.projection.trials.get(lease.trialId)?.evidence?.resultHash)
    expect(restarted.projection.runs.get(spec.runId)?.state).toBe('running')
  })

  it('calls backend cancellation on timeout and commits a timeout only after cleanup', async () => {
    const cancel = vi.fn(async () => undefined)
    const { runner, lease, controlPlane } = await harness({ backend: { cancel, events: async function* () { await new Promise<never>(() => undefined) } } })
    const run = controlPlane.projection.runs.get(lease.runId)!
    run.accepted.spec.execution.timeoutMs = 20
    await runner.run(lease)
    expect(cancel).toHaveBeenCalledOnce()
    expect(controlPlane.projection.trials.get(lease.trialId)?.state).toBe('timeout')
  })

  it('never commits completed when destruction verification fails', async () => {
    const { runner, lease, controlPlane } = await harness({ destroyVerified: false })
    await runner.run(lease)
    expect(controlPlane.projection.trials.get(lease.trialId)?.state).toBe('environment_error')
    const committed = controlPlane.projection.resultCommits.get(lease.trialId)
    expect(committed?.terminalState).toBe('environment_error')
  })

  it('classifies interrupted artifact collection as platform environment failure and still cleans up', async () => {
    const { runner, lease, controlPlane, directory } = await harness({ collect: async () => { throw new Error('artifact transport interrupted') } })
    await runner.run(lease)
    expect(controlPlane.projection.trials.get(lease.trialId)?.state).toBe('environment_error')
    const failure = JSON.parse(await readFile(join(directory, 'artifacts', lease.runId, lease.trialId, 'failure.json'), 'utf8')) as { code: string }
    expect(failure.code).toBe('ARTIFACT_ERROR')
  })

  it('retries an interrupted HTTP artifact upload without duplicating canonical evidence', async () => {
    const fixture = await harness()
    const upload = vi.spyOn(fixture.client, 'stageTrialArtifact')
    const original = upload.getMockImplementation()
    upload.mockRejectedValueOnce(Object.assign(new Error('socket reset during upload'), { code: 'ECONNRESET' }))
    if (original) upload.mockImplementation(original)
    await runWithDurableProgress(fixture)
    expect(upload.mock.calls.length).toBeGreaterThan(8)
    expect(fixture.controlPlane.projection.resultCommits.get(fixture.lease.trialId)?.terminalState).toBe('completed')
    expect(fixture.controlPlane.projection.trials.get(fixture.lease.trialId)?.evidence?.artifactManifest.entries).toHaveLength(11)
  })

  it('retries a lost result acknowledgement against the idempotent committed result', async () => {
    const fixture = await harness()
    const original = fixture.client.commitTrialResult.bind(fixture.client)
    let lost = true
    const commit = vi.spyOn(fixture.client, 'commitTrialResult').mockImplementation(async (value, signal) => {
      const accepted = await original(value, signal)
      if (lost) { lost = false; throw Object.assign(new Error('acknowledgement lost'), { code: 'ECONNRESET' }) }
      return accepted
    })
    await fixture.runner.run(fixture.lease)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(fixture.controlPlane.projection.resultCommits).toHaveLength(1)
    expect(fixture.controlPlane.projection.trials.get(fixture.lease.trialId)?.state).toBe('completed')
  })

  it.each([
    ['rate limit', new AgentProviderError('rate_limited', 'provider returned 429')],
    ['provider timeout', new AgentProviderError('timeout', 'provider request timed out')],
  ])('classifies %s as retryable provider responsibility', async (_name, providerError) => {
    const fixture = await harness({ backend: { start: async () => { throw providerError } } })
    await runWithDurableProgress(fixture)
    const failed = fixture.controlPlane.projection.failedAttempts.get(fixture.lease.trialId + '|1')
    expect(failed).toMatchObject({ terminalState: 'agent_error', failure: { category: 'provider_failure', responsibility: 'provider', retryable: true } })
    expect(fixture.controlPlane.projection.trials.get(fixture.lease.trialId)?.state).toBe('queued')
  })

  it('bounds a verifier that ignores cancellation and attributes the timeout to the verifier', async () => {
    const fixture = await harness()
    fixture.controlPlane.projection.runs.get(fixture.lease.runId)!.accepted.spec.verification.timeoutMs = 20
    fixture.benchmark.verify = async () => await new Promise<never>(() => undefined)
    await fixture.runner.run(fixture.lease)
    expect(fixture.controlPlane.projection.resultCommits.get(fixture.lease.trialId)).toMatchObject({ terminalState: 'timeout', failure: { category: 'timeout', responsibility: 'verifier', code: 'VERIFIER_TIMEOUT' } })
  })

  it.each([
    ['setup failure', Object.assign(new Error('sandbox setup failed'), { code: 'SETUP_FAILED' }), 'ENVIRONMENT_ERROR'],
    ['disk exhaustion', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }), 'RESOURCE_EXHAUSTED'],
  ])('classifies %s as environment responsibility', async (_name, injected, expectedCode) => {
    const fixture = await harness()
    fixture.provider.create = async () => { throw injected }
    await fixture.runner.run(fixture.lease)
    expect(fixture.controlPlane.projection.resultCommits.get(fixture.lease.trialId)).toMatchObject({ terminalState: 'environment_error', failure: { category: 'environment_failure', responsibility: 'environment', code: expectedCode } })
  })

  it('attributes an observable Agent failure to the Agent and records sufficient recovery state', async () => {
    const fixture = await harness({ backend: { start: async () => { throw new Error('Agent chose an invalid observable action') } } })
    await runWithDurableProgress(fixture)
    expect(fixture.controlPlane.projection.resultCommits.get(fixture.lease.trialId)).toMatchObject({
      terminalState: 'agent_error',
      failure: { category: 'agent_failure', responsibility: 'agent', retryable: false, observedStateSufficientForRecovery: true },
    })
  })

  it('runs Worker and lease heartbeats and reaps only its labelled orphan set on process start', async () => {
    const fixture = await harness()
    await fixture.runner.run(fixture.lease)
    const reap = vi.spyOn(fixture.provider, 'reapOrphans')
    const workerHeartbeat = vi.spyOn(fixture.client, 'heartbeatWorker')
    const leaseHeartbeat = vi.spyOn(fixture.client, 'heartbeatLease')
    const controller = new AbortController()
    const worker = evaluationWorker(fixture, 120)
    const running = worker.start(controller.signal)
    await waitUntil(() => reap.mock.calls.length > 0 && workerHeartbeat.mock.calls.length > 0 && leaseHeartbeat.mock.calls.length > 0)
    controller.abort(new Error('test complete'))
    await running
    expect(reap).toHaveBeenCalledWith('worker')
  })

  it('can drain a finite real-run queue without a long-lived process loop', async () => {
    const fixture = await harness()
    await fixture.runner.run(fixture.lease)
    const errors: unknown[] = []
    const worker = evaluationWorker(fixture, 10_000, (error) => errors.push(error))
    await worker.runUntilIdle({ idlePolls: 1, pollIntervalMs: 1 })
    expect(errors).toEqual([])
    expect(fixture.controlPlane.projection.runs.get(fixture.spec.runId)?.state, JSON.stringify([...fixture.controlPlane.projection.resultCommits.values()].map(({ trialId, terminalState, failure }) => ({ trialId, terminalState, failure })), null, 2)).toBe('completed')
    expect([...fixture.controlPlane.projection.trials.values()].every((trial) => trial.state === 'completed')).toBe(true)
  })

  it('classifies an in-flight trial indeterminate after hard Worker loss stops lease heartbeats', async () => {
    let now = new Date()
    const fixture = await harness({ now: () => now })
    await fixture.runner.run(fixture.lease)
    const lease = (await fixture.client.acquireLease('worker', 20))!
    await fixture.client.heartbeatLease({ schemaVersion: 1, leaseId: lease.leaseId, workerId: 'worker', at: new Date().toISOString(), lastEventSequence: 0 }, 'indeterminate')
    now = new Date(now.getTime() + 21)
    await expect(fixture.operatorClient.expireLeases()).resolves.toBe(1)
    expect(fixture.controlPlane.projection.trials.get(lease.trialId)?.state).toBe('indeterminate')
    expect(fixture.controlPlane.projection.leases.get(lease.leaseId)?.state).toBe('closed')
  })

  it('propagates durable run cancellation through a rejected lease heartbeat to the live Agent', async () => {
    // Real worker timers remain active; only Control Plane lease time is fixed.
    // Cancellation, not a loaded CI runner expiring a 120 ms lease, must reject it.
    const now = new Date()
    const fixture = await harness({ now: () => now })
    await fixture.runner.run(fixture.lease)
    const cancel = vi.fn(async () => undefined)
    const start = vi.spyOn(fixture.backend, 'start')
    fixture.backend.cancel = cancel
    fixture.backend.events = async function* () { await new Promise<never>(() => undefined) }
    const errors: unknown[] = []
    const controller = new AbortController()
    const worker = evaluationWorker(fixture, 120, (error) => errors.push(error))
    const running = worker.start(controller.signal)
    try {
      await waitUntil(() => start.mock.calls.length > 0 || errors.length > 0)
      if (errors.length > 0) throw errors[0]
      await fixture.operatorClient.command({ schemaVersion: 1, type: 'run.cancel', commandId: 'cancel', idempotencyKey: 'cancel', submittedAt: new Date().toISOString(), runId: fixture.spec.runId, reason: 'operator request' })
      await waitUntil(() => cancel.mock.calls.length > 0)
    } finally {
      controller.abort(new Error('test complete'))
      await running
    }
    expect(fixture.controlPlane.projection.runs.get(fixture.spec.runId)?.state).toBe('cancelled')
    expect([...fixture.controlPlane.projection.trials.values()].every((trial) => trial.state === 'completed' || trial.state === 'cancelled')).toBe(true)
    expect(errors.length).toBeGreaterThan(0)
  })
})

function evaluationWorker(
  fixture: Awaited<ReturnType<typeof harness>>,
  leaseMs: number,
  onTrialError?: (error: unknown, trialId: string) => void,
): EvaluationWorker {
  return new EvaluationWorker({
    controlPlane: fixture.client, registry: fixture.registry, credentials: fixture.credentials,
    workerId: WORKER_ID, signingKeyReference: 'fixture-key', workerVersion: '1', cpu: 2, memoryMb: 4096, diskMb: 32768, gpu: 0, maxTrials: 1, leaseMs,
    artifactRoot: join(fixture.directory, 'worker-artifacts'), workerDataDir: join(fixture.directory, 'worker-process'),
    signingProvider,
    cancellationGraceMs: 10, onTrialError,
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000, diagnostic?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout' + (diagnostic ? ': ' + diagnostic() : ''))
    await delay(10)
  }
}

async function runWithDurableProgress(fixture: Awaited<ReturnType<typeof harness>>): Promise<void> {
  await fixture.runner.run(fixture.lease, undefined, {
    executionReceipt: async () => undefined,
    progress: async (state) => {
      await fixture.client.progressTrial({ schemaVersion: 1, leaseId: fixture.lease.leaseId, workerId: fixture.lease.workerId, trialId: fixture.lease.trialId, state, at: new Date().toISOString() })
    },
  })
}

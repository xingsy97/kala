import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { canonicalJson, serializeTrialTraceJsonl, sha256Hex, type EvaluationRunSpec, type TrialEvidence, type TrialLease, type TrialResultCommit } from '@agent-kernel/eval-protocol'

import { EvaluationControlPlane } from './control-plane.js'
import { RegisteredTaskCatalog } from './task-catalog.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const reproductionSigningKey = generateKeyPairSync('ed25519')
const reproductionKeyRegistry = { resolve: (keyReference: string) => keyReference === 'local-signing-key' ? { keyReference, algorithm: 'ed25519' as const, publicKeySpkiBase64: createPublicKey(reproductionSigningKey.privateKey).export({ format: 'der', type: 'spki' }).toString('base64'), scopes: ['artifact_manifest' as const, 'trial_result' as const, 'reproduction_bundle' as const], status: 'active' as const, validFrom: '2026-01-01T00:00:00.000Z' } : undefined }
function evidenceSignature(digest: string) { return { algorithm: 'ed25519' as const, keyReference: 'local-signing-key', valueBase64: sign(null, Buffer.from(digest, 'hex'), reproductionSigningKey.privateKey).toString('base64') } }
async function canonicalSpec(): Promise<EvaluationRunSpec> {
  return JSON.parse(await readFile(join(packageRoot, '..', 'eval-protocol', 'fixtures', 'canonical-run-spec-v1.json'), 'utf8')) as EvaluationRunSpec
}

function clock(initial = '2026-08-03T00:00:00.000Z') {
  let current = new Date(initial)
  return {
    now: () => new Date(current),
    advance(ms: number) { current = new Date(current.getTime() + ms) },
  }
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'eval-orchestrator-'))
  const journalPath = join(directory, 'control-plane.jsonl')
  const catalog = new RegisteredTaskCatalog()
  const spec = await canonicalSpec()
  catalog.register(spec.taskPack.evaluatedSlice.sliceManifestHash, ['task-one', 'task-two'])
  const time = clock()
  let identifier = 0
  const options = {
    journalPath,
    reportRoot: join(directory, 'artifacts'),
    taskCatalog: catalog,
    now: time.now,
    randomId: () => 'id-' + String(identifier++),
    commitToken: () => 'token-' + 'x'.repeat(64),
    signingKeyRegistry: reproductionKeyRegistry,
  }
  const controlPlane = new EvaluationControlPlane(options)
  await controlPlane.initialize()
  return { controlPlane, options, spec, time, journalPath }
}

function createCommand(spec: EvaluationRunSpec, suffix = '') {
  return { schemaVersion: 1 as const, commandId: 'command-create' + suffix, idempotencyKey: 'idem-create' + suffix, submittedAt: '2026-08-03T00:00:00.000Z', type: 'run.create' as const, spec }
}

function startCommand(runId: string, suffix = '') {
  return { schemaVersion: 1 as const, commandId: 'command-start' + suffix, idempotencyKey: 'idem-start' + suffix, submittedAt: '2026-08-03T00:00:01.000Z', type: 'run.start' as const, runId }
}

function worker() {
  return { schemaVersion: 1 as const, workerId: 'worker-one', signingKeyReference: 'local-signing-key', workerVersion: '1.0.0', protocolVersions: [1], sandboxProviders: ['docker'], agentBackends: ['agent-runlab'], benchmarkAdapters: ['swe-bench'], capacity: { cpu: 8, memoryMb: 16384, diskMb: 65536, gpu: 0, maxTrials: 2 } }
}

async function evidenceFor(controlPlane: EvaluationControlPlane, spec: EvaluationRunSpec, lease: TrialLease, overrides: Partial<TrialEvidence> = {}): Promise<TrialEvidence> {
  const trial = controlPlane.projection.trials.get(lease.trialId)!
  const prefix = spec.runId + '/' + lease.trialId
  const bodies = new Map([
    ['native-events.jsonl', Buffer.from('native\n')], ['normalized-events.jsonl', Buffer.from('events\n')],
    ['analyzer-input.json', Buffer.from('input{}')], ['final.diff', Buffer.from('diff---')],
    ['stdout.log', Buffer.from('stdout!')], ['stderr.log', Buffer.from('stderr!')],
  ])
  const entry = (name: string, mediaType: string) => { const body = bodies.get(name)!; return { artifactId: name, path: prefix + '/' + name, mediaType, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), redaction: 'passed' as const, classification: 'operator' as const } }
  const unsignedManifest = {
    schemaVersion: 1 as const,
    runId: spec.runId,
    trialId: lease.trialId,
    leaseId: lease.leaseId,
    generatedAt: '2026-08-03T00:00:09.000Z',
    entries: [
      entry('native-events.jsonl', 'application/x-ndjson'), entry('normalized-events.jsonl', 'application/x-ndjson'), entry('analyzer-input.json', 'application/json'),
      entry('final.diff', 'text/x-diff'), entry('stdout.log', 'text/plain'), entry('stderr.log', 'text/plain'),
    ],
  }
  const manifestHash = await sha256Hex(canonicalJson(unsignedManifest))
  const artifactManifest = { ...unsignedManifest, manifestHash, signature: evidenceSignature(manifestHash) }
  const unsignedEvidence = {
    schemaVersion: 1 as const,
    runId: spec.runId,
    trialId: lease.trialId,
    agentVariantId: trial.agentVariantId,
    taskId: trial.taskId,
    repeatIndex: trial.repeatIndex,
    environmentLock: {
      schemaVersion: 1 as const,
      provider: spec.sandbox.provider,
      imageDigest: spec.sandbox.imageDigest,
      repositoryRevision: 'fixture-revision',
      dependencyLockHashes: {},
      redactedEnvironment: {},
      resourcePolicyHash: '1'.repeat(64),
      networkPolicyHash: '2'.repeat(64),
      toolchainVersions: {},
      fixtureVersions: {},
      faultInjectorVersions: {},
    },
    nativeEventsRef: prefix + '/native-events.jsonl',
    normalizedEventsRef: prefix + '/normalized-events.jsonl',
    normalizedEventCount: 1,
    analyzerInputRef: prefix + '/analyzer-input.json',
    finalDiffRef: prefix + '/final.diff',
    stdoutRef: prefix + '/stdout.log',
    stderrRef: prefix + '/stderr.log',
    usage: { availability: 'unavailable' as const, reason: 'test fixture' },
    benchmarkResult: {
      schemaVersion: 1 as const,
      benchmarkId: 'swe-bench' as const,
      verifierId: spec.verification.verifierId,
      verifierVersion: spec.verification.verifierVersion,
      nativeMetrics: { resolved: true },
      rawResultRef: prefix + '/final.diff',
      officialEvidence: true,
    },
    artifactManifest,
    evidenceLevel: 'official' as const,
    ...overrides,
  }
  const { resultHash: _ignored, ...hashable } = unsignedEvidence as typeof unsignedEvidence & { resultHash?: string }
  if (controlPlane.projection.leases.get(lease.leaseId)?.state === 'active') for (const artifact of unsignedManifest.entries) await controlPlane.stageTrialArtifact({ leaseId: lease.leaseId, commitToken: lease.commitToken, path: artifact.path, mediaType: artifact.mediaType, bytes: artifact.bytes, sha256: artifact.sha256 }, bodies.get(artifact.artifactId)!)
  const resultHash = await sha256Hex(canonicalJson(hashable))
  return { ...hashable, resultHash, signature: evidenceSignature(resultHash) }
}

async function completedCommit(controlPlane: EvaluationControlPlane, spec: EvaluationRunSpec, lease: TrialLease, overrides: Partial<TrialEvidence> = {}): Promise<TrialResultCommit> {
  const evidence = await evidenceFor(controlPlane, spec, lease, overrides)
  return {
    schemaVersion: 1,
    leaseId: lease.leaseId,
    trialId: lease.trialId,
    attempt: lease.attempt,
    commitToken: lease.commitToken,
    resultHash: evidence.resultHash,
    artifactManifestHash: evidence.artifactManifest.manifestHash,
    evidence,
    terminalState: 'completed',
    committedAt: '2026-08-03T00:00:10.000Z',
  }
}

function failedCommit(lease: TrialLease, input: {
  terminalState?: 'agent_error' | 'environment_error' | 'verifier_error' | 'timeout' | 'indeterminate'
  category?: 'agent_failure' | 'environment_failure' | 'provider_failure' | 'verifier_failure' | 'timeout' | 'indeterminate_side_effect'
  responsibility?: 'agent' | 'environment' | 'provider' | 'verifier' | 'platform' | 'indeterminate'
  retryable?: boolean
  observedStateSufficientForRecovery?: boolean
} = {}): TrialResultCommit {
  const terminalState = input.terminalState ?? 'agent_error'
  const category = input.category ?? 'provider_failure'
  const responsibility = input.responsibility ?? 'provider'
  return {
    schemaVersion: 1, leaseId: lease.leaseId, trialId: lease.trialId, attempt: lease.attempt, commitToken: lease.commitToken,
    resultHash: '8'.repeat(64), artifactManifestHash: '9'.repeat(64), terminalState, committedAt: '2026-08-03T00:00:00.500Z',
    failure: { schemaVersion: 1, category, responsibility, code: 'FIXTURE_FAILURE', summary: 'fixture failure', retryable: input.retryable ?? true, observedStateSufficientForRecovery: input.observedStateSufficientForRecovery ?? true, evidenceRefs: ['trial:' + lease.trialId + '/failure.json'] },
  }
}

async function rehashEvidence(evidence: TrialEvidence, mutate: (draft: TrialEvidence) => void): Promise<TrialEvidence> {
  const draft = structuredClone(evidence)
  mutate(draft)
  const { manifestHash: _manifestHash, signature: _signature, ...unsignedManifest } = draft.artifactManifest
  draft.artifactManifest.manifestHash = await sha256Hex(canonicalJson(unsignedManifest))
  draft.artifactManifest.signature = evidenceSignature(draft.artifactManifest.manifestHash)
  const { resultHash: _ignored, signature: _oldEvidenceSignature, ...unsigned } = draft
  const resultHash = await sha256Hex(canonicalJson(unsigned))
  return { ...unsigned, resultHash, signature: evidenceSignature(resultHash) }
}

function oneTrialSpec(spec: EvaluationRunSpec, runId = spec.runId, sliceManifestHash = '6'.repeat(64)): EvaluationRunSpec {
  const oneTaskHash = '7947b7f9df4791beb403b1edc18f00e5b568c486bd1992a47837fd35134d30fb'
  return {
    ...spec,
    runId,
    taskPack: { ...spec.taskPack, evaluatedSlice: { ...spec.taskPack.evaluatedSlice, sliceId: 'one-task-' + runId, sliceManifestHash, selectionKind: 'explicit_ids', selectionSpec: { kind: 'explicit_ids', taskIdsHash: oneTaskHash }, selectedItems: 1, coverageRatio: 1 / spec.taskPack.evaluatedSlice.dataset.totalItems } },
    execution: { ...spec.execution, repeats: 1 },
    analysis: { ...spec.analysis, repeatsRequired: 1 },
  }
}

async function signedReproduction(root: string, bundleId: string, findingId: string, environmentLockHash: string, runId: string, trialId: string) {
  const prefix = 'bundles/' + bundleId + '/'
  const names = ['defect.json', 'task.json', 'environment.lock.json', 'agent-config.json', 'tool-registry.json', 'minimal-workspace.tar.zst', 'replay.jsonl', 'trace.jsonl', 'final.diff', 'verifier-result.json', 'analysis.json', 'expected.json', 'reproduce.sh']
  const contents = new Map(names.map((name) => [prefix + name, Buffer.from(name === 'reproduce.sh' ? '#!/bin/sh\nexit 0\n' : name + '\n')]))
  const at = '2026-08-03T00:00:12.000Z'; const traceId = 'trace-' + trialId; const refs = { runId, trialId, backendId: 'agent-runlab', taskId: 'task-one' }
  const span = (spanId: string, parentSpanId: string | undefined, name: 'evaluation.run' | 'evaluation.trial' | 'environment.prepare' | 'agent.execute' | 'workspace.snapshot' | 'verifier.execute' | 'analyzer.detect' | 'reproduction.verify', outcomeCategory?: string) => ({ schemaVersion: 1 as const, traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, startedAt: at, completedAt: at, status: 'ok' as const, refs, artifactRefs: [], ...(outcomeCategory ? { outcomeCategory } : {}) })
  contents.set(prefix + 'trace.jsonl', Buffer.from(serializeTrialTraceJsonl({ schemaVersion: 1, traceId, runId, trialId, spans: [span('run', undefined, 'evaluation.run'), span('trial', 'run', 'evaluation.trial'), span('environment', 'trial', 'environment.prepare'), span('agent', 'trial', 'agent.execute'), span('workspace', 'trial', 'workspace.snapshot'), span('verifier', 'trial', 'verifier.execute'), span('analyzer', 'trial', 'analyzer.detect', 'finding_detected'), span('reproduction-1', 'trial', 'reproduction.verify', 'failure_reproduced'), span('reproduction-2', 'trial', 'reproduction.verify', 'failure_reproduced'), span('reproduction-3', 'trial', 'reproduction.verify', 'failure_reproduced'), span('reproduction-control', 'trial', 'reproduction.verify', 'expected_success_control_passed')] })))
  const checksumBody = [...contents].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => createHash('sha256').update(content).digest('hex') + '  ' + path.slice(prefix.length)).join('\n') + '\n'
  contents.set(prefix + 'SHA256SUMS', Buffer.from(checksumBody))
  const files = [...contents].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({ path, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength, mediaType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream' }))
  for (const [path, content] of contents) { const destination = join(root, path); await mkdir(join(destination, '..'), { recursive: true }); await writeFile(destination, content) }
  const failureFingerprint = '3'.repeat(64)
  const freshEvidence = (id: string, nonce: string) => ({ freshEnvironmentId: id, providerAttestation: 'fixture-attestation-' + id, imageDigest: 'sha256:fixture', nonce, initialStateHash: '4'.repeat(64), networkPolicyHash: '5'.repeat(64), cleanupReceipt: 'fixture-cleanup-' + id })
  const attempts = [0, 1, 2].map((index) => ({ attemptId: 'attempt-' + String(index), ...freshEvidence('fresh-' + String(index), 'nonce-' + String(index)), environmentLockHash, observedFailureFingerprint: failureFingerprint, reproduced: true, evidenceRefs: ['attempt-evidence-' + String(index)] }))
  const unsigned = { schemaVersion: 1 as const, bundleId, findingId, failureFingerprint, environmentLockHash, files, reproduction: { attempts, reproduced: attempts.length, expectedSuccessControl: { ...freshEvidence('fresh-control', 'nonce-control'), environmentLockHash, passed: true as const, evidenceRefs: ['control-evidence'] }, minimization: { originalUnits: 4, minimizedUnits: 1, attempts: 5, repetitions: 3, requiredPreservations: 3, oneMinimalVerified: true as const } }, privacy: { redactionPassed: true as const, secretScanPassed: true as const, absolutePathScanPassed: true as const } }
  const signedPayloadHash = createHash('sha256').update(canonicalJson(unsigned)).digest('hex')
  return { ...unsigned, signedPayloadHash, signature: { algorithm: 'ed25519' as const, keyReference: 'local-signing-key', valueBase64: sign(null, Buffer.from(signedPayloadHash, 'hex'), reproductionSigningKey.privateKey).toString('base64') } }
}

describe('EvaluationControlPlane durable authority', () => {
  it('atomically commits idempotent commands and rebuilds the same projection after restart', async () => {
    const { controlPlane, options, spec } = await harness()
    const first = await controlPlane.executeCommand(createCommand(spec))
    const duplicate = await controlPlane.executeCommand({ ...createCommand(spec), commandId: 'retry-command', submittedAt: '2026-08-03T00:00:01.000Z' })
    expect(duplicate).toEqual(first)
    expect(controlPlane.projection.runs).toHaveLength(1)
    expect(controlPlane.projection.transactionCount).toBe(2)

    await controlPlane.executeCommand(startCommand(spec.runId))
    expect(controlPlane.projection.trials).toHaveLength(6)
    expect(controlPlane.projection.runs.get(spec.runId)?.state).toBe('running')

    const restarted = new EvaluationControlPlane(options)
    await restarted.initialize()
    expect(restarted.projection.transactionCount).toBe(controlPlane.projection.transactionCount)
    expect([...restarted.projection.runs.keys()]).toEqual([...controlPlane.projection.runs.keys()])
    expect([...restarted.projection.trials.keys()]).toEqual([...controlPlane.projection.trials.keys()])
    expect(await restarted.executeCommand(startCommand(spec.runId))).toEqual(await controlPlane.executeCommand(startCommand(spec.runId)))
  })

  it('rejects one idempotency key reused for a different payload', async () => {
    const { controlPlane, spec } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await expect(controlPlane.executeCommand({ ...createCommand(spec), spec: { ...spec, runId: 'different-run' } })).rejects.toThrow('idempotency key collision')
  })

  it('leases only compatible trials and makes result completion idempotent by hash', async () => {
    const { controlPlane, spec } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await controlPlane.executeCommand(startCommand(spec.runId))
    await controlPlane.registerWorker(worker())
    const lease = await controlPlane.issueLease('worker-one', 60_000)
    expect(lease).not.toBeNull()
    const commit = await completedCommit(controlPlane, spec, lease!)
    expect(await controlPlane.commitTrialResult(commit)).toEqual(commit)
    expect(await controlPlane.commitTrialResult(commit)).toEqual(commit)
    const conflictingEvidence = await evidenceFor(controlPlane, spec, lease!, { stdoutRef: spec.runId + '/' + lease!.trialId + '/other-stdout.log' })
    await expect(controlPlane.commitTrialResult({ ...commit, resultHash: conflictingEvidence.resultHash, evidence: conflictingEvidence })).rejects.toThrow('conflicting duplicate completion')
    expect(controlPlane.projection.resultCommits).toHaveLength(1)
    expect(controlPlane.projection.leases.get(lease!.leaseId)?.state).toBe('closed')
  })

  it('does not lease a matching capability when exact sandbox or Agent readiness failed', async () => {
    const { controlPlane, spec } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await controlPlane.executeCommand(startCommand(spec.runId))
    const readiness = {
      checkedAt: '2026-08-03T00:00:00.000Z',
      sandboxes: [{ provider: spec.sandbox.provider, imageDigest: spec.sandbox.imageDigest, networkMode: spec.sandbox.network.mode, allowedDestinations: [...spec.sandbox.network.allowedDestinations], ok: true, errors: [], warnings: [] }],
      agents: spec.agents.map((agent) => ({ backendId: agent.backendId, configHash: agent.configHash, credentialReferenceIds: agent.credentialRefs.map((reference) => reference.referenceId), ok: false, errors: [{ component: 'credentials' as const, code: 'CREDENTIAL_REFERENCE_UNAVAILABLE', message: 'credential reference is unavailable' }], warnings: [] })),
    }
    await controlPlane.registerWorker({ ...worker(), readiness })
    await expect(controlPlane.issueLease('worker-one', 60_000)).resolves.toBeNull()
  })

  it('rejects canonical evidence whose hash, authority, immutable spec identity, or official level is false', async () => {
    const cases: Array<{ name: string; mutate: (evidence: TrialEvidence) => void; expected: string; rehash?: boolean }> = [
      { name: 'result hash', mutate: (evidence) => { evidence.stdoutRef = evidence.stdoutRef.replace('stdout.log', 'stderr.log') }, expected: 'trial evidence hash mismatch' },
      { name: 'run identity', mutate: (evidence) => { evidence.runId = 'wrong-run' }, expected: 'leased trial identity', rehash: true },
      { name: 'task identity', mutate: (evidence) => { evidence.taskId = 'wrong-task' }, expected: 'leased trial identity', rehash: true },
      { name: 'agent identity', mutate: (evidence) => { evidence.agentVariantId = 'wrong-agent' }, expected: 'leased trial identity', rehash: true },
      { name: 'repeat identity', mutate: (evidence) => { evidence.repeatIndex += 1 }, expected: 'leased trial identity', rehash: true },
      { name: 'manifest authority', mutate: (evidence) => { evidence.artifactManifest.leaseId = 'wrong-lease' }, expected: 'artifact manifest does not match', rehash: true },
      { name: 'sandbox provider', mutate: (evidence) => { evidence.environmentLock.provider = 'lxd-container' }, expected: 'sandbox provider', rehash: true },
      { name: 'image', mutate: (evidence) => { evidence.environmentLock.imageDigest = 'sha256:wrong' }, expected: 'environment image', rehash: true },
      { name: 'benchmark', mutate: (evidence) => { evidence.benchmarkResult.benchmarkId = 'terminal-bench' }, expected: 'benchmark', rehash: true },
      { name: 'verifier', mutate: (evidence) => { evidence.benchmarkResult.verifierId = 'wrong-verifier' }, expected: 'verifier does not match', rehash: true },
      { name: 'verifier version', mutate: (evidence) => { evidence.benchmarkResult.verifierVersion = 'wrong-version' }, expected: 'verifier version', rehash: true },
      { name: 'official evidence', mutate: (evidence) => { evidence.benchmarkResult.officialEvidence = false }, expected: 'official evidence requires official benchmark result ingest', rehash: true },
      { name: 'official level', mutate: (evidence) => { evidence.evidenceLevel = 'native' }, expected: 'official-required', rehash: true },
    ]
    for (const [index, testCase] of cases.entries()) {
      const { controlPlane, spec, options } = await harness()
      const run = oneTrialSpec(spec, 'evidence-case-' + String(index), String(index + 1).padStart(64, '0'))
      const catalog = options.taskCatalog as RegisteredTaskCatalog
      catalog.register(run.taskPack.evaluatedSlice.sliceManifestHash, ['task-one'])
      await controlPlane.executeCommand(createCommand(run, '-' + String(index)))
      await controlPlane.executeCommand(startCommand(run.runId, '-' + String(index)))
      await controlPlane.registerWorker(worker())
      const lease = (await controlPlane.issueLease('worker-one', 60_000))!
      const original = await evidenceFor(controlPlane, run, lease)
      const tampered = testCase.rehash ? await rehashEvidence(original, testCase.mutate) : structuredClone(original)
      if (!testCase.rehash) testCase.mutate(tampered)
      await expect(Promise.resolve().then(async () => await controlPlane.commitTrialResult({
        ...await completedCommit(controlPlane, run, lease), resultHash: tampered.resultHash,
        artifactManifestHash: tampered.artifactManifest.manifestHash, evidence: tampered,
      })), testCase.name).rejects.toThrow(testCase.expected)
    }
  }, 20_000)

  it('requires trusted evidence signatures bound to the leased Worker key', async () => {
    const { controlPlane, spec, options } = await harness()
    const run = oneTrialSpec(spec, 'worker-key-binding', 'e'.repeat(64))
    ;(options.taskCatalog as RegisteredTaskCatalog).register(run.taskPack.evaluatedSlice.sliceManifestHash, ['task-one'])
    await controlPlane.executeCommand(createCommand(run, '-worker-key'))
    await controlPlane.executeCommand(startCommand(run.runId, '-worker-key'))
    await controlPlane.registerWorker({ ...worker(), signingKeyReference: 'different-worker-key' })
    const lease = (await controlPlane.issueLease('worker-one', 60_000))!
    await expect(controlPlane.commitTrialResult(await completedCommit(controlPlane, run, lease))).rejects.toThrow('does not match leased Worker registration')
  })

  it('requeues expired work only before any execution receipt and classifies ambiguous work indeterminate', async () => {
    const { controlPlane, spec, time } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await controlPlane.executeCommand(startCommand(spec.runId))
    await controlPlane.registerWorker(worker())

    const safeLease = await controlPlane.issueLease('worker-one', 1_000)
    time.advance(1_001)
    expect(await controlPlane.expireLeases()).toBe(1)
    expect(controlPlane.projection.trials.get(safeLease!.trialId)?.state).toBe('queued')

    const ambiguousLease = await controlPlane.issueLease('worker-one', 1_000)
    await controlPlane.heartbeatLease({ schemaVersion: 1, leaseId: ambiguousLease!.leaseId, workerId: 'worker-one', at: time.now().toISOString(), lastEventSequence: 0 }, 'indeterminate')
    time.advance(1_001)
    expect(await controlPlane.expireLeases()).toBe(1)
    expect(controlPlane.projection.trials.get(ambiguousLease!.trialId)?.state).toBe('indeterminate')
    expect(controlPlane.projection.trials.get(ambiguousLease!.trialId)?.activeLeaseId).toBeUndefined()
    expect(controlPlane.projection.runs.get(spec.runId)?.events.at(-1)).toMatchObject({
      type: 'trial.state',
      data: { state: 'indeterminate' },
      failure: { category: 'indeterminate_side_effect', responsibility: 'indeterminate', retryable: false, observedStateSufficientForRecovery: false },
    })
  })

  it('renews a live lease from the Control Plane clock and expires it only after the renewed deadline', async () => {
    const { controlPlane, spec, time } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await controlPlane.executeCommand(startCommand(spec.runId))
    await controlPlane.registerWorker(worker())
    const lease = await controlPlane.issueLease('worker-one', 1_000)
    time.advance(750)
    const heartbeat = await controlPlane.heartbeatLease({ schemaVersion: 1, leaseId: lease!.leaseId, workerId: 'worker-one', at: '2099-01-01T00:00:00.000Z', lastEventSequence: 0 }, 'known')
    expect(heartbeat.at).toBe(time.now().toISOString())
    expect(controlPlane.projection.leases.get(lease!.leaseId)?.expiresAt).toBe(new Date(time.now().getTime() + 1_000).toISOString())
    time.advance(251)
    expect(await controlPlane.expireLeases()).toBe(0)
    time.advance(750)
    expect(await controlPlane.expireLeases()).toBe(1)
    expect(controlPlane.projection.trials.get(lease!.trialId)?.state).toBe('indeterminate')
  })

  it('durably accepts only ordered progress transitions from the Worker holding the lease', async () => {
    const { controlPlane, spec, options } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await controlPlane.executeCommand(startCommand(spec.runId))
    await controlPlane.registerWorker(worker())
    const lease = await controlPlane.issueLease('worker-one', 10_000)
    await expect(controlPlane.progressTrial({ schemaVersion: 1, leaseId: lease!.leaseId, workerId: 'other-worker', trialId: lease!.trialId, state: 'environment_preparing', at: lease!.issuedAt })).rejects.toThrow('worker mismatch')
    await expect(controlPlane.progressTrial({ schemaVersion: 1, leaseId: lease!.leaseId, workerId: 'worker-one', trialId: lease!.trialId, state: 'agent_running', at: lease!.issuedAt })).rejects.toThrow('invalid trial state transition')
    for (const state of ['environment_preparing', 'agent_running', 'artifacts_collecting', 'verifying', 'analyzing'] as const) {
      const event = await controlPlane.progressTrial({ schemaVersion: 1, leaseId: lease!.leaseId, workerId: 'worker-one', trialId: lease!.trialId, state, at: lease!.issuedAt })
      expect(event).toMatchObject({ producer: 'worker', leaseId: lease!.leaseId, data: { state } })
    }
    expect(controlPlane.projection.trials.get(lease!.trialId)?.state).toBe('analyzing')
    const restarted = new EvaluationControlPlane(options)
    await restarted.initialize()
    expect(restarted.projection.trials.get(lease!.trialId)?.state).toBe('analyzing')
  })

  it('ignores a torn trailing transaction rather than projecting uncommitted state', async () => {
    const { controlPlane, options, spec, journalPath } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await appendFile(journalPath, '{"schemaVersion":1,"transactionSequence":1')
    const restarted = new EvaluationControlPlane(options)
    await restarted.initialize()
    expect(restarted.projection.runs).toHaveLength(1)
    expect(restarted.projection.transactionCount).toBe(2)
    const secondRestart = new EvaluationControlPlane(options)
    await secondRestart.initialize()
    expect(secondRestart.projection.transactionCount).toBe(2)
  })

  it('fences stale standalone writers after another instance commits', async () => {
    const { controlPlane, options, spec } = await harness()
    const stale = new EvaluationControlPlane(options); await stale.initialize()
    await controlPlane.executeCommand(createCommand(spec))
    await expect(stale.registerWorker(worker())).rejects.toThrow('fenced by a newer transaction')
  })

  it('rejects artifact staging and result commits after the trial deadline', async () => {
    const { controlPlane, spec, time } = await harness()
    await controlPlane.executeCommand(createCommand(spec)); await controlPlane.executeCommand(startCommand(spec.runId)); await controlPlane.registerWorker(worker())
    const lease = (await controlPlane.issueLease('worker-one', 100))!
    time.advance(101)
    const body = Buffer.from('late')
    await expect(controlPlane.stageTrialArtifact({ leaseId: lease.leaseId, commitToken: lease.commitToken, path: lease.runId + '/' + lease.trialId + '/late', mediaType: 'text/plain', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }, body)).rejects.toThrow('lease has expired')
    await expect(controlPlane.commitTrialResult(failedCommit(lease))).rejects.toThrow('lease has expired')
  })

  it('rejects non-trailing journal tampering through the durable transaction hash chain', async () => {
    const { controlPlane, spec, options, journalPath } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    const lines = (await readFile(journalPath, 'utf8')).trimEnd().split('\n')
    const transaction = JSON.parse(lines[0]!) as { transactionId: string }
    transaction.transactionId = transaction.transactionId + '-tampered'
    await writeFile(journalPath, [JSON.stringify(transaction), ...lines.slice(1)].join('\n') + '\n')
    const restarted = new EvaluationControlPlane(options)
    await expect(restarted.initialize()).rejects.toThrow('journal transaction hash mismatch')
  })

  it('advertises clean standalone capabilities without compatibility surfaces', async () => {
    const { controlPlane } = await harness()
    await expect(controlPlane.query({ resource: 'capabilities' })).resolves.toMatchObject({ standalone: true, cleanCutover: true, deprecatedCompatibilitySurfaces: [] })
  })

  it('serves real catalog resources and cursor pagination from accepted immutable specs', async () => {
    const { controlPlane, spec } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    for (const catalog of ['datasets', 'task-packs', 'agents', 'sandboxes', 'verifiers', 'detectors'] as const) {
      await expect(controlPlane.query({ resource: 'catalog', catalog, page: { limit: 50 } })).resolves.toMatchObject({ items: expect.any(Array), page: { hasMore: false, total: expect.any(Number) } })
    }
    const first = await controlPlane.query({ resource: 'catalog', catalog: 'detectors', page: { limit: 1 } }) as { items: string[]; page: { nextCursor?: string; hasMore: boolean; total: number } }
    expect(first).toMatchObject({ items: ['instruction-drift'], page: { nextCursor: '1', hasMore: true, total: 2 } })
    await expect(controlPlane.query({ resource: 'catalog', catalog: 'detectors', page: { cursor: first.page.nextCursor, limit: 1 } })).resolves.toMatchObject({ items: ['tool-recovery'], page: { hasMore: false, total: 2 } })
    await expect(controlPlane.query({ resource: 'catalog', catalog: 'detectors', page: { cursor: 'not-a-cursor', limit: 1 } })).rejects.toThrow('invalid page cursor')
    await expect(controlPlane.query({ resource: 'catalog', catalog: 'datasets', search: 'swe-bench verified', page: { limit: 10 } })).resolves.toMatchObject({ items: [{ displayName: 'SWE-Bench Verified' }], page: { total: 1 } })
    await expect(controlPlane.query({ resource: 'catalog', catalog: 'datasets', search: 'not-present', page: { limit: 10 } })).resolves.toMatchObject({ items: [], page: { total: 0 } })
  })

  it('serves run, trial, and artifact query contracts with cursor pagination and filters', async () => {
    const { controlPlane, spec } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await controlPlane.executeCommand(startCommand(spec.runId))

    await expect(controlPlane.query({ resource: 'runs', state: 'running', page: { limit: 1 } })).resolves.toMatchObject({
      items: [{ accepted: { spec: { runId: spec.runId } }, state: 'running' }],
      page: { hasMore: false, total: 1 },
    })
    await expect(controlPlane.query({ resource: 'runs', state: 'completed', page: { limit: 1 } })).resolves.toMatchObject({ items: [], page: { hasMore: false, total: 0 } })
    await expect(controlPlane.query({ resource: 'runs', search: spec.runId, page: { limit: 1 } })).resolves.toMatchObject({ items: [{ accepted: { spec: { runId: spec.runId } } }], page: { total: 1 } })
    await expect(controlPlane.query({ resource: 'runs', page: { limit: 0 } })).rejects.toThrow()

    const firstTrials = await controlPlane.query({ resource: 'trials', runId: spec.runId, state: 'queued', page: { limit: 2 } }) as { items: Array<{ trialId: string; state: string }>; page: { nextCursor?: string; hasMore: boolean; total: number } }
    expect(firstTrials).toMatchObject({ items: [{ state: 'queued' }, { state: 'queued' }], page: { nextCursor: '2', hasMore: true, total: 6 } })
    await expect(controlPlane.query({ resource: 'trials', runId: spec.runId, state: 'queued', page: { cursor: firstTrials.page.nextCursor, limit: 2 } })).resolves.toMatchObject({ items: [{ state: 'queued' }, { state: 'queued' }], page: { nextCursor: '4', hasMore: true, total: 6 } })

    await controlPlane.registerWorker(worker())
    const lease = (await controlPlane.issueLease('worker-one', 60_000))!
    await expect(controlPlane.query({ resource: 'trials', runId: spec.runId, state: 'leased', page: { limit: 10 } })).resolves.toMatchObject({ items: [{ trialId: lease.trialId, state: 'leased' }], page: { hasMore: false, total: 1 } })
    await expect(controlPlane.query({ resource: 'trials', runId: spec.runId, agentVariantId: spec.agents[0]!.variantId, taskId: 'task-one', page: { limit: 10 } })).resolves.toMatchObject({ items: expect.any(Array), page: { total: 3 } })
    await controlPlane.commitTrialResult(await completedCommit(controlPlane, spec, lease))

    const firstArtifacts = await controlPlane.query({ resource: 'artifacts', runId: spec.runId, trialId: lease.trialId, page: { limit: 2 } }) as { items: Array<{ artifactId: string }>; page: { nextCursor?: string; hasMore: boolean; total: number } }
    expect(firstArtifacts).toMatchObject({ items: [{ artifactId: 'native-events.jsonl' }, { artifactId: 'normalized-events.jsonl' }], page: { nextCursor: '2', hasMore: true, total: 6 } })
    await expect(controlPlane.query({ resource: 'artifacts', runId: spec.runId, trialId: lease.trialId, page: { cursor: firstArtifacts.page.nextCursor, limit: 4 } })).resolves.toMatchObject({ items: expect.any(Array), page: { hasMore: false, total: 6 } })
    await expect(controlPlane.query({ resource: 'artifacts', runId: spec.runId, trialId: lease.trialId, mediaType: 'application/json', page: { limit: 10 } })).resolves.toMatchObject({ items: expect.any(Array), page: { total: 1 } })
  })

  it('restores the task and evaluated-slice catalog from the sole durable journal without startup catalog input', async () => {
    const { controlPlane, spec, options } = await harness()
    const catalog = options.taskCatalog as RegisteredTaskCatalog
    const task = { schemaVersion: 1 as const, taskId: 'task-one', taskPackId: 'swe-bench' as const, taskPackVersion: '1', title: 'Durable task', prompt: 'Fix it', repository: { kind: 'artifact' as const, archiveRef: 'tasks/task-one.tar', archiveSha256: 'a'.repeat(64), revision: 'revision-one' }, fixtureManifestHash: 'b'.repeat(64), faultScenarioIds: [], verification: [{ stepId: 'test', argv: ['true'], cwd: '.', timeoutMs: 1000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: spec.taskPack.policy }
    catalog.register('7'.repeat(64), [task])
    const one = oneTrialSpec(spec, 'durable-catalog-run', '7'.repeat(64))
    await controlPlane.executeCommand(createCommand(one, '-durable-catalog'))
    const restartedCatalog = new RegisteredTaskCatalog()
    const restarted = new EvaluationControlPlane({ ...options, taskCatalog: restartedCatalog })
    await restarted.initialize()
    expect(await restartedCatalog.task('task-one')).toMatchObject({ title: 'Durable task' })
    expect(await restartedCatalog.taskIdsForSlice(one.taskPack.evaluatedSlice)).toEqual(['task-one'])
    await expect(restarted.executeCommand(startCommand(one.runId, '-durable-catalog'))).resolves.toMatchObject({ commandId: 'command-start-durable-catalog' })
  })

  it('persists authoritative analysis jobs, validates output manifests, and replays terminal job state', async () => {
    const { controlPlane, spec, options } = await harness()
    const run = oneTrialSpec(spec, 'analysis-job-run', 'a'.repeat(64))
    ;(options.taskCatalog as RegisteredTaskCatalog).register(run.taskPack.evaluatedSlice.sliceManifestHash, ['task-one'])
    await controlPlane.executeCommand(createCommand(run, '-analysis-job'))
    await controlPlane.executeCommand(startCommand(run.runId, '-analysis-job'))
    await controlPlane.registerWorker(worker())
    const lease = (await controlPlane.issueLease('worker-one', 10_000))!
    await controlPlane.commitTrialResult(await completedCommit(controlPlane, run, lease))

    const queue = { schemaVersion: 1 as const, type: 'run.analyze' as const, commandId: 'queue-analysis-job', idempotencyKey: 'queue-analysis-job', submittedAt: '2026-08-03T00:00:11.000Z', runId: run.runId, detectorIds: ['instruction-drift'] }
    await controlPlane.executeCommand(queue)
    const jobId = 'analysis-' + queue.commandId
    const queued = await controlPlane.query({ resource: 'analysis-job', jobId }) as { inputManifestHash: string; state: string }
    expect(queued).toMatchObject({ state: 'queued', runId: run.runId, kind: 'detectors', inputRefs: [expect.stringMatching(/^trial-result:/u)] })
    await expect(controlPlane.executeCommand({ ...queue, commandId: 'unknown-detector', idempotencyKey: 'unknown-detector', detectorIds: ['not-declared'] })).rejects.toThrow('not declared')

    await controlPlane.executeCommand({ schemaVersion: 1, type: 'analysis.job.start', commandId: 'start-analysis-job', idempotencyKey: 'start-analysis-job', submittedAt: '2026-08-03T00:00:12.000Z', jobId, executorId: 'analyzer-one', leaseMs: 10_000 })
    const running = await controlPlane.query({ resource: 'analysis-job', jobId }) as { generation: number; leaseToken: string }
    expect(running).toMatchObject({ generation: 1, leaseToken: expect.any(String) })
    await expect(controlPlane.executeCommand({ schemaVersion: 1, type: 'analysis.job.heartbeat', commandId: 'stale-analysis-heartbeat', idempotencyKey: 'stale-analysis-heartbeat', submittedAt: '2026-08-03T00:00:12.000Z', jobId, executorId: 'analyzer-one', leaseMs: 10_000, generation: 2, leaseToken: running.leaseToken })).rejects.toThrow('generation mismatch')
    const outputBody = Buffer.from(canonicalJson({ schemaVersion: 1, findingId: 'finding-one', detectorId: 'instruction-drift', detectorVersion: '1.0.0', runId: run.runId, trialId: lease.trialId, category: 'instruction_drift', severity: 'high', confidence: 1, evidenceRefs: ['normalized-events.jsonl#0'], status: 'detected' }))
    const outputHash = createHash('sha256').update(outputBody).digest('hex')
    await controlPlane.stageAnalysisArtifact({ jobId, executorId: 'analyzer-one', generation: running.generation, leaseToken: running.leaseToken, path: 'analysis/' + jobId + '/finding-one.json', mediaType: 'application/json', bytes: outputBody.byteLength, sha256: outputHash }, outputBody)
    const unsignedOutput = { schemaVersion: 1 as const, jobId, runId: run.runId, inputManifestHash: queued.inputManifestHash, generatedAt: '2026-08-03T00:00:13.000Z', outputs: [{ outputId: 'finding-one', kind: 'finding' as const, artifactRef: 'analysis/' + jobId + '/finding-one.json', mediaType: 'application/json', bytes: outputBody.byteLength, sha256: outputHash }] }
    const outputManifest = { ...unsignedOutput, manifestHash: await sha256Hex(canonicalJson(unsignedOutput)) }
    const complete = { schemaVersion: 1 as const, type: 'analysis.job.complete' as const, commandId: 'complete-analysis-job', idempotencyKey: 'complete-analysis-job', submittedAt: '2026-08-03T00:00:14.000Z', jobId, executorId: 'analyzer-one', generation: running.generation, leaseToken: running.leaseToken, outputManifest }
    await expect(controlPlane.executeCommand({ ...complete, commandId: 'wrong-executor', idempotencyKey: 'wrong-executor', executorId: 'analyzer-two' })).rejects.toThrow('executor mismatch')
    await expect(controlPlane.executeCommand({ ...complete, commandId: 'wrong-output-hash', idempotencyKey: 'wrong-output-hash', outputManifest: { ...outputManifest, manifestHash: 'c'.repeat(64) } })).rejects.toThrow('manifest hash mismatch')
    await controlPlane.executeCommand(complete)
    expect(await controlPlane.query({ resource: 'analysis-job', jobId })).toMatchObject({ state: 'completed', executorId: 'analyzer-one', outputManifestHash: outputManifest.manifestHash })
    expect(await controlPlane.query({ resource: 'analysis-output', jobId })).toEqual(outputManifest)

    const restarted = new EvaluationControlPlane(options)
    await restarted.initialize()
    expect(await restarted.query({ resource: 'analysis-job', jobId })).toMatchObject({ state: 'completed', outputManifestHash: outputManifest.manifestHash })
    expect(await restarted.query({ resource: 'analysis-jobs', runId: run.runId, state: 'completed', page: { limit: 10 } })).toMatchObject({ items: [{ jobId, state: 'completed' }], page: { total: 1 } })
  })

  it('schedules compatible runs fairly and respects retry backoff after a pre-execution expiry', async () => {
    const { controlPlane, spec, time } = await harness()
    const second = { ...spec, runId: 'second-run', createdAt: '2026-08-03T00:00:00.100Z' }
    await controlPlane.executeCommand(createCommand(spec))
    await controlPlane.executeCommand({ ...createCommand(second), commandId: 'create-second', idempotencyKey: 'idem-second' })
    await controlPlane.executeCommand(startCommand(spec.runId))
    await controlPlane.executeCommand({ ...startCommand(second.runId), commandId: 'start-second', idempotencyKey: 'idem-start-second' })
    await controlPlane.registerWorker(worker())
    const first = await controlPlane.issueLease('worker-one', 1_000)
    const secondLease = await controlPlane.issueLease('worker-one', 1_000)
    expect(first?.runId).toBe(spec.runId)
    expect(secondLease?.runId).toBe(second.runId)
    time.advance(1_001)
    await controlPlane.expireLeases()
    expect(controlPlane.projection.trials.get(first!.trialId)?.retryNotBefore).toBe(new Date(time.now().getTime() + 1_000).toISOString())

    const retrySpec = { ...spec, runId: 'retry-run', execution: { ...spec.execution, retryPolicy: { ...spec.execution.retryPolicy, retryableCategories: ['environment_failure'], backoffMs: 1_000 } } }
    await controlPlane.executeCommand({ ...createCommand(retrySpec), commandId: 'create-retry', idempotencyKey: 'idem-retry' })
    await controlPlane.executeCommand({ ...startCommand(retrySpec.runId), commandId: 'start-retry', idempotencyKey: 'idem-start-retry' })
    const retryLease = await controlPlane.issueLease('worker-one', 1_000)
    time.advance(1_001); await controlPlane.expireLeases()
    const retried = controlPlane.projection.trials.get(retryLease!.trialId)!
    expect(retried.state).toBe('queued')
    expect(retried.retryNotBefore).toBe(new Date(time.now().getTime() + 1_000).toISOString())
    const immediate = await controlPlane.issueLease('worker-one', 1_000)
    expect(immediate?.trialId).not.toBe(retryLease!.trialId)
  })

  it('honors priority, backend/provider limits, Worker resources, and the canonical lease ceiling', async () => {
    const { controlPlane, spec } = await harness()
    const low = { ...spec, runId: 'low-priority', execution: { ...spec.execution, priority: 0 } }
    const high = { ...spec, runId: 'high-priority', execution: { ...spec.execution, priority: 10, maxConcurrencyPerBackend: 1, maxConcurrencyPerProvider: 1, leaseMs: 500 } }
    await controlPlane.executeCommand({ ...createCommand(low), commandId: 'create-low', idempotencyKey: 'create-low' })
    await controlPlane.executeCommand({ ...createCommand(high), commandId: 'create-high', idempotencyKey: 'create-high' })
    await controlPlane.executeCommand({ ...startCommand(low.runId), commandId: 'start-low', idempotencyKey: 'start-low' })
    await controlPlane.executeCommand({ ...startCommand(high.runId), commandId: 'start-high', idempotencyKey: 'start-high' })
    await controlPlane.registerWorker(worker())
    const first = (await controlPlane.issueLease('worker-one', 60_000))!
    expect(first.runId).toBe(high.runId)
    expect(Date.parse(first.expiresAt) - Date.parse(first.issuedAt)).toBe(500)
    const second = (await controlPlane.issueLease('worker-one', 60_000))!
    expect(second.runId).toBe(low.runId)

    const constrained = { ...worker(), workerId: 'worker-constrained', capacity: { cpu: 1, memoryMb: 1024, diskMb: 1024, gpu: 0, maxTrials: 4 } }
    await controlPlane.registerWorker(constrained)
    await expect(controlPlane.issueLease(constrained.workerId, 500)).resolves.toBeNull()
  })

  it('stops scheduling at token, cost, and wall-time budgets and durably blocks queued work', async () => {
    for (const [label, budget, usage, advanceMs] of [
      ['tokens', { maxTokens: 5 }, { inputTokens: 3, outputTokens: 2, costUsd: 0, wallMs: 1 }, 0],
      ['cost', { maxUsd: 0.25 }, { inputTokens: 0, outputTokens: 0, costUsd: 0.25, wallMs: 1 }, 0],
      ['wall', { maxWallMs: 100 }, { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 1 }, 101],
    ] as const) {
      const { controlPlane, spec, time } = await harness()
      const run = { ...spec, runId: 'budget-' + label, execution: { ...spec.execution, budget } }
      await controlPlane.executeCommand({ ...createCommand(run), commandId: 'create-' + label, idempotencyKey: 'create-' + label })
      await controlPlane.executeCommand({ ...startCommand(run.runId), commandId: 'start-' + label, idempotencyKey: 'start-' + label })
      await controlPlane.registerWorker(worker())
      const first = (await controlPlane.issueLease('worker-one', 10_000))!
      await controlPlane.commitTrialResult({ ...await completedCommit(controlPlane, run, first), resourceUsage: usage })
      time.advance(advanceMs)
      await expect(controlPlane.issueLease('worker-one', 10_000)).resolves.toBeNull()
      expect(controlPlane.projection.runs.get(run.runId)?.state).toBe('blocked')
      expect([...controlPlane.projection.trials.values()].filter((trial) => trial.runId === run.runId && trial.trialId !== first.trialId).every((trial) => trial.state === 'blocked')).toBe(true)
    }
  })

  it('automatically retries only declared, observed-safe failure categories and persists failed attempts', async () => {
    const { controlPlane, spec, time, options } = await harness()
    const run = oneTrialSpec({ ...spec, execution: { ...spec.execution, retryPolicy: { maxAttempts: 2, retryableCategories: ['provider_failure'], backoffMs: 1_000 } } })
    ;(options.taskCatalog as RegisteredTaskCatalog).register(run.taskPack.evaluatedSlice.sliceManifestHash, ['task-one'])
    await controlPlane.executeCommand(createCommand(run)); await controlPlane.executeCommand(startCommand(run.runId)); await controlPlane.registerWorker(worker())
    const lease = (await controlPlane.issueLease('worker-one', 10_000))!
    await controlPlane.progressTrial({ schemaVersion: 1, leaseId: lease.leaseId, workerId: lease.workerId, trialId: lease.trialId, state: 'environment_preparing', at: time.now().toISOString() })
    await controlPlane.progressTrial({ schemaVersion: 1, leaseId: lease.leaseId, workerId: lease.workerId, trialId: lease.trialId, state: 'agent_running', at: time.now().toISOString() })
    const failure = failedCommit(lease)
    expect(await controlPlane.commitTrialResult(failure)).toEqual(failure)
    expect(await controlPlane.commitTrialResult(failure)).toEqual(failure)
    expect(controlPlane.projection.failedAttempts.get(lease.trialId + '|1')).toEqual(failure)
    expect(controlPlane.projection.resultCommits.has(lease.trialId)).toBe(false)
    expect(controlPlane.projection.trials.get(lease.trialId)).toMatchObject({ state: 'queued', retryNotBefore: '2026-08-03T00:00:01.500Z' })
    await expect(controlPlane.issueLease('worker-one', 10_000)).resolves.toBeNull()
    time.advance(1_500)
    const retry = (await controlPlane.issueLease('worker-one', 10_000))!
    expect(retry).toMatchObject({ trialId: lease.trialId, attempt: 2 })
    const restarted = new EvaluationControlPlane(options); await restarted.initialize()
    expect(restarted.projection.failedAttempts.get(lease.trialId + '|1')).toEqual(failure)
  })

  it('classifies expired in-flight work during Control Plane restart and requires an explicit indeterminate retry confirmation', async () => {
    const { controlPlane, spec, time, options } = await harness()
    await controlPlane.executeCommand(createCommand(spec)); await controlPlane.executeCommand(startCommand(spec.runId)); await controlPlane.registerWorker(worker())
    const lease = (await controlPlane.issueLease('worker-one', 100))!
    await controlPlane.heartbeatLease({ schemaVersion: 1, leaseId: lease.leaseId, workerId: lease.workerId, at: time.now().toISOString(), lastEventSequence: 0 }, 'indeterminate')
    time.advance(101)
    const restarted = new EvaluationControlPlane(options); await restarted.initialize()
    expect(restarted.projection.trials.get(lease.trialId)?.state).toBe('indeterminate')
    expect(restarted.projection.leases.get(lease.leaseId)?.closeReason).toBe('expired_indeterminate')
    const retry = { schemaVersion: 1 as const, type: 'trial.retry' as const, commandId: 'retry-indeterminate', idempotencyKey: 'retry-indeterminate', submittedAt: time.now().toISOString(), runId: lease.runId, trialIds: [lease.trialId] }
    await expect(restarted.executeCommand(retry)).rejects.toThrow('exact selective-retry confirmation')
    await expect(restarted.executeCommand({ ...retry, indeterminateSideEffectConfirmation: 'retry-indeterminate:' + lease.trialId })).resolves.toMatchObject({ commandId: retry.commandId })
  })

  it('aggregates result usage, auto-finalizes a run, and persists the projection across restart', async () => {
    const { controlPlane, spec, options } = await harness()
    const one = oneTrialSpec(spec)
    const catalog = options.taskCatalog as RegisteredTaskCatalog
    catalog.register(one.taskPack.evaluatedSlice.sliceManifestHash, ['task-one'])
    await controlPlane.executeCommand(createCommand(one)); await controlPlane.executeCommand(startCommand(one.runId)); await controlPlane.registerWorker(worker())
    const lease = await controlPlane.issueLease('worker-one', 10_000)
    await controlPlane.commitTrialResult({ ...await completedCommit(controlPlane, one, lease!), resourceUsage: { inputTokens: 3, outputTokens: 2, costUsd: 0.25, wallMs: 50 } })
    expect(controlPlane.projection.runs.get(one.runId)).toMatchObject({ state: 'completed', resourceUsage: { inputTokens: 3, outputTokens: 2, costUsd: 0.25, wallMs: 50 } })
    const restarted = new EvaluationControlPlane(options); await restarted.initialize()
    expect(restarted.projection.runs.get(one.runId)).toMatchObject({ state: 'completed', resourceUsage: { inputTokens: 3, outputTokens: 2, costUsd: 0.25, wallMs: 50 } })
  })

  it('publishes only complete eligible canonical evidence and replays one authoritative board for all pivots', async () => {
    const { controlPlane, spec, options } = await harness()
    const run = oneTrialSpec(spec)
    const catalog = options.taskCatalog as RegisteredTaskCatalog
    catalog.register(run.taskPack.evaluatedSlice.sliceManifestHash, ['task-one'])
    await controlPlane.executeCommand(createCommand(run))
    await controlPlane.executeCommand(startCommand(run.runId))
    await controlPlane.registerWorker(worker())
    await expect(controlPlane.executeCommand({ schemaVersion: 1, type: 'leaderboard.publish', commandId: 'publish-early', idempotencyKey: 'publish-early', submittedAt: '2026-08-03T00:00:05.000Z', runId: run.runId })).rejects.toThrow('only completed runs')
    const lease = (await controlPlane.issueLease('worker-one', 60_000))!
    await controlPlane.commitTrialResult(await completedCommit(controlPlane, run, lease))
    await controlPlane.executeCommand({ schemaVersion: 1, type: 'leaderboard.publish', commandId: 'publish', idempotencyKey: 'publish', submittedAt: '2026-08-03T00:00:11.000Z', runId: run.runId })
    const responses = await Promise.all((['model', 'agent_type', 'test_dataset'] as const).map(async (pivot) => await controlPlane.query({ resource: 'leaderboard', pivot, sliceManifestHash: run.taskPack.evaluatedSlice.sliceManifestHash, page: { limit: 50 } }))) as Array<{ items: Array<{ entryId: string; evidenceLevel: string; completedTrials: number; expectedTrials: number }>; rankingGroups: string[] }>
    expect(responses.map((response) => response.items.map((entry) => entry.entryId))).toEqual([responses[0]!.items.map((entry) => entry.entryId), responses[0]!.items.map((entry) => entry.entryId), responses[0]!.items.map((entry) => entry.entryId)])
    expect(responses[0]).toMatchObject({ items: [{ evidenceLevel: 'official', completedTrials: 1, expectedTrials: 1 }], rankingGroups: [expect.stringContaining(run.taskPack.evaluatedSlice.sliceManifestHash)] })
    const restarted = new EvaluationControlPlane(options)
    await restarted.initialize()
    expect([...restarted.projection.leaderboardEntries.values()]).toEqual([...controlPlane.projection.leaderboardEntries.values()])

    const otherSliceHash = '9'.repeat(64)
    const other = oneTrialSpec(spec, 'other-slice-run', otherSliceHash)
    catalog.register(otherSliceHash, ['task-one'])
    await controlPlane.executeCommand(createCommand(other, '-other'))
    await controlPlane.executeCommand(startCommand(other.runId, '-other'))
    const otherLease = (await controlPlane.issueLease('worker-one', 60_000))!
    await controlPlane.commitTrialResult(await completedCommit(controlPlane, other, otherLease))
    await controlPlane.executeCommand({ schemaVersion: 1, type: 'leaderboard.publish', commandId: 'publish-other', idempotencyKey: 'publish-other', submittedAt: '2026-08-03T00:00:12.000Z', runId: other.runId })
    const originalBoard = await controlPlane.query({ resource: 'leaderboard', pivot: 'model', sliceManifestHash: run.taskPack.evaluatedSlice.sliceManifestHash, page: { limit: 50 } }) as { items: Array<{ evaluatedSlice: { sliceManifestHash: string } }> }
    const otherBoard = await controlPlane.query({ resource: 'leaderboard', pivot: 'model', sliceManifestHash: otherSliceHash, page: { limit: 50 } }) as { items: Array<{ evaluatedSlice: { sliceManifestHash: string } }> }
    expect(originalBoard.items.map((entry) => entry.evaluatedSlice.sliceManifestHash)).toEqual([run.taskPack.evaluatedSlice.sliceManifestHash])
    expect(otherBoard.items.map((entry) => entry.evaluatedSlice.sliceManifestHash)).toEqual([otherSliceHash])

    const replacement = oneTrialSpec(spec, 'replacement-run')
    await controlPlane.executeCommand(createCommand(replacement, '-replacement'))
    await controlPlane.executeCommand(startCommand(replacement.runId, '-replacement'))
    const replacementLease = (await controlPlane.issueLease('worker-one', 60_000))!
    await controlPlane.commitTrialResult(await completedCommit(controlPlane, replacement, replacementLease))
    await controlPlane.executeCommand({ schemaVersion: 1, type: 'leaderboard.publish', commandId: 'publish-replacement', idempotencyKey: 'publish-replacement', submittedAt: '2026-08-03T00:00:13.000Z', runId: replacement.runId })
    const active = await controlPlane.query({ resource: 'leaderboard', pivot: 'model', sliceManifestHash: run.taskPack.evaluatedSlice.sliceManifestHash, view: 'active', modelId: replacement.agents[0]!.model.modelId, sortBy: 'published_at', sortDirection: 'desc', page: { limit: 50 } }) as { items: Array<{ entryId: string; status: string; runRefs: string[] }> }
    const audit = await controlPlane.query({ resource: 'leaderboard', pivot: 'model', sliceManifestHash: run.taskPack.evaluatedSlice.sliceManifestHash, view: 'audit', page: { limit: 50 } }) as { items: Array<{ entryId: string; status: string }> }
    expect(active.items).toEqual([expect.objectContaining({ status: 'active', runRefs: [replacement.runId] })])
    expect(audit.items).toEqual([expect.objectContaining({ status: 'superseded' })])
    await controlPlane.executeCommand({ schemaVersion: 1, type: 'leaderboard.invalidate', commandId: 'invalidate-replacement', idempotencyKey: 'invalidate-replacement', submittedAt: '2026-08-03T00:00:14.000Z', entryId: active.items[0]!.entryId, reason: 'fixture verifier defect' })
    const afterInvalidation = await controlPlane.query({ resource: 'leaderboard', pivot: 'model', sliceManifestHash: run.taskPack.evaluatedSlice.sliceManifestHash, view: 'audit', sortBy: 'published_at', sortDirection: 'asc', page: { limit: 50 } }) as { items: Array<{ status: string }> }
    expect(afterInvalidation.items.map((entry) => entry.status).sort()).toEqual(['invalidated', 'superseded'])
    expect((await controlPlane.query({ resource: 'leaderboard', pivot: 'model', sliceManifestHash: run.taskPack.evaluatedSlice.sliceManifestHash, view: 'active', page: { limit: 50 } }) as { items: unknown[] }).items).toEqual([])
  })

  it('leases only to Workers that advertise the run benchmark adapter', async () => {
    const { controlPlane, spec } = await harness()
    await controlPlane.executeCommand(createCommand(spec))
    await controlPlane.executeCommand(startCommand(spec.runId))
    await controlPlane.registerWorker({ ...worker(), benchmarkAdapters: ['custom-task-pack'] })
    await expect(controlPlane.issueLease('worker-one', 10_000)).resolves.toBeNull()
  })

  it('projects Worker session readiness and trusted filtered audit authority', async () => {
    const { controlPlane } = await harness()
    await controlPlane.registerWorker(worker())
    const workers = await controlPlane.query({ resource: 'workers', status: 'ready', page: { limit: 10 } }) as { items: Array<{ session: { status: string; activeLeaseCount: number } }> }
    expect(workers.items).toMatchObject([{ session: { status: 'ready', activeLeaseCount: 0 } }])
    const audit = await controlPlane.query({ resource: 'audit', operation: 'worker.registered', trustedOnly: true, page: { limit: 10 } }) as { trusted: boolean; authority: { tipHash: string | null }; items: Array<{ operation: string }> }
    expect(audit).toMatchObject({ trusted: true, items: [{ operation: 'worker.registered' }] })
    expect(audit.authority.tipHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects unknown run-admission policy and durably audits the decision', async () => {
    const { controlPlane, spec, options } = await harness()
    const denied = structuredClone(spec)
    denied.runId = 'policy-denied-run'
    denied.taskPack.policy.permissions.evaluation = { status: 'unknown' }
    await expect(controlPlane.executeCommand(createCommand(denied, '-policy-denied'))).rejects.toThrow('task_pack.permission.evaluation=unknown')
    expect(controlPlane.projection.runs.has(denied.runId)).toBe(false)
    expect(controlPlane.projection.auditRecords.at(-1)).toMatchObject({ operation: 'policy.decision', details: { allowed: false, operation: 'run_admission', denialCount: 1 } })
    const restarted = new EvaluationControlPlane(options)
    await restarted.initialize()
    expect(restarted.projection.auditRecords.at(-1)).toEqual(controlPlane.projection.auditRecords.at(-1))
  })

  it('durably controls defect promotion, reproduction, regression, reports, insights, and immutable audit', async () => {
    const { controlPlane, spec, options } = await harness()
    const run = oneTrialSpec(spec)
    ;(options.taskCatalog as RegisteredTaskCatalog).register(run.taskPack.evaluatedSlice.sliceManifestHash, ['task-one'])
    await controlPlane.executeCommand(createCommand(run))
    await controlPlane.executeCommand(startCommand(run.runId))
    await controlPlane.registerWorker(worker())
    const lease = (await controlPlane.issueLease('worker-one', 60_000))!
    const commit = await completedCommit(controlPlane, run, lease)
    await controlPlane.commitTrialResult({ ...commit, resourceUsage: { inputTokens: 13, outputTokens: 8, costUsd: 0.02, wallMs: 4321 } })
    const finding = {
      schemaVersion: 1 as const, findingId: 'finding-one', detectorId: 'instruction-drift', detectorVersion: '1.0.0', runId: run.runId, trialId: lease.trialId,
      category: 'instruction_drift' as const, severity: 'high' as const, confidence: 1, evidenceRefs: [commit.evidence!.normalizedEventsRef], status: 'human_validated' as const,
    }
    await controlPlane.executeCommand({ schemaVersion: 1, type: 'defect.record', commandId: 'record-defect', idempotencyKey: 'record-defect', submittedAt: '2026-08-03T00:00:12.000Z', finding })
    const environmentLockHash = await sha256Hex(canonicalJson(commit.evidence!.environmentLock))
    const reproduction = await signedReproduction(options.reportRoot, 'bundle-one', finding.findingId, environmentLockHash, finding.runId, finding.trialId)
    const pack = {
      schemaVersion: 1 as const, packId: 'pack-one', version: '1', taskPackRef: run.taskPack.id + '@' + run.taskPack.version,
      environmentLockHashes: [environmentLockHash], verifierSemanticsHash: run.verification.configHash, faultScenarioIds: [], severity: 'high' as const,
      owner: 'platform', allowedFlakeRate: 0, baselineEvidenceRefs: [commit.resultHash], promotionSourceFindingId: finding.findingId,
    }
    await controlPlane.executeCommand({ schemaVersion: 1, type: 'defect.promote', commandId: 'promote-defect', idempotencyKey: 'promote-defect', submittedAt: '2026-08-03T00:00:13.000Z', findingId: finding.findingId, pack, reproduction })
    await controlPlane.executeCommand({
      schemaVersion: 1, type: 'regression.evaluate', commandId: 'record-gate', idempotencyKey: 'record-gate', submittedAt: '2026-08-03T00:00:14.000Z', gateId: 'gate-one',
      baseline: { runId: run.runId, agentVariantId: run.agents[0]!.variantId }, candidate: { runId: run.runId, agentVariantId: run.agents[0]!.variantId },
      rules: { maxSuccessRateDropPp: 0, maxNewCriticalDefects: 0, maxTestGamingRate: 0, maxP95CostIncreasePct: 0, allowedFlakeRate: 0, confidenceLevel: 0.95 },
    })
    const decision = controlPlane.projection.regressionDecisions.get('gate-one')!
    expect(decision.statistics).toMatchObject({ evidenceCompleteness: { baseline: 1, candidate: 1, completePairs: 1, totalPairs: 1 }, pareto: { relation: 'equivalent', baseline: { latencyMs: 4321 }, candidate: { latencyMs: 4321 } } })
    await controlPlane.executeCommand({ schemaVersion: 1, type: 'report.generate', commandId: 'record-report', idempotencyKey: 'record-report', submittedAt: '2026-08-03T00:00:15.000Z', reportId: 'report-one', runIds: [run.runId], methodologyVersion: '1' })
    const insight = { schemaVersion: 1 as const, insightId: 'insight-one', evidenceRefs: [finding.findingId, decision.gateId], failureCluster: 'instruction drift', affectedTaskRate: 1, severity: 'high' as const, suspectedLayer: 'runtime' as const, confidence: 1, recommendation: 'retain constraints', expectedMetric: 'instruction_following', regressionPackId: pack.packId, owner: 'platform', status: 'validated' as const, postFixValidationRefs: [decision.gateId], postFixCandidateRunId: run.runId, postFixGateId: decision.gateId }
    await controlPlane.executeCommand({ schemaVersion: 1, type: 'insight.record', commandId: 'record-insight', idempotencyKey: 'record-insight', submittedAt: '2026-08-03T00:00:16.000Z', insight })

    expect((await controlPlane.query({ resource: 'defects', runId: run.runId, page: { limit: 50 } }) as { items: Array<{ status: string }> }).items).toMatchObject([{ status: 'promoted' }])
    expect((await controlPlane.query({ resource: 'reproductions', findingId: finding.findingId, page: { limit: 50 } }) as { items: unknown[] }).items).toHaveLength(1)
    expect((await controlPlane.query({ resource: 'regressions', page: { limit: 50 } }) as { items: unknown[] }).items).toHaveLength(1)
    expect((await controlPlane.query({ resource: 'regression-decisions', page: { limit: 50 } }) as { items: unknown[] }).items).toHaveLength(1)
    const capabilityVectors = await controlPlane.query({ resource: 'capability-vectors', runId: run.runId, agentVariantId: run.agents[0]!.variantId, methodologyVersion: '1.0.0', page: { limit: 50 } }) as { items: Array<{ components: Record<string, { methodologyRef: string; evidenceRefs: string[] }> }> }
    expect(Object.keys(capabilityVectors.items[0]!.components)).toHaveLength(11)
    expect(capabilityVectors.items[0]!.components.taskSuccess).toMatchObject({ methodologyRef: 'methodology://1.0.0/capability/taskSuccess', evidenceRefs: [commit.resultHash] })
    const metrics = await controlPlane.query({ resource: 'platform-metrics' }) as { usage: { inputTokens: number; costUsd: number }; artifacts: { manifestsVerified: number; manifestFailures: number }; slos: Array<{ id: string; status: string }>; traceCoverage: { completedTrials: number } }
    expect(metrics).toMatchObject({ usage: { inputTokens: 13, costUsd: 0.02 }, artifacts: { manifestsVerified: 1, manifestFailures: 0 }, traceCoverage: { completedTrials: 1 } })
    expect(metrics.slos.map((slo) => slo.id)).toHaveLength(6)
    expect((await controlPlane.query({ resource: 'reports', runId: run.runId, page: { limit: 50 } }) as { items: unknown[] }).items).toHaveLength(1)
    expect((await readFile(join(options.reportRoot, 'reports', 'report-one', 'report.pdf'), 'utf8')).startsWith('%PDF-1.4')).toBe(true)
    expect((await controlPlane.query({ resource: 'insights', page: { limit: 50 } }) as { items: unknown[] }).items).toHaveLength(1)
    const audit = await controlPlane.query({ resource: 'audit', page: { limit: 500 } }) as { items: Array<{ sequence: number; operation: string }> }
    expect(audit.items.map((record) => record.sequence)).toEqual(audit.items.map((_record, index) => index))
    expect(audit.items.some((record) => record.operation === 'defect.recorded')).toBe(true)
    const restarted = new EvaluationControlPlane(options)
    await restarted.initialize()
    expect([...restarted.projection.reproductions.values()]).toEqual([...controlPlane.projection.reproductions.values()])
    expect([...restarted.projection.regressionPacks.values()]).toEqual([...controlPlane.projection.regressionPacks.values()])
    expect(restarted.projection.auditRecords).toEqual(controlPlane.projection.auditRecords)

    const retention = { schemaVersion: 1 as const, policyId: 'local-retention', retainDays: 30, protectPublishedLeaderboardEvidence: false, protectRegressionEvidence: false, derivedArtifactDeletion: 'transitive' as const, requireConfirmation: true as const }
    await restarted.executeCommand({ schemaVersion: 1, type: 'retention.set', commandId: 'set-retention', idempotencyKey: 'set-retention', submittedAt: '2026-08-03T00:00:17.000Z', policy: retention })
    const impact = await restarted.query({ resource: 'deletion-impact', runId: run.runId }) as { impactHash: string; derivedResourceIds: string[]; blockedByRefs: string[] }
    expect(impact.derivedResourceIds).toEqual(expect.arrayContaining([lease.trialId, finding.findingId, reproduction.bundleId, pack.packId, 'report-one', insight.insightId]))
    expect(impact.blockedByRefs).toEqual([])
    await expect(restarted.executeCommand({ schemaVersion: 1, type: 'run.delete', commandId: 'delete-stale', idempotencyKey: 'delete-stale', submittedAt: '2026-08-03T00:00:18.000Z', runId: run.runId, expectedImpactHash: '0'.repeat(64), confirmation: 'delete:' + run.runId })).rejects.toThrow('impact changed')
    await restarted.executeCommand({ schemaVersion: 1, type: 'run.delete', commandId: 'delete-run', idempotencyKey: 'delete-run', submittedAt: '2026-08-03T00:00:19.000Z', runId: run.runId, expectedImpactHash: impact.impactHash, confirmation: 'delete:' + run.runId })
    expect(restarted.projection.runs.has(run.runId)).toBe(false)
    expect(restarted.projection.trials.has(lease.trialId)).toBe(false)
    expect(restarted.projection.reports.has('report-one')).toBe(false)
    expect(restarted.projection.reproductions.has(reproduction.bundleId)).toBe(false)
    expect(restarted.projection.regressionPacks.has(pack.packId)).toBe(false)
    expect(restarted.projection.insights.has(insight.insightId)).toBe(false)
    await expect(readFile(join(options.reportRoot, 'reports', 'report-one', 'report.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
    const afterDeletionRestart = new EvaluationControlPlane(options)
    await afterDeletionRestart.initialize()
    expect(afterDeletionRestart.projection.deletedRuns.has(run.runId)).toBe(true)
    expect(afterDeletionRestart.projection.runs.has(run.runId)).toBe(false)
  })
})

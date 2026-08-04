import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalyzerInputSchema, StaticSigningKeyRegistry, canonicalJson, parseTrialTraceJsonl, serializeTrialTraceJsonl, counterfactualFailureFingerprint, sha256Hex, type AnalyzerInput, type EvaluationRunSpec, type ResolvedTask, type TrialEvidence } from '@agent-kernel/eval-protocol'
import { ControlPlaneClient } from '@agent-kernel/eval-sdk'
import { BearerTokenAuthenticator, EvaluationControlPlane, RegisteredTaskCatalog, createEvaluationHttpServer } from '@agent-kernel/eval-orchestrator'

import { EvaluationAnalyzer } from './runner.js'
import { EvaluationGrader } from './grader-runner.js'

const servers: Server[] = []
const OPERATOR_TOKEN = 'operator-test-token'
const WORKER_TOKEN = 'worker-test-token'
const ANALYZER_TOKEN = 'analyzer-test-token'
const ANALYZER_ID = 'analyzer-fixture'
const FIXTURE_POLICY = { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'test' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:analyzer-integration'] }, publication: { artifact: { status: 'granted', basis: 'test' }, report: { status: 'granted', basis: 'test' }, leaderboard: { status: 'granted', basis: 'test' }, redistribution: { status: 'granted', basis: 'MIT' } } } as const
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))))

describe('independent analyzer process', () => {
  it('leases a queued job, reads immutable trial evidence, writes verified outputs, and survives Control Plane replay', async () => {
    const fixture = await setup()
    await fixture.client.command(command('run.analyze', { runId: fixture.spec.runId, detectorIds: ['instruction-drift'] }))
    const analyzer = new EvaluationAnalyzer({ controlPlane: fixture.analyzerClient, executorId: ANALYZER_ID, leaseMs: 10_000, pollIntervalMs: 1, now: () => new Date('2026-08-03T00:00:20.000Z') })
    await withOperatorArtifactReads(fixture.client, () => analyzer.runUntilIdle({ idlePolls: 1 }))
    const jobs = await fixture.client.query<{ items: Array<{ jobId: string; state: string; outputManifestRef: string }> }>({ resource: 'analysis-jobs', runId: fixture.spec.runId, state: 'completed', page: { limit: 10 } })
    expect(jobs.items).toHaveLength(1)
    const output = await fixture.client.query<{ outputs: Array<{ outputId: string; kind: string; artifactRef: string }> }>({ resource: 'analysis-output', jobId: jobs.items[0]!.jobId })
    expect(output.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'finding' }), expect.objectContaining({ kind: 'trace' })]))
    const traceOutput = output.outputs.find((entry) => entry.kind === 'trace')!
    const traceResponse = await fetch(fixture.client.baseUrl + '/api/v1/analysis-artifacts/' + jobs.items[0]!.jobId + '/' + traceOutput.outputId, { headers: { authorization: 'Bearer ' + OPERATOR_TOKEN } })
    expect(traceResponse.ok).toBe(true)
    expect(parseTrialTraceJsonl(await traceResponse.text()).spans.map((span) => span.name)).toContain('analyzer.detect')
    await expect(fixture.client.query({ resource: 'defects', runId: fixture.spec.runId, page: { limit: 10 } })).resolves.toMatchObject({ items: [expect.objectContaining({ detectorId: 'instruction-drift' })] })
    const restarted = new EvaluationControlPlane({ journalPath: fixture.journalPath, reportRoot: fixture.artifactRoot, taskCatalog: new RegisteredTaskCatalog(), signingKeyRegistry: fixture.signing.registry })
    await restarted.initialize()
    expect(restarted.projection.analysisJobs.get(jobs.items[0]!.jobId)?.state).toBe('completed')
    expect(restarted.projection.defects.size).toBe(1)
  })

  it('rejects missing output artifacts and requeues an expired analyzer lease', async () => {
    const fixture = await setup()
    const queued = command('run.analyze', { runId: fixture.spec.runId, detectorIds: ['instruction-drift'] })
    await fixture.client.command(queued)
    const jobId = 'analysis-' + queued.commandId
    await fixture.analyzerClient.command(command('analysis.job.start', { jobId, executorId: ANALYZER_ID, leaseMs: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(fixture.client.expireAnalysisJobs()).resolves.toBe(1)
    await expect(fixture.client.query({ resource: 'analysis-job', jobId })).resolves.toMatchObject({ state: 'queued', attempt: 1 })
    const analyzer = new EvaluationAnalyzer({ controlPlane: fixture.analyzerClient, executorId: ANALYZER_ID, leaseMs: 10_000, pollIntervalMs: 1 })
    await withOperatorArtifactReads(fixture.client, () => analyzer.runUntilIdle({ idlePolls: 1 }))
    await expect(fixture.client.query({ resource: 'analysis-job', jobId })).resolves.toMatchObject({ state: 'completed', attempt: 1 })
  })

  it('keeps grading and detector queues separate and commits verified grading artifacts', async () => {
    const fixture = await setup()
    await fixture.client.command(command('run.grade', { runId: fixture.spec.runId }))
    await fixture.client.command(command('run.analyze', { runId: fixture.spec.runId, detectorIds: ['instruction-drift'] }))
    const analyzer = new EvaluationAnalyzer({ controlPlane: fixture.analyzerClient, executorId: ANALYZER_ID, leaseMs: 10_000, pollIntervalMs: 1 })
    await withOperatorArtifactReads(fixture.client, () => analyzer.runUntilIdle({ idlePolls: 1 }))
    const afterAnalysis = await fixture.client.query<{ items: Array<{ kind: string; state: string }> }>({ resource: 'analysis-jobs', runId: fixture.spec.runId, page: { limit: 10 } })
    expect(afterAnalysis.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'grading', state: 'queued' }), expect.objectContaining({ kind: 'detectors', state: 'completed' })]))
    const grader = new EvaluationGrader({ controlPlane: fixture.analyzerClient, executorId: ANALYZER_ID, leaseMs: 10_000, pollIntervalMs: 1, now: () => new Date('2026-08-03T00:00:30.000Z') })
    await withOperatorArtifactReads(fixture.client, () => grader.runUntilIdle({ idlePolls: 1 }))
    const completed = await fixture.client.query<{ items: Array<{ jobId: string; kind: string; state: string }> }>({ resource: 'analysis-jobs', runId: fixture.spec.runId, state: 'completed', kind: 'grading', page: { limit: 10 } })
    expect(completed.items).toHaveLength(1)
    const output = await fixture.client.query<{ outputs: Array<{ kind: string; artifactRef: string }> }>({ resource: 'analysis-output', jobId: completed.items[0]!.jobId })
    expect(output.outputs).toEqual([expect.objectContaining({ kind: 'grading-result' })])
  })

  it('executes independent alignment, clustering, promotion, and five-way counterfactual jobs with durable authority', async () => {
    const fixture = await setup({ agents: 2 })
    await fixture.client.command(command('run.align', { runId: fixture.spec.runId }))
    for (const [index, trialId] of fixture.trialIds.entries()) {
      await fixture.client.command(command('defect.record', { finding: {
        schemaVersion: 1, findingId: 'unknown-' + String(index), detectorId: 'unknown-cluster', detectorVersion: '1', runId: fixture.spec.runId, trialId,
        category: 'unknown', severity: 'high', confidence: 0.5, evidenceRefs: ['trial:' + trialId], status: 'detected',
      } }))
    }
    await fixture.client.command(command('run.cluster', { runId: fixture.spec.runId }))
    const request = {
      schemaVersion: 1 as const, requestId: 'fresh-counterfactual', sourceTrialId: fixture.trialIds[1]!, checkpointSequence: 1, sourceFailureFingerprint: await counterfactualFailureFingerprint(fixture.analyzerInputs[1]!.events, 1),
      interventions: [
        { kind: 'corrected_action' as const, actionKind: 'tool_call' as const, replacement: { tool: 'search' } },
        { kind: 'different_backend' as const, backendId: 'codex', agentVersion: '1' },
        { kind: 'different_model' as const, modelId: 'fixture-b', configHash: '8'.repeat(64) },
        { kind: 'corrected_tool_result' as const, toolCallSequence: 1, resultArtifactRef: 'fixtures/read.json', resultSha256: '7'.repeat(64) },
        { kind: 'fault_removed' as const, faultScenarioId: 'read-fault' },
      ],
    }
    await fixture.client.command(command('run.counterfactual', { runId: fixture.spec.runId, request }))
    const analyzer = new EvaluationAnalyzer({
      controlPlane: fixture.analyzerClient, executorId: ANALYZER_ID, leaseMs: 10_000, pollIntervalMs: 1,
      counterfactualHarness: { continue: async ({ intervention }) => ({
        outcome: intervention.kind === 'different_model' ? 'same_failure' : 'resolved',
        ...(intervention.kind === 'different_model' ? { observedFailureFingerprint: request.sourceFailureFingerprint } : {}),
        evidenceRefs: ['fresh:' + intervention.kind],
        continuationEvents: [{ schemaVersion: 1, sequence: 2, at: '2026-08-03T00:00:21.000Z', kind: 'status', data: { state: 'done' } }],
      }) },
      counterfactualVerifier: { verify: async ({ intervention }) => ({ passed: intervention.kind !== 'different_model', evidenceRefs: ['verifier:' + intervention.kind] }) },
    })
    await withOperatorArtifactReads(fixture.client, () => analyzer.runUntilIdle({ idlePolls: 1 }))

    const jobs = await fixture.client.query<{ items: Array<{ jobId: string; kind: string; state: string }> }>({ resource: 'analysis-jobs', runId: fixture.spec.runId, state: 'completed', page: { limit: 20 } })
    const failedJobs = await fixture.client.query<{ items: unknown[] }>({ resource: 'analysis-jobs', runId: fixture.spec.runId, state: 'failed', page: { limit: 20 } })
    expect(jobs.items.map((job) => job.kind).sort(), JSON.stringify(failedJobs.items, null, 2)).toEqual(['clustering', 'counterfactual', 'trace-alignment'])
    const outputs = await Promise.all(jobs.items.map(async (job) => ({ job, manifest: await fixture.client.query<{ outputs: Array<{ outputId: string; kind: string }> }>({ resource: 'analysis-output', jobId: job.jobId }) })))
    expect(outputs.find(({ job }) => job.kind === 'trace-alignment')!.manifest.outputs).toEqual([expect.objectContaining({ kind: 'trace-alignment' })])
    expect(outputs.find(({ job }) => job.kind === 'counterfactual')!.manifest.outputs).toHaveLength(5)
    const cluster = outputs.find(({ job }) => job.kind === 'clustering')!
    expect(cluster.manifest.outputs.length).toBeGreaterThan(0)
    const clusterId = cluster.manifest.outputs[0]!.outputId
    await fixture.client.command(command('failure-cluster.promote', {
      runId: fixture.spec.runId, sourceJobId: cluster.job.jobId, clusterId, humanName: 'Reviewed recovery loop', promotedCategory: 'tool_recovery',
      promotedBy: { actorId: 'reviewer-one', authority: 'reviewer' },
    }))
    await expect(fixture.client.query({ resource: 'failure-cluster-promotions', runId: fixture.spec.runId, page: { limit: 10 } })).resolves.toMatchObject({
      items: [{ sourceJobId: cluster.job.jobId, cluster: { clusterId, status: 'human_named', promotedCategory: 'tool_recovery' }, promotedBy: { actorId: 'reviewer-one' } }],
    })
    const audit = await fixture.client.query<{ items: Array<{ operation: string; actor: { kind: string; id: string }; details: Record<string, unknown> }> }>({ resource: 'audit', page: { limit: 500 } })
    expect(audit.items).toContainEqual(expect.objectContaining({ operation: 'failure-cluster.promotion.recorded', actor: { kind: 'operator', id: 'operator-fixture' }, details: expect.objectContaining({ authority: 'reviewer', clusterId }) }))
    const restarted = new EvaluationControlPlane({ journalPath: fixture.journalPath, reportRoot: fixture.artifactRoot, taskCatalog: new RegisteredTaskCatalog(), signingKeyRegistry: fixture.signing.registry })
    await restarted.initialize()
    expect(restarted.projection.failureClusterPromotions.size).toBe(1)
    expect(restarted.projection.analysisJobs.get(cluster.job.jobId)?.state).toBe('completed')
  })
})

async function setup(options: { agents?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'eval-analyzer-runner-')); const artifactRoot = join(directory, 'artifacts'); const journalPath = join(directory, 'journal.jsonl')
  const task: ResolvedTask = { schemaVersion: 1, taskId: 'task', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Analyzer fixture', prompt: 'Respect the constraint.', repository: { kind: 'artifact', archiveRef: 'task.tar', archiveSha256: 'a'.repeat(64), revision: 'revision' }, fixtureManifestHash: 'a'.repeat(64), faultScenarioIds: [], verification: [{ stepId: 'must-test', argv: ['false'], cwd: '.', timeoutMs: 100, requiredExitCode: 0 }], analysis: { constraints: [{ id: 'must-test', kind: 'must', sourceRef: 'task#must-test', verifierId: 'fixture', verifierVersion: '1', verifierMetric: 'must-test' }], protectedPaths: [], hiddenVerifierPaths: [] }, policy: FIXTURE_POLICY }
  const taskIdsHash = await sha256Hex(canonicalJson([task.taskId])); const sliceManifestHash = 'b'.repeat(64)
  const agentCount = options.agents ?? 1
  const agents = Array.from({ length: agentCount }, (_unused, index) => ({ variantId: 'agent-' + String(index), backendId: 'custom-command', agentVersion: '1', model: { modelId: 'fixture-' + String(index) }, configHash: String(index + 1).repeat(64), config: {}, credentialRefs: [] }))
  const spec: EvaluationRunSpec = { schemaVersion: 1, runId: 'fresh-analyzer-run', taskPack: { id: 'custom-task-pack', version: '1', evaluatedSlice: { sliceId: 'one', dataset: { datasetId: 'fixture', displayName: 'Fixture', version: '1', sourceRevision: 'revision', manifestHash: 'c'.repeat(64), taskIdsHash, totalItems: 1, officialBenchmark: false, policy: FIXTURE_POLICY }, selectionKind: 'full', selectionSpec: { kind: 'full', taskIdsHash }, selectedItems: 1, coverageRatio: 1, taskIdsManifestRef: 'catalog/tasks.json', sliceManifestHash }, policy: FIXTURE_POLICY }, agents, execution: { repeats: 1, priority: 0, maxConcurrency: agentCount, maxConcurrencyPerBackend: agentCount, maxConcurrencyPerProvider: agentCount, leaseMs: 10_000, timeoutMs: 10_000, inactivityTimeoutMs: 1_000, retryPolicy: { maxAttempts: 1, retryableCategories: [], backoffMs: 0 } }, sandbox: { provider: 'docker', imageDigest: 'sha256:fixture', readOnlyBase: true, ephemeralOverlay: true, resources: { cpu: 1, memoryMb: 256, diskMb: 256, pids: 64 }, network: { mode: 'denied', allowedDestinations: [] }, artifactAllowlist: [] }, verification: { verifierId: 'fixture', verifierVersion: '1', officialRequired: false, timeoutMs: 1_000, configHash: 'e'.repeat(64) }, analysis: { detectorIds: ['instruction-drift'], repeatsRequired: 1, configHash: 'f'.repeat(64) }, createdAt: '2026-08-03T00:00:00.000Z' }
  const catalog = new RegisteredTaskCatalog(); catalog.register(sliceManifestHash, [task])
  const signing = signingFixture()
  const controlPlane = new EvaluationControlPlane({ journalPath, reportRoot: artifactRoot, taskCatalog: catalog, signingKeyRegistry: signing.registry }); await controlPlane.initialize()
  const authenticator = new BearerTokenAuthenticator({ schemaVersion: 1, keys: [
    { key: OPERATOR_TOKEN, principal: { schemaVersion: 1, principalId: 'operator-fixture', kind: 'user', role: 'operator', scopes: ['platform:read', 'evaluation:read', 'evaluation:write', 'evidence:read', 'governance:write'] } },
    { key: WORKER_TOKEN, principal: { schemaVersion: 1, principalId: 'worker-fixture', kind: 'service', role: 'worker', serviceId: 'worker', scopes: ['platform:read', 'worker:execute'] } },
    { key: ANALYZER_TOKEN, principal: { schemaVersion: 1, principalId: 'analyzer-fixture', kind: 'service', role: 'analyzer', serviceId: ANALYZER_ID, scopes: ['platform:read', 'evaluation:read', 'analyzer:execute'] } },
  ] })
  const server = createEvaluationHttpServer(controlPlane, { authenticator }); servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const baseUrl = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
  const client = new ControlPlaneClient({ baseUrl, credentialProvider: () => OPERATOR_TOKEN })
  const workerClient = new ControlPlaneClient({ baseUrl, credentialProvider: () => WORKER_TOKEN })
  const analyzerClient = new ControlPlaneClient({ baseUrl, credentialProvider: () => ANALYZER_TOKEN })
  analyzerClient.query = client.query.bind(client); analyzerClient.expireAnalysisJobs = client.expireAnalysisJobs.bind(client)
  await client.command(command('run.create', { spec })); await client.command(command('run.start', { runId: spec.runId })); await workerClient.registerWorker({ schemaVersion: 1, workerId: 'worker', workerVersion: '1', protocolVersions: [1], sandboxProviders: ['docker'], agentBackends: ['custom-command'], benchmarkAdapters: ['custom-task-pack'], capacity: { cpu: 1, memoryMb: 256, diskMb: 256, gpu: 0, maxTrials: 1 } })
  const trialIds: string[] = []; const analyzerInputs: AnalyzerInput[] = []
  for (let index = 0; index < agentCount; index += 1) {
  const lease = (await workerClient.acquireLease('worker', 10_000))!; const trial = controlPlane.projection.trials.get(lease.trialId)!; trialIds.push(trial.trialId); const prefix = spec.runId + '/' + trial.trialId + '/'
  const passed = agentCount > 1 && index === 0
  const events = passed
    ? [{ schemaVersion: 1 as const, sequence: 0, at: spec.createdAt, kind: 'status' as const, data: { state: 'start' } }, { schemaVersion: 1 as const, sequence: 1, at: spec.createdAt, kind: 'tool_call' as const, data: { tool: 'read' } }, { schemaVersion: 1 as const, sequence: 2, at: spec.createdAt, kind: 'command' as const, data: { argv: ['test'] } }, { schemaVersion: 1 as const, sequence: 3, at: spec.createdAt, kind: 'status' as const, data: { state: 'done' } }]
    : [{ schemaVersion: 1 as const, sequence: 0, at: spec.createdAt, kind: 'status' as const, data: { state: 'start' } }, { schemaVersion: 1 as const, sequence: 1, at: spec.createdAt, kind: 'tool_call' as const, data: { tool: 'read' } }, { schemaVersion: 1 as const, sequence: 2, at: spec.createdAt, kind: 'error' as const, data: { code: 'ENOENT' } }, { schemaVersion: 1 as const, sequence: 3, at: spec.createdAt, kind: 'status' as const, data: { state: 'failed' } }]
  let analyzerUnsigned = { schemaVersion: 1 as const, runId: spec.runId, trialId: trial.trialId, taskId: task.taskId, traceHash: 'a'.repeat(64), projectionHash: await sha256Hex(canonicalJson(events.map((event) => ({ ...event, nativeEventRef: prefix + 'native-events.jsonl#' + String(event.sequence) })))), normalizationVersion: 'fixture-v1', events: events.map((event) => ({ ...event, nativeEventRef: prefix + 'native-events.jsonl#' + String(event.sequence) })), constraints: task.analysis.constraints, constraintLifecycle: [{ constraintId: 'must-test', state: passed ? 'satisfied' as const : 'violated' as const, eventSequence: 2, evidenceRefs: [prefix + 'verifier-result.json'] }], memoryProbes: [], toolAttempts: [], planSteps: [], workspaceIntegrity: { changedPaths: [], deletedPaths: [], protectedPaths: [], hiddenVerifierPaths: [], verifierLeakagePaths: [], suspiciousLiteralEvidenceRefs: [] }, verifierIntegrity: { passed, protectedIntegrityPassed: true, hiddenVerifierPassed: true, selectedTestFraction: 1, evidenceRefs: [prefix + 'verifier-result.json'] } }
  let analyzerInput: AnalyzerInput
  let analyzerBody: Buffer
  const refs = { runId: spec.runId, trialId: trial.trialId, backendId: 'custom-command', taskId: task.taskId }
  const traceSpan = (spanId: string, parentSpanId: string | undefined, name: 'evaluation.run' | 'evaluation.trial' | 'environment.prepare' | 'agent.execute' | 'workspace.snapshot' | 'verifier.execute') => ({ schemaVersion: 1 as const, traceId: 'trace-' + trial.trialId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, startedAt: spec.createdAt, completedAt: spec.createdAt, status: 'ok' as const, refs, artifactRefs: [] })
  const traceBody = Buffer.from(serializeTrialTraceJsonl({ schemaVersion: 1, traceId: 'trace-' + trial.trialId, runId: spec.runId, trialId: trial.trialId, spans: [traceSpan('run', undefined, 'evaluation.run'), traceSpan('trial', 'run', 'evaluation.trial'), traceSpan('environment', 'trial', 'environment.prepare'), traceSpan('agent', 'trial', 'agent.execute'), traceSpan('workspace', 'trial', 'workspace.snapshot'), traceSpan('verifier', 'trial', 'verifier.execute')] }))
  analyzerUnsigned = { ...analyzerUnsigned, traceHash: await sha256Hex(traceBody) }
  analyzerInput = AnalyzerInputSchema.parse({ ...analyzerUnsigned, inputManifestHash: await sha256Hex(canonicalJson(analyzerUnsigned)) })
  analyzerBody = Buffer.from(JSON.stringify(analyzerInput))
  analyzerInputs.push(analyzerInput)
  const files = new Map([['native-events.jsonl', Buffer.from('{}\n')], ['normalized-events.jsonl', Buffer.from('{}\n')], ['trace.jsonl', traceBody], ['analyzer-input.json', analyzerBody], ['final.diff', Buffer.from('diff')], ['stdout.log', Buffer.from('out')], ['stderr.log', Buffer.from('err')], ['verifier-result.json', Buffer.from('{}')]])
  const entries = [...files].map(([name, body]) => ({ artifactId: name, path: prefix + name, mediaType: 'application/json', bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), redaction: 'passed' as const, classification: 'operator' as const }))
  for (const entry of entries) await workerClient.stageTrialArtifact({ leaseId: lease.leaseId, commitToken: lease.commitToken, ...entry, content: files.get(entry.artifactId)! })
  const unsignedManifest = { schemaVersion: 1 as const, runId: spec.runId, trialId: trial.trialId, leaseId: lease.leaseId, generatedAt: '2026-08-03T00:00:10.000Z', entries }; const manifestHash = await sha256Hex(canonicalJson(unsignedManifest)); const artifactManifest = { ...unsignedManifest, manifestHash, signature: signing.sign(manifestHash) }
  const unsignedEvidence = { schemaVersion: 1 as const, runId: spec.runId, trialId: trial.trialId, agentVariantId: trial.agentVariantId, taskId: task.taskId, repeatIndex: 0, environmentLock: { schemaVersion: 1 as const, provider: 'docker' as const, imageDigest: spec.sandbox.imageDigest, repositoryRevision: 'revision', dependencyLockHashes: {}, redactedEnvironment: {}, resourcePolicyHash: '1'.repeat(64), networkPolicyHash: '2'.repeat(64), toolchainVersions: {}, fixtureVersions: {}, faultInjectorVersions: {} }, nativeEventsRef: prefix + 'native-events.jsonl', normalizedEventsRef: prefix + 'normalized-events.jsonl', traceRef: prefix + 'trace.jsonl', normalizedEventCount: events.length, analyzerInputRef: prefix + 'analyzer-input.json', finalDiffRef: prefix + 'final.diff', stdoutRef: prefix + 'stdout.log', stderrRef: prefix + 'stderr.log', usage: { availability: 'unavailable' as const, reason: 'fixture' }, benchmarkResult: { schemaVersion: 1 as const, benchmarkId: 'custom-task-pack' as const, verifierId: 'fixture', verifierVersion: '1', nativeMetrics: { 'must-test': passed }, rawResultRef: prefix + 'verifier-result.json', officialEvidence: false }, artifactManifest, evidenceLevel: 'native' as const }; const resultHash = await sha256Hex(canonicalJson(unsignedEvidence)); const evidence: TrialEvidence = { ...unsignedEvidence, resultHash, signature: signing.sign(resultHash) }
  await workerClient.commitTrialResult({ schemaVersion: 1, leaseId: lease.leaseId, trialId: trial.trialId, attempt: lease.attempt, commitToken: lease.commitToken, resultHash: evidence.resultHash, artifactManifestHash: artifactManifest.manifestHash, evidence, terminalState: 'completed', committedAt: '2026-08-03T00:00:10.000Z' })
  }
  return { spec, client, analyzerClient, controlPlane, journalPath, artifactRoot, trialIds, analyzerInputs, signing }
}
function command(type: string, fields: Record<string, unknown>): any { const commandId = type.replaceAll('.', '-') + '-' + Math.random().toString(36).slice(2); return { schemaVersion: 1, type, commandId, idempotencyKey: commandId, submittedAt: new Date().toISOString(), ...fields } }

function signingFixture() {
  const { privateKey } = generateKeyPairSync('ed25519'); const keyReference = 'runner-integration-key'
  const registry = new StaticSigningKeyRegistry({ schemaVersion: 1, keys: [{ keyReference, algorithm: 'ed25519', publicKeySpkiBase64: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'), scopes: ['artifact_manifest', 'trial_result'], status: 'active', validFrom: '2026-01-01T00:00:00.000Z' }] })
  return { registry, sign: (digest: string) => ({ algorithm: 'ed25519' as const, keyReference, valueBase64: sign(null, Buffer.from(digest, 'hex'), privateKey).toString('base64') }) }
}

async function withOperatorArtifactReads<T>(client: ControlPlaneClient, operation: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(client.baseUrl + '/api/v1/artifacts/')) return await originalFetch(input, init)
    const headers = new Headers(init.headers); headers.set('authorization', 'Bearer ' + OPERATOR_TOKEN)
    return await originalFetch(input, { ...init, headers })
  }
  try { return await operation() } finally { globalThis.fetch = originalFetch }
}

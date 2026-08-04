#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, normalize, relative, resolve, sep } from 'node:path'

const root = resolve(process.argv[2])
const port = Number(process.argv[3])
const exactSliceHash = 'a'.repeat(64)
const comparisonSliceHash = 'c'.repeat(64)
const deletionImpactHash = 'b'.repeat(64)
const capabilities = {
  schemaVersion: 1, protocolVersions: [1], controlPlaneVersion: 'browser-fixture',
  commands: ['run.create', 'run.start', 'run.cancel', 'trial.retry', 'run.grade', 'run.analyze', 'run.align', 'run.cluster', 'run.counterfactual', 'leaderboard.publish', 'leaderboard.invalidate', 'defect.promote', 'failure-cluster.promote', 'regression.evaluate', 'report.generate', 'insight.record', 'retention.set', 'run.delete'],
  queryResources: ['capabilities', 'platform-metrics', 'runs', 'run', 'events', 'trials', 'trial', 'task', 'catalog', 'artifacts', 'leaderboard', 'defects', 'failure-cluster-promotions', 'reproductions', 'regressions', 'regression-decisions', 'analysis-jobs', 'analysis-job', 'analysis-output', 'capability-vectors', 'insights', 'reports', 'audit', 'retention', 'deletion-impact', 'workers'],
  liveEvents: 'sse', standalone: true, cleanCutover: true, deprecatedCompatibilitySurfaces: [],
}
let liveProjectionSequence = 0
let liveConnections = 0
let committedSequence = 0
const receivedCommands = []
const commandAttempts = new Map()
const receivedQueries = []

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const scenario = fixtureScenario(request, url)
    if (scenario === 'loading') await delay(450)
    if (url.pathname === '/api/v1/capabilities') {
      const value = scenario === 'unsupported-protocol'
        ? { ...capabilities, protocolVersions: [2] }
        : scenario === 'unsupported-capability'
          ? { ...capabilities, queryResources: ['capabilities'] }
          : capabilities
      return json(response, 200, value)
    }
    if (url.pathname === '/api/v1/query') {
      const query = await requestJson(request)
      receivedQueries.push({ scenario, query })
      if (scenario === 'error' || scenario === 'stale') return json(response, 503, { code: 'FIXTURE_UNAVAILABLE', message: 'The authoritative fixture is unavailable.' })
      return json(response, 200, queryResult(query, scenario))
    }
    if (url.pathname === '/api/v1/administration/status' && request.method === 'GET') {
      return json(response, 200, { security: { principals: [{ principalId: 'browser-operator', kind: 'user', role: 'administrator', scopes: ['administration:read'], keyCount: 1, status: 'active' }], serviceKeys: [], trustKeys: [] }, maintenance: { retentionSweeps: [], backups: [], restoreDrills: [], audit: [] } })
    }
    if (url.pathname === '/api/v1/administration/security/reload' && request.method === 'POST') {
      return json(response, 200, { generation: 2 })
    }
    if (url.pathname === '/api/v1/commands') {
      const command = await requestJson(request)
      const attemptKey = scenario + ':' + String(command.idempotencyKey)
      const attempt = (commandAttempts.get(attemptKey) ?? 0) + 1
      commandAttempts.set(attemptKey, attempt)
      receivedCommands.push({ scenario, attempt, command })
      if (scenario === 'command-failure-once' && attempt === 1) return json(response, 503, { code: 'FIXTURE_LOST_ACK', message: 'Synthetic first-attempt acknowledgement loss.' })
      committedSequence += 1
      return json(response, 200, { schemaVersion: 1, idempotencyKey: command.idempotencyKey, commandId: command.commandId, committedSequence, committedAt: '2026-08-03T00:00:00.000Z', projectionVersion: committedSequence })
    }
    const artifactMatch = /^\/api\/v1\/artifacts\/([^/]+)$/u.exec(url.pathname)
    if (request.method === 'GET' && artifactMatch) {
      const count = scenario === 'trace-large' ? 180 : 4
      const newline = String.fromCharCode(10)
      const body = Array.from({ length: count }, (_, sequence) => JSON.stringify({ schemaVersion: 1, sequence, at: '2026-08-03T00:00:' + String(sequence % 60).padStart(2, '0') + '.000Z', type: sequence % 4 === 0 ? 'tool.result' : 'assistant.message', phase: sequence < 2 ? 'planning' : 'execution', data: { fixture: true, sequence } })).join(newline) + newline
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
      response.end(body)
      return
    }
    if (url.pathname === '/api/v1/fixture/state') return json(response, 200, { receivedCommands, receivedQueries, deletionImpactHash })
    if (url.pathname === '/api/v1/fixture/reset') {
      receivedCommands.length = 0
      receivedQueries.length = 0
      commandAttempts.clear()
      committedSequence = 0
      return json(response, 200, { reset: true })
    }
    if (url.pathname === '/api/v1/events') return liveEvents(request, response, url, scenario)
    return await staticFile(response, url, scenario)
  } catch (error) {
    return json(response, 500, { code: 'FIXTURE_SERVER_ERROR', message: error instanceof Error ? error.message : String(error) })
  }
}).listen(port, '127.0.0.1')

function queryResult(query, scenario) {
  if (query.resource === 'deletion-impact') return { impactHash: deletionImpactHash, derivedResourceIds: ['report:browser-run-1', 'analysis:browser-run-1'], blockedByRefs: scenario === 'protected-delete' ? ['release-baseline'] : [] }
  if (query.resource === 'platform-metrics') return platformMetrics()
  if (query.resource === 'run') return runValue(0)
  if (query.resource === 'trial') return { id: query.trialId, trialId: query.trialId, runId: 'browser-run-1', taskId: 'task-1', agentVariantId: 'runlab', attempt: 1, state: 'completed' }
  if (scenario === 'live' && query.resource === 'runs') return page([{ id: 'browser-live-run', accepted: { spec: { runId: 'browser-live-run' } }, state: 'running', events: Array.from({ length: liveProjectionSequence + 1 }, (_, sequence) => ({ sequence })), updatedAt: 'live-sequence-' + String(liveProjectionSequence) }], false, 1)
  const empty = scenario === 'empty'
  const count = empty ? 0 : scenario === 'large' ? Math.min(Number(query?.page?.limit ?? 100), 100) : scenario === 'partial' || (query.resource === 'catalog' && query.catalog === 'task-packs') ? 2 : 1
  const values = Array.from({ length: count }, (_, index) => valueForQuery(query, index))
  const hasMore = scenario === 'partial' || scenario === 'large'
  const result = page(values, hasMore, hasMore ? Math.max(count + 17, 10_000) : count)
  return query.resource === 'leaderboard' ? { ...result, pivot: query.pivot || 'model', rankingGroups: ['comparable'] } : result
}

function valueForQuery(query, index) {
  const suffix = String(index + 1)
  if (query.resource === 'runs') return runValue(index)
  if (query.resource === 'run') return runValue(0)
  if (query.resource === 'events') return { schemaVersion: 1, sequence: index, at: '2026-08-03T00:00:00.000Z', runId: 'browser-run-1', type: 'run.state', producer: 'control-plane', data: { state: 'running' } }
  if (query.resource === 'trials') return { id: 'browser-trial-' + suffix, trialId: 'browser-trial-' + suffix, runId: 'browser-run-1', taskId: 'task-' + suffix, agentVariantId: ['runlab', 'claude', 'codex'][index % 3], attempt: 1, state: index % 2 ? 'completed' : 'queued' }
  if (query.resource === 'artifacts') return { artifactId: 'artifact-' + suffix, path: 'browser-run-1/browser-trial-1/' + (index === 0 ? 'normalized-events.jsonl' : 'artifact-' + suffix + '.json'), mediaType: index === 0 ? 'application/x-ndjson' : 'application/json', bytes: 128 + index, sha256: '9'.repeat(64), redaction: 'passed', classification: 'operator' }
  if (query.resource === 'analysis-jobs') { const kind = ['grading', 'detectors', 'trace-alignment'][index % 3]; return { schemaVersion: 1, protocolVersion: 1, jobId: 'analysis-' + suffix, runId: 'browser-run-1', kind, inputRefs: ['run:browser-run-1'], inputManifestHash: '1'.repeat(64), implementationId: 'browser-analyzer', implementationVersion: '1.0.0', configHash: '2'.repeat(64), ...(kind === 'detectors' ? { detectorIds: ['tool-recovery'] } : {}), attempt: 0, state: 'queued', createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z' } }
  if (query.resource === 'capability-vectors') return { schemaVersion: 1, methodologyVersion: '1.0.0', runId: 'browser-run-1', agentVariantId: ['runlab', 'claude', 'codex'][index % 3], components: capabilityComponents() }
  if (query.resource === 'defects') return { id: 'finding-' + suffix, findingId: 'finding-' + suffix, detectorId: 'tool-recovery', detectorVersion: '1', runId: 'browser-run-1', trialId: 'browser-trial-1', category: 'tool_recovery', severity: index ? 'medium' : 'critical', confidence: 0.95, firstDivergenceSequence: 4, status: 'human_validated' }
  if (query.resource === 'reproductions') return { id: 'bundle-' + suffix, bundleId: 'bundle-' + suffix, findingId: 'finding-' + suffix, failureFingerprint: '3'.repeat(64), reproduction: { reproduced: 2, minimization: { minimizedUnits: 1 } } }
  if (query.resource === 'failure-cluster-promotions') return { id: 'promotion-' + suffix, promotionId: 'promotion-' + suffix, cluster: { clusterId: 'cluster-' + suffix, humanName: 'Observed recovery loop', promotedCategory: 'tool_recovery' }, promotedBy: { actorId: 'browser-operator' }, promotedAt: '2026-08-03T00:00:00.000Z' }
  if (query.resource === 'regressions') return { id: 'regression-' + suffix, packId: 'regression-' + suffix, version: '1.' + suffix, taskPackRef: 'browser-pack-1', severity: 'high', owner: 'release-engineering', allowedFlakeRate: 0.02, promotionSourceFindingId: 'finding-1' }
  if (query.resource === 'regression-decisions') return { id: 'gate-' + suffix, gateId: 'gate-' + suffix, baselineConfigHash: '4'.repeat(64), candidateConfigHash: '5'.repeat(64), pairedTasks: 20, repeats: 3, flakyTasks: [], infrastructureFailures: [], violations: [], decision: 'pass', statistics: { baselineSuccessRate: 0.7, candidateSuccessRate: 0.75, successRateDelta: 0.05, pairedWins: 2, pairedLosses: 1, pairedTies: 17, mcnemarPValue: 1, confidenceInterval: { level: 0.95, lower: -0.05, upper: 0.15, method: 'paired-bootstrap', samples: 10000 }, repeatedRunVariance: { baseline: 0.01, candidate: 0, taskCount: 20 }, evidenceCompleteness: { baseline: 1, candidate: 1, completePairs: 60, totalPairs: 60 }, pareto: { relation: 'candidate_dominates', baseline: { quality: 0.7, costUsd: 1, latencyMs: 1000 }, candidate: { quality: 0.75, costUsd: 0.9, latencyMs: 900 } }, taskDeltas: [{ taskId: 'task-1', baseline: 0, candidate: 1, delta: 1, repeats: 3 }], flakeRate: 0 } }
  if (query.resource === 'insights') return { id: 'insight-' + suffix, insightId: 'insight-' + suffix, failureCluster: 'cluster-' + suffix, affectedTaskRate: 0.1, severity: 'medium', suspectedLayer: 'runtime', confidence: 0.9, recommendation: 'Preserve observe-before-act recovery.', expectedMetric: 'recovery_rate', regressionPackId: 'regression-1', owner: 'runtime-team', status: 'validated', evidenceRefs: ['finding-1'], postFixValidationRefs: ['gate-1'] }
  if (query.resource === 'reports') return { schemaVersion: 1, reportId: 'report-' + suffix, runRefs: ['browser-run-' + suffix], methodologyVersion: '1', inputEvidenceHash: '6'.repeat(64), semanticHash: '7'.repeat(64), formats: ['json', 'csv', 'html', 'pdf', 'junit', 'sarif', 'markdown'].map((format) => ({ format, path: 'reports/report-' + suffix + '.' + format, sha256: '8'.repeat(64) })), includesAllConfiguredRepeats: true, redactionPassed: true, generatedAt: '2026-08-03T00:00:00.000Z' }
  if (query.resource === 'retention') return { id: 'retention-' + suffix, policyId: 'retention-' + suffix, retainDays: 30, protectPublishedLeaderboardEvidence: true, protectRegressionEvidence: true }
  if (query.resource === 'workers') return { id: 'worker-' + suffix, workerId: 'worker-' + suffix, workerVersion: '1', capacity: { cpu: 8, memoryMb: 16384 } }
  if (query.resource === 'audit') return { id: 'audit-' + suffix, sequence: index, at: '2026-08-03T00:00:00.000Z', actor: { kind: 'operator' }, operation: 'run.accepted', resourceType: 'run', resourceId: 'browser-run-' + suffix, commandId: 'command-' + suffix }
  if (query.resource === 'leaderboard') return leaderboardEntry(index, query.sliceManifestHash || exactSliceHash, query.view === 'audit' ? index % 2 ? 'invalidated' : 'superseded' : 'active', query.agentType, query.modelId)
  if (query.resource === 'catalog') return catalogValue(query.catalog, index)
  return { id: String(query.resource || 'record') + '-' + suffix, state: 'ready' }
}

function runValue(index) {
  const suffix = String(index + 1)
  return { id: 'browser-run-' + suffix, accepted: { spec: { runId: 'browser-run-' + suffix, taskPack: { id: 'browser-pack', version: '1', evaluatedSlice: evaluatedSlice(exactSliceHash) }, agents: [], execution: { repeats: 3, budget: { maxUsd: 10 } }, verification: { verifierId: 'browser-verifier', verifierVersion: '1', officialRequired: true } } }, state: index % 2 ? 'completed' : 'running', resourceUsage: { inputTokens: 100, outputTokens: 50, costUsd: 0.25 }, events: [{ sequence: 0 }], updatedAt: '2026-08-03T00:00:00.000Z' }
}

function catalogValue(catalog, index) {
  const suffix = String(index + 1)
  if (catalog === 'datasets') return dataset()
  if (catalog === 'task-packs') return { id: 'browser-pack-' + suffix, version: '1', evaluatedSlice: evaluatedSlice(index === 0 ? exactSliceHash : comparisonSliceHash) }
  if (catalog === 'tasks') return { id: 'task-' + suffix, taskId: 'task-' + suffix, taskPackId: 'browser-pack-1', title: 'Fresh browser task ' + suffix, license: 'MIT' }
  if (catalog === 'agents') return { id: 'agent-' + suffix, backendId: 'codex', provider: 'openai', agentVersion: '1' }
  if (catalog === 'sandboxes') return { id: 'sandbox-' + suffix, provider: 'docker', imageDigest: 'sha256:browser' }
  if (catalog === 'verifiers') return { id: 'verifier-' + suffix, verifierId: 'browser-verifier', verifierVersion: '1' }
  return { id: 'detector-' + suffix }
}

function leaderboardEntry(index, sliceManifestHash, status = 'active', requestedAgent, requestedModel) {
  const suffix = String(index + 1)
  return {
    schemaVersion: 1, entryId: 'leaderboard-entry-' + suffix,
    model: { provider: 'fixture', modelId: requestedModel || 'model-' + suffix, modelVersion: '2026-08-03' },
    agent: { type: requestedAgent || ['agent-runlab', 'claude-code', 'codex'][index % 3], version: '1.0.' + suffix, configHash: 'c'.repeat(64) },
    evaluatedSlice: evaluatedSlice(sliceManifestHash), verifierVersion: 'verified-1', repeatPolicyHash: 'd'.repeat(64),
    repeats: 3, completedTrials: 1500, expectedTrials: 1500,
    primaryMetric: { name: 'resolved_rate', value: 0.62 - index / 1000, unit: 'ratio' },
    confidenceInterval: { level: 0.95, lower: 0.59, upper: 0.65 }, secondaryMetrics: { costUsd: 1.25, p50DurationMs: 800, p95DurationMs: 1200 },
    evidenceLevel: 'official', runRefs: ['browser-run-' + suffix], publishedAt: '2026-08-03T00:00:00.000Z', status,
  }
}

function evaluatedSlice(sliceManifestHash) {
  return {
    sliceId: 'browser-sample-500', dataset: dataset(), selectionKind: 'sampled',
    selectionSpec: { kind: 'sampled', taskIdsHash: 'b'.repeat(64), sample: { count: 500, seed: 42, stratification: 'repository' }, filters: { language: 'python' } },
    selectedItems: 500, coverageRatio: 0.1, taskIdsManifestRef: 'catalog/browser-tasks.json', sliceManifestHash,
  }
}

function dataset() {
  return { datasetId: 'swe-bench-verified', displayName: 'SWE-Bench Verified', version: '2', sourceRevision: 'browser-fixture', manifestHash: 'e'.repeat(64), taskIdsHash: 'f'.repeat(64), split: 'test', totalItems: 5000, officialBenchmark: true, policy: fixturePolicy() }
}
function fixturePolicy() {
  const granted = { status: 'granted', basis: 'browser acceptance fixture' }
  return { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: granted, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:browser'] }, publication: { artifact: granted, report: granted, leaderboard: granted, redistribution: { status: 'granted', basis: 'MIT' } } }
}

function capabilityComponents() {
  return Object.fromEntries(['taskSuccess', 'codeUnderstanding', 'instructionFollowing', 'toolGrounding', 'recovery', 'contextRetention', 'memoryQuality', 'planning', 'testIntegrity', 'efficiency', 'reproducibility'].map((component) => [component, { score: 0.9, detectorIds: component === 'instructionFollowing' ? ['instruction-drift'] : [], verifierIds: ['browser-verifier'], methodologyRef: 'methodology://1.0.0/capability/' + component, evidenceRefs: ['evidence-' + component] }]))
}

function platformMetrics() {
  const distribution = { count: 1, p50Ms: 10, p95Ms: 20, maxMs: 25 }
  return { schemaVersion: 1, generatedAt: '2026-08-03T00:00:00.000Z', observationStartedAt: '2026-08-03T00:00:00.000Z', queue: { queuedTrials: 1, oldestAgeMs: 25 }, workers: { registered: 1, activeLeases: 1, trialCapacity: 2, utilization: 0.5 }, environmentPreparation: distribution, firstModelCall: distribution, modelCalls: distribution, toolCalls: { ...distribution, failuresByCategory: {} }, artifacts: { uploadFailures: 0, manifestsVerified: 1, manifestFailures: 0 }, grader: { completed: 1, failed: 0, failureRate: 0 }, orchestrator: { lastRecoveryMs: 4, journalTransactions: 12 }, usage: { inputTokens: 8, outputTokens: 5, costUsd: 0.02, tokensPerSecond: 1, costUsdPerHour: 0.1 }, terminalOutcomes: { completed: 1 }, flakes: { taskRate: 0, verifierRate: 0, flakyTasks: 0, evaluatedTasks: 1 }, traceCoverage: { trialsWithTrace: 1, completedTrials: 1 }, slos: ['restart-durability', 'duplicate-commit-prevention', 'bounded-cancellation', 'manifest-integrity', 'infrastructure-attribution', 'official-ingest-authority'].map((id) => ({ id, status: 'meeting', target: 'fixture target', observed: 'fixture observation', evidenceRefs: ['fixture:' + id] })) }
}

function page(items, hasMore, total) { return { items, page: { hasMore, ...(hasMore ? { nextCursor: 'fixture-next' } : {}), total } } }

function liveEvents(request, response, url, scenario) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
  if (scenario !== 'live') { response.write(': fixture keepalive\n\n'); return }
  liveConnections += 1
  const after = Number(url.searchParams.get('after') ?? '-1')
  if (liveConnections === 1 && after === 0) {
    liveProjectionSequence = 2
    response.write(sseEvent(2, 'running'))
    response.end()
    return
  }
  if (after < 1) response.write(sseEvent(1, 'preparing'))
  if (after < 2) response.write(sseEvent(2, 'running'))
  response.write(': fixture keepalive\n\n')
  request.once('close', () => response.end())
}
function sseEvent(sequence, state) { return 'id: ' + String(sequence) + '\nevent: durable-event\ndata: ' + JSON.stringify({ schemaVersion: 1, sequence, at: '2026-08-03T00:00:0' + String(sequence) + '.000Z', runId: 'browser-live-run', type: 'run.state', producer: 'control-plane', data: { state } }) + '\n\n' }

async function requestJson(request) {
  let body = ''
  for await (const chunk of request) body += chunk
  return JSON.parse(body || '{}')
}

async function staticFile(response, url, scenario) {
  const requested = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
  const requestedPath = resolve(root, requested)
  const insideRoot = relative(root, requestedPath) !== '..' && !relative(root, requestedPath).startsWith('..' + sep)
  let path = insideRoot ? requestedPath : resolve(root, 'index.html')
  let body
  try { body = await readFile(path) } catch { path = resolve(root, 'index.html'); body = await readFile(path) }
  const headers = {
    'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  }
  if (url.searchParams.has('fixture')) headers['set-cookie'] = 'dashboard-fixture=' + encodeURIComponent(scenario) + '; Path=/; SameSite=Lax'
  response.writeHead(200, headers)
  response.end(body)
}

function fixtureScenario(request, url) {
  const requested = url.searchParams.get('fixture')
  if (requested) return requested
  const cookie = String(request.headers.cookie ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith('dashboard-fixture='))
  return cookie ? decodeURIComponent(cookie.slice('dashboard-fixture='.length)) : 'ready'
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  response.end(body)
}
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }

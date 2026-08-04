import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import {
  acceptEvaluationRunSpec,
  AgentBackendDescriptorSchema,
  ArtifactManifestSchema,
  BenchmarkDescriptorSchema,
  areRankComparable,
  assertMonotonicEvents,
  canonicalJson,
  decideFailureResponsibility,
  decideCatalogPolicy,
  POLICY_OPERATIONS,
  POLICY_STATUSES,
  EvaluatedSliceSchema,
  EvaluationCommandSchema,
  EvaluationQuerySchema,
  EvaluationRunSpecSchema,
  EvaluationRunTemplateSchema,
  findPlaintextCredentialPaths,
  formatEvaluatedSliceLabel,
  leaderboardComparabilityKey,
  leaderboardCompetitorKey,
  LeaderboardEntrySchema,
  ProductInsightSchema,
  PlatformMetricsSnapshotSchema,
  EvaluationEventSchema,
  NormalizedFailureSchema,
  negotiateProtocolVersion,
  migrateCanonicalProtocol,
  RelativeArtifactPathSchema,
  ReportManifestSchema,
  ReproductionBundleSchema,
  ReproductionTaskContractSchema,
  ResolvedTaskSchema,
  replayEvaluationEvents,
  TrialLeaseSchema,
  TrialEvidenceSchema,
  verifyArtifactManifest,
  verifyAcceptedEvaluationRunSpec,
  verifyTrialEvidence,
  TrialTraceSchema,
  type EvaluationEvent,
  type LeaderboardEntry,
} from './index.js'

const root = dirname(fileURLToPath(import.meta.url))
const HASH = 'a'.repeat(64)

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, '..', 'fixtures', 'canonical-run-spec-v1.json'), 'utf8')) as Record<string, unknown>
}

async function resultFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, '..', 'fixtures', 'canonical-trial-result-v1.json'), 'utf8')) as Record<string, unknown>
}

function slice(kind: 'full' | 'named_subset' | 'sampled' = 'full') {
  const totalItems = 500
  const selectedItems = kind === 'full' ? 500 : kind === 'sampled' ? 30 : 50
  return EvaluatedSliceSchema.parse({
    sliceId: kind + '-slice',
    dataset: {
      datasetId: 'swe-bench-verified',
      displayName: 'SWE-Bench Verified',
      version: '1',
      sourceRevision: 'revision-1',
      manifestHash: HASH,
      taskIdsHash: HASH,
      split: 'test',
      totalItems,
      officialBenchmark: true,
      policy: grantedPolicy(),
    },
    selectionKind: kind,
    selectionSpec: kind === 'full'
      ? { kind: 'full', taskIdsHash: HASH }
      : kind === 'sampled'
        ? { kind: 'sampled', taskIdsHash: HASH, sample: { count: selectedItems, seed: 42, stratification: 'repository' }, filters: { language: 'python' } }
        : { kind: 'named_subset', namedSubsetId: 'django-50-v2', taskIdsHash: HASH },
    selectedItems,
    coverageRatio: selectedItems / totalItems,
    taskIdsManifestRef: 'datasets/' + kind + '.json',
    sliceManifestHash: kind === 'full' ? HASH : 'b'.repeat(64),
  })
}

function grantedPolicy() {
  const granted = { status: 'granted' as const, basis: 'fixture grant' }
  return { license: granted, permissions: { evaluation: granted, training: granted }, sourceProvenance: { status: 'granted' as const, sourceRefs: ['fixture:source'] }, publication: { artifact: granted, report: granted, leaderboard: granted, redistribution: granted } }
}

function leaderboardEntry(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    entryId: 'entry-1',
    model: { provider: 'fixture', modelId: 'model-a', modelVersion: '1' },
    agent: { type: 'agent-runlab', version: '1', configHash: HASH },
    evaluatedSlice: slice(),
    verifierVersion: '1',
    repeatPolicyHash: HASH,
    repeats: 3,
    completedTrials: 1500,
    expectedTrials: 1500,
    primaryMetric: { name: 'resolved_rate', value: 0.5, unit: 'ratio' },
    secondaryMetrics: {},
    evidenceLevel: 'official',
    runRefs: ['run-1'],
    publishedAt: '2026-08-03T00:00:00.000Z',
    status: 'active',
    ...overrides,
  }
}

describe('canonical protocol v1', () => {
  it('parses the canonical fixture, commits a stable hash, and rejects tampering', async () => {
    const input = await fixture()
    expect(EvaluationRunSpecSchema.parse(input).runId).toBe('canonical-fixture-v1')
    const accepted = await acceptEvaluationRunSpec(input, '2026-08-03T00:01:00.000Z')
    expect(accepted.specHash).toBe('7e88b3d351ce9a807ae3b24c4e6689bccb491669f2d83b959fb51bf3da7830f6')
    await expect(verifyAcceptedEvaluationRunSpec(accepted)).resolves.toEqual(accepted)
    const tampered = structuredClone(accepted)
    tampered.spec.execution.repeats = 4
    await expect(verifyAcceptedEvaluationRunSpec(tampered)).rejects.toThrow('hash mismatch')
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}')
  })

  it('rejects plaintext credential-like fields and accepts credential references', async () => {
    const input = await fixture()
    const agents = input.agents as Array<Record<string, unknown>>
    agents[0]!.config = { apiKey: 'plaintext-is-forbidden' }
    expect(EvaluationRunSpecSchema.safeParse(input).success).toBe(false)
    expect(findPlaintextCredentialPaths({ nested: { clientSecret: 'secret' }, credentialRef: 'safe-ref' })).toEqual(['$.nested.clientSecret'])
  })

  it('defaults every unknown, denied, and unreviewed catalog policy dimension to denial', () => {
    const deniedStatuses = POLICY_STATUSES.filter((status) => status !== 'granted')
    for (const operation of POLICY_OPERATIONS) for (const subject of ['dataset', 'taskPack'] as const) for (const dimension of ['license', 'evaluation', 'training', 'sourceProvenance'] as const) for (const status of deniedStatuses) {
      const dataset = grantedPolicy()
      const taskPack = grantedPolicy()
      const policy = subject === 'dataset' ? dataset : taskPack
      if (dimension === 'license') policy.license = { status }
      else if (dimension === 'sourceProvenance') policy.sourceProvenance = { status, sourceRefs: [] }
      else policy.permissions[dimension] = { status }
      const purpose = dimension === 'training' ? 'training' : 'evaluation'
      const expectedDimension = dimension === 'sourceProvenance' ? dimension : dimension === 'license' ? dimension : 'permission.' + dimension
      expect(decideCatalogPolicy({ operation, purpose, dataset, taskPack })).toMatchObject({ allowed: false, denials: [{ subject: subject === 'dataset' ? 'dataset' : 'task_pack', dimension: expectedDimension, status }] })
    }
    const publicationDimensions = { artifact_publication: 'artifact', report_publication: 'report', leaderboard_publication: 'leaderboard' } as const
    for (const [operation, target] of Object.entries(publicationDimensions) as Array<[keyof typeof publicationDimensions, typeof publicationDimensions[keyof typeof publicationDimensions]]>) for (const subject of ['dataset', 'taskPack'] as const) for (const dimension of [target, 'redistribution'] as const) for (const status of deniedStatuses) {
      const dataset = grantedPolicy(); const taskPack = grantedPolicy()
      const policy = subject === 'dataset' ? dataset : taskPack
      policy.publication[dimension] = { status }
      expect(decideCatalogPolicy({ operation, dataset, taskPack })).toMatchObject({ allowed: false, denials: [{ subject: subject === 'dataset' ? 'dataset' : 'task_pack', dimension: 'publication.' + dimension, status }] })
    }
  })

  it('rejects development-only backends from official-required run specs', async () => {
    const input = await fixture()
    const agents = input.agents as Array<Record<string, unknown>>
    agents[0]!.backendId = 'smoke'
    expect(EvaluationRunSpecSchema.safeParse(input).success).toBe(false)
    agents[0]!.backendId = 'custom-command'
    expect(EvaluationRunSpecSchema.safeParse(input).success).toBe(false)
  })

  it('rejects unknown runtime, result, and secret fields instead of silently stripping them', async () => {
    const input = await fixture()
    expect(EvaluationRunSpecSchema.safeParse({ ...input, state: 'running' }).success).toBe(false)
    expect(EvaluationRunSpecSchema.safeParse({ ...input, result: { resolved: true } }).success).toBe(false)
    expect(EvaluationRunSpecSchema.safeParse({ ...input, apiKey: 'plaintext' }).success).toBe(false)
    const nested = structuredClone(input)
    ;(nested.execution as Record<string, unknown>).activeLeaseId = 'lease-one'
    expect(EvaluationRunSpecSchema.safeParse(nested).success).toBe(false)
  })

  it('parses the canonical result fixture and verifies its manifest/result hashes', async () => {
    const input = await resultFixture()
    expect(TrialEvidenceSchema.parse(input).trialId).toContain('canonical-fixture-v1')
    await expect(verifyArtifactManifest(input.artifactManifest)).resolves.toMatchObject({ schemaVersion: 1 })
    await expect(verifyTrialEvidence(input)).resolves.toMatchObject({ resultHash: 'a7c1ba253369b5757c063b65d0d4e51a99c53b7eac21d20dcabb733d27aaae81' })
    const tampered = structuredClone(input)
    ;(tampered.environmentLock as Record<string, unknown>).repositoryRevision = 'tampered'
    await expect(verifyTrialEvidence(tampered)).rejects.toThrow('trial evidence hash mismatch')
  })

  it('never lets smoke or ungraded evidence claim official authority', async () => {
    const input = await resultFixture()
    const ungraded = structuredClone(input)
    ;(ungraded.benchmarkResult as Record<string, unknown>).officialEvidence = false
    expect(TrialEvidenceSchema.safeParse(ungraded).success).toBe(false)
    const smoke = structuredClone(input)
    smoke.evidenceLevel = 'smoke'
    expect(TrialEvidenceSchema.safeParse(smoke).success).toBe(false)
  })

  it('is a clean-cutover protocol and does not expose a legacy Host parser', async () => {
    const packageJson = JSON.parse(await readFile(join(root, '..', 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(packageJson.exports)).toEqual(['.'])
    expect(EvaluationRunSpecSchema.safeParse({ schemaVersion: 1, runId: 'old', benchmark: 'swebench' }).success).toBe(false)
  })

  it('validates data-driven run-template task and artifact expansion metadata', async () => {
    const spec = await fixture()
    const template = {
      schemaVersion: 1, templateId: 'guided-template', label: 'Guided template',
      description: 'Fixture guided template.', kind: 'benchmark', recommended: true,
      builder: {
        taskIds: ['task-one', 'task-two'],
        artifactAllowlistPathTemplates: ['{taskPackId}/{trialId}/native-result.json'],
      },
      spec,
    }
    expect(EvaluationRunTemplateSchema.safeParse(template).success).toBe(true)
    expect(EvaluationRunTemplateSchema.safeParse({
      ...template,
      builder: { ...template.builder, taskIds: ['task-one'] },
    }).success).toBe(false)
    expect(EvaluationRunTemplateSchema.safeParse({
      ...template,
      builder: { ...template.builder, artifactAllowlistPathTemplates: ['{unknown}/result.json'] },
    }).success).toBe(false)
  })
})

describe('dataset slices and Leaderboard authority', () => {
  it('enforces truthful full/subset/sample identity and labels', () => {
    expect(formatEvaluatedSliceLabel(slice())).toBe('SWE-Bench Verified · full · 500/500')
    expect(formatEvaluatedSliceLabel(slice('named_subset'))).toContain('named subset "django-50-v2" · 50/500')
    expect(formatEvaluatedSliceLabel(slice('sampled'))).toContain('30/500 · seed 42 · stratified by repository · filters language=python')
    expect(EvaluatedSliceSchema.safeParse({ ...slice(), selectedItems: 499 }).success).toBe(false)
    expect(EvaluatedSliceSchema.safeParse({ ...slice('sampled'), coverageRatio: 1 }).success).toBe(false)
  })

  it('binds every selection kind to an immutable task-ID manifest', () => {
    const full = slice()
    expect(EvaluatedSliceSchema.safeParse({ ...full, selectionSpec: { kind: 'full', taskIdsHash: 'b'.repeat(64) } }).success).toBe(false)
    expect(EvaluatedSliceSchema.safeParse({ ...slice('named_subset'), selectionSpec: { kind: 'explicit_ids', taskIdsHash: HASH } }).success).toBe(false)
    expect(EvaluatedSliceSchema.safeParse({ ...slice('sampled'), selectionSpec: { kind: 'sampled', taskIdsHash: HASH, sample: { count: 30, seed: 42, stratification: 'repository' }, filters: {} } }).success).toBe(true)
    expect(EvaluatedSliceSchema.safeParse({ ...slice('sampled'), selectionSpec: { kind: 'sampled', taskIdsHash: HASH, sample: { count: 29, seed: 42, stratification: 'repository' }, filters: {} } }).success).toBe(false)
  })

  it('rejects smoke, incomplete, and non-official evidence from official ranking', () => {
    expect(LeaderboardEntrySchema.safeParse(leaderboardEntry()).success).toBe(true)
    expect(LeaderboardEntrySchema.safeParse(leaderboardEntry({ evidenceLevel: 'smoke' })).success).toBe(false)
    expect(LeaderboardEntrySchema.safeParse(leaderboardEntry({ completedTrials: 1499 })).success).toBe(false)
    expect(LeaderboardEntrySchema.safeParse(leaderboardEntry({ evidenceLevel: 'native' })).success).toBe(false)
  })

  it('enforces the complete Leaderboard eligibility and comparability identity matrix', () => {
    const eligible = LeaderboardEntrySchema.parse(leaderboardEntry())
    const rejected = [
      leaderboardEntry({ evidenceLevel: 'smoke' }),
      leaderboardEntry({ evidenceLevel: 'native' }),
      leaderboardEntry({ completedTrials: 1499 }),
      leaderboardEntry({ repeats: 0 }),
      leaderboardEntry({ verifierVersion: '' }),
      leaderboardEntry({ agent: { type: 'custom-command', version: '1', configHash: HASH } }),
      leaderboardEntry({ agent: { type: 'smoke', version: '1', configHash: HASH } }),
    ]
    expect(rejected.every((entry) => !LeaderboardEntrySchema.safeParse(entry).success)).toBe(true)

    const identities = [
      leaderboardEntry({ entryId: 'different-verifier', verifierVersion: '2' }),
      leaderboardEntry({ entryId: 'different-repeat-policy', repeatPolicyHash: 'c'.repeat(64) }),
      leaderboardEntry({ entryId: 'different-dataset-version', evaluatedSlice: { ...slice(), dataset: { ...slice().dataset, version: '2' } } }),
      leaderboardEntry({ entryId: 'different-slice', evaluatedSlice: { ...slice(), sliceId: 'other-slice', sliceManifestHash: 'd'.repeat(64) } }),
    ].map((entry) => LeaderboardEntrySchema.parse(entry))
    expect(identities.map((entry) => areRankComparable(eligible, entry))).toEqual([false, false, false, false])
    expect(new Set([eligible, ...identities].map(leaderboardComparabilityKey))).toHaveLength(5)
  })

  it('never treats unlike slice manifests as rank comparable', () => {
    const full = LeaderboardEntrySchema.parse(leaderboardEntry())
    const subset = LeaderboardEntrySchema.parse(leaderboardEntry({ entryId: 'entry-2', evaluatedSlice: slice('named_subset'), completedTrials: 150, expectedTrials: 150 }))
    expect(areRankComparable(full, subset)).toBe(false)
    expect(areRankComparable(full, structuredClone(full))).toBe(true)
    expect(leaderboardComparabilityKey(full)).not.toBe(leaderboardComparabilityKey(subset))
  })

  it('versions Leaderboard filters, sort, audit, and invalidation as protocol contracts', () => {
    const entry = LeaderboardEntrySchema.parse(leaderboardEntry())
    expect(leaderboardCompetitorKey(entry)).toContain(leaderboardComparabilityKey(entry))
    expect(leaderboardCompetitorKey(entry)).not.toBe(leaderboardCompetitorKey(LeaderboardEntrySchema.parse(leaderboardEntry({ model: { modelId: 'model-b', modelVersion: '1' } }))))
    expect(EvaluationQuerySchema.parse({ resource: 'leaderboard', pivot: 'model', sliceManifestHash: HASH, view: 'audit', agentType: 'codex', modelId: 'model-a', sortBy: 'cost', sortDirection: 'asc', page: { limit: 100 } })).toMatchObject({ view: 'audit', sortBy: 'cost', sortDirection: 'asc' })
    expect(EvaluationQuerySchema.parse({ resource: 'capability-vectors', runId: 'run-one', agentVariantId: 'codex-one', methodologyVersion: '1.0.0', page: { limit: 100 } })).toMatchObject({ resource: 'capability-vectors', runId: 'run-one', agentVariantId: 'codex-one' })
    expect(EvaluationQuerySchema.safeParse({ resource: 'leaderboard', pivot: 'model', sliceManifestHash: 'not-a-hash', page: { limit: 100 } }).success).toBe(false)
    expect(EvaluationCommandSchema.safeParse({ schemaVersion: 1, type: 'leaderboard.invalidate', commandId: 'invalidate-one', idempotencyKey: 'invalidate-one', submittedAt: '2026-08-03T00:00:00.000Z', entryId: 'entry-1', reason: 'verifier defect' }).success).toBe(true)
    expect(EvaluationCommandSchema.safeParse({ schemaVersion: 1, type: 'leaderboard.invalidate', commandId: 'invalidate-one', idempotencyKey: 'invalidate-one', submittedAt: '2026-08-03T00:00:00.000Z', entryId: 'entry-1', reason: '' }).success).toBe(false)
  })

  it('property-checks every slice kind, truthful coverage, and sample provenance', () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 10_000 }),
      fc.integer({ min: 1, max: 9_999 }),
      fc.integer(),
      (total, requested, seed) => {
        const selected = Math.min(requested, total - 1)
        const sampled = { ...slice('sampled'), dataset: { ...slice('sampled').dataset, totalItems: total }, selectedItems: selected, coverageRatio: selected / total, selectionSpec: { kind: 'sampled' as const, taskIdsHash: HASH, sample: { count: selected, seed, stratification: 'repository' }, filters: { language: 'python' } } }
        const parsed = EvaluatedSliceSchema.parse(sampled)
        expect(formatEvaluatedSliceLabel(parsed)).toContain(String(selected) + '/' + String(total) + ' · seed ' + String(seed))
        expect(EvaluatedSliceSchema.safeParse({ ...sampled, coverageRatio: sampled.coverageRatio + 0.001 }).success).toBe(false)
      },
    ), { numRuns: 300 })
    for (const [kind, selectionSpec] of [
      ['full', { kind: 'full', taskIdsHash: HASH }],
      ['official_subset', { kind: 'official_subset', officialSubsetId: 'lite', taskIdsHash: HASH }],
      ['named_subset', { kind: 'named_subset', namedSubsetId: 'named-v1', taskIdsHash: HASH }],
      ['explicit_ids', { kind: 'explicit_ids', taskIdsHash: HASH }],
    ] as const) {
      const total = 10; const selected = kind === 'full' ? total : 3
      expect(EvaluatedSliceSchema.safeParse({ ...slice(), sliceId: kind + '-property', dataset: { ...slice().dataset, totalItems: total }, selectionKind: kind, selectionSpec, selectedItems: selected, coverageRatio: selected / total }).success).toBe(true)
    }
  })
})

describe('durable and governance contracts', () => {
  it('requires contained artifact paths, unique entries, and valid leases', () => {
    expect(RelativeArtifactPathSchema.safeParse('../secret').success).toBe(false)
    expect(RelativeArtifactPathSchema.safeParse('/etc/passwd').success).toBe(false)
    expect(RelativeArtifactPathSchema.safeParse('trials/a/result.json').success).toBe(true)
    const entry = { artifactId: 'result', path: 'result.json', mediaType: 'application/json', bytes: 2, sha256: HASH, redaction: 'passed', classification: 'operator' }
    expect(ArtifactManifestSchema.safeParse({ schemaVersion: 1, runId: 'run', trialId: 'trial', leaseId: 'lease', generatedAt: '2026-08-03T00:00:00.000Z', entries: [entry, entry], manifestHash: HASH }).success).toBe(false)
    expect(TrialLeaseSchema.safeParse({ schemaVersion: 1, leaseId: 'lease', runId: 'run', trialId: 'trial', attempt: 1, workerId: 'worker', specHash: HASH, issuedAt: '2026-08-03T01:00:00.000Z', expiresAt: '2026-08-03T00:00:00.000Z', commitToken: 'x'.repeat(32) }).success).toBe(false)
  })

  it('requires monotonic durable events', () => {
    const event = (sequence: number, state: 'draft' | 'validating'): EvaluationEvent => EvaluationEventSchema.parse({ schemaVersion: 1, sequence, at: '2026-08-03T00:00:00.000Z', runId: 'run', type: 'run.state', producer: 'control-plane', data: { state } })
    expect(() => assertMonotonicEvents([event(0, 'draft'), event(1, 'validating')])).not.toThrow()
    expect(() => assertMonotonicEvents([event(0, 'draft'), { ...event(1, 'validating'), sequence: 2 }])).toThrow('not contiguous')
  })

  it('replays only legal typed run/trial state transitions', () => {
    const envelope = { schemaVersion: 1 as const, at: '2026-08-03T00:00:00.000Z', runId: 'run', producer: 'control-plane' as const }
    const events = [
      { ...envelope, sequence: 0, type: 'run.state' as const, data: { state: 'draft' as const } },
      { ...envelope, sequence: 1, type: 'trial.created' as const, trialId: 'trial', data: { trialId: 'trial', taskId: 'task', agentVariantId: 'agent', backendId: 'agent-runlab' as const, sandboxProvider: 'docker' as const, repeatIndex: 0 } },
      { ...envelope, sequence: 2, type: 'trial.state' as const, trialId: 'trial', data: { trialId: 'trial', state: 'leased' as const } },
      { ...envelope, sequence: 3, type: 'run.state' as const, data: { state: 'validating' as const } },
    ]
    expect(replayEvaluationEvents(events)).toMatchObject({ runState: 'validating', trials: { trial: { state: 'leased' } } })
    expect(() => replayEvaluationEvents([...events.slice(0, 2), { ...events[2], data: { trialId: 'trial', state: 'completed' } }])).toThrow('invalid trial state transition')
    expect(EvaluationEventSchema.safeParse({ ...events[2], data: { trialId: 'other', state: 'leased' } }).success).toBe(false)
  })

  it('property-checks reducer replay determinism and rejects every sequence corruption', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), (count) => {
      const envelope = { schemaVersion: 1 as const, at: '2026-08-03T00:00:00.000Z', runId: 'property-run', producer: 'control-plane' as const }
      const events: EvaluationEvent[] = [EvaluationEventSchema.parse({ ...envelope, sequence: 0, type: 'run.state', data: { state: 'draft' } })]
      for (let index = 0; index < count; index += 1) events.push(EvaluationEventSchema.parse({ ...envelope, sequence: events.length, type: 'trial.created', trialId: 'trial-' + String(index), data: { trialId: 'trial-' + String(index), taskId: 'task-' + String(index), agentVariantId: 'agent', backendId: 'agent-runlab', sandboxProvider: 'docker', repeatIndex: index } }))
      const first = replayEvaluationEvents(events)
      expect(replayEvaluationEvents(structuredClone(events))).toEqual(first)
      const corrupted = structuredClone(events); corrupted.at(-1)!.sequence += 1
      expect(() => replayEvaluationEvents(corrupted)).toThrow('not contiguous')
    }), { numRuns: 200 })
  })

  it('negotiates protocol capabilities and rejects incompatible descriptors', () => {
    expect(negotiateProtocolVersion([1, 3], [2, 3])).toBe(3)
    expect(() => negotiateProtocolVersion([1], [2])).toThrow('no compatible')
    expect(AgentBackendDescriptorSchema.safeParse({ schemaVersion: 1, protocolVersions: [], id: 'codex', label: 'Codex', version: '1', configSchemaVersion: 1, ranked: true, evidenceLevel: 'native', capabilities: { nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true, absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: true, finalDiff: true, usage: 'available' } }).success).toBe(false)
  })

  it('accepts namespaced external plugins while keeping external Agents unranked and non-official', async () => {
    const capabilities = { nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true, absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: true, finalDiff: true, usage: 'unavailable_explicit' as const }
    expect(AgentBackendDescriptorSchema.safeParse({ schemaVersion: 1, protocolVersions: [1], id: 'acme-agent', label: 'ACME Agent', version: '1', configSchemaVersion: 1, ranked: false, evidenceLevel: 'native', capabilities }).success).toBe(true)
    expect(AgentBackendDescriptorSchema.safeParse({ schemaVersion: 1, protocolVersions: [1], id: 'acme-agent', label: 'ACME Agent', version: '1', configSchemaVersion: 1, ranked: true, evidenceLevel: 'native', capabilities }).success).toBe(false)
    expect(BenchmarkDescriptorSchema.safeParse({ schemaVersion: 1, protocolVersions: [1], id: 'acme-task-pack', label: 'ACME Task Pack', version: '1', official: false, nativePrimaryMetric: 'passed', verifierId: 'acme-verifier', verifierVersion: '1' }).success).toBe(true)
    const external = structuredClone(await fixture()) as any
    external.runId = 'external-run'
    external.agents[0]!.backendId = 'acme-agent'
    external.verification.officialRequired = false
    expect(EvaluationRunSpecSchema.safeParse(external).success).toBe(true)
    external.verification.officialRequired = true
    expect(EvaluationRunSpecSchema.safeParse(external).success).toBe(false)
  })

  it('migrates only canonical platform schemas through explicit forward steps', () => {
    const v2 = { parse: (value: unknown) => {
      const record = value as { schemaVersion?: unknown; id?: unknown; label?: unknown }
      if (record.schemaVersion !== 2 || typeof record.id !== 'string' || typeof record.label !== 'string') throw new Error('invalid v2 fixture')
      return record as { schemaVersion: 2; id: string; label: string }
    } }
    const migrations = [{ from: 1, to: 2, migrate: (value: unknown) => ({ ...(value as object), schemaVersion: 2, label: 'canonical' }), target: v2 }]
    expect(migrateCanonicalProtocol({ schemaVersion: 1, id: 'run' }, 2, migrations)).toEqual({ schemaVersion: 2, id: 'run', label: 'canonical' })
    expect(migrateCanonicalProtocol({ schemaVersion: 2, id: 'run', label: 'already-current' }, 2, migrations)).toEqual({ schemaVersion: 2, id: 'run', label: 'already-current' })
    expect(() => migrateCanonicalProtocol({ schemaVersion: 0, benchmark: 'legacy-host' }, 2, migrations)).toThrow('supported schemaVersion')
    expect(() => migrateCanonicalProtocol({ schemaVersion: 1, id: 'run' }, 3, migrations)).toThrow('no canonical protocol migration path')
  })

  it('requires explicit review, redaction evidence, and provenance approval for private public task packs', () => {
    const base = {
      schemaVersion: 1, taskId: 'private-candidate', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Private candidate', prompt: 'Verify governance.',
      repository: { kind: 'artifact', archiveRef: 'fixtures/task.tar', archiveSha256: 'a'.repeat(64), revision: 'fixture-v1' }, fixtureManifestHash: 'b'.repeat(64), faultScenarioIds: [],
      verification: [{ stepId: 'verify', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] },
      policy: grantedPolicy(), publication: { sourceClassification: 'private_workspace', publicTaskPack: true },
    }
    expect(ResolvedTaskSchema.safeParse(base).success).toBe(false)
    expect(ResolvedTaskSchema.safeParse({ ...base, publication: { ...base.publication, operatorReview: { operatorId: 'local-operator', reviewedAt: '2026-08-03T00:00:00.000Z', redactionPassed: true, redactionEvidenceHash: 'c'.repeat(64), provenanceApproved: true, provenanceRefs: ['session:private-candidate'] } } }).success).toBe(true)
  })

  it('enforces structured failure responsibility and typed reproduction execution', () => {
    const failure = { schemaVersion: 1, category: 'environment_failure', responsibility: 'environment', code: 'DISK_FULL', summary: 'sandbox disk full', retryable: true, observedStateSufficientForRecovery: true, evidenceRefs: ['trace#1'] }
    expect(NormalizedFailureSchema.safeParse(failure).success).toBe(true)
    expect(NormalizedFailureSchema.safeParse({ ...failure, responsibility: 'agent' }).success).toBe(false)
    expect(NormalizedFailureSchema.safeParse({ ...failure, category: 'indeterminate_side_effect', responsibility: 'indeterminate', retryable: true }).success).toBe(false)
    expect(ReproductionTaskContractSchema.safeParse({ schemaVersion: 1, taskId: 'task', reproduction: { argv: ['sh', '-c', 'exit 2'], expectedExitCode: 2, stderrIncludes: 'failure', failureFingerprintSource: 'failure' } }).success).toBe(true)
    expect(ReproductionTaskContractSchema.safeParse({ schemaVersion: 1, taskId: 'task', reproduction: { argv: [], expectedExitCode: 2, stderrIncludes: 'failure', failureFingerprintSource: 'failure' } }).success).toBe(false)
  })

  it('enforces controlled trace hierarchy and six independent platform SLO statuses', () => {
    const refs = { runId: 'run', trialId: 'trial', backendId: 'codex', taskId: 'task' }
    const names = ['evaluation.run', 'evaluation.trial', 'environment.prepare', 'agent.execute', 'workspace.snapshot', 'verifier.execute'] as const
    const spans = names.map((name, index) => ({ schemaVersion: 1 as const, traceId: 'trace', spanId: 'span-' + String(index), ...(index > 0 ? { parentSpanId: 'span-0' } : {}), name, startedAt: '2026-08-03T00:00:00.000Z', completedAt: '2026-08-03T00:00:01.000Z', status: 'ok' as const, refs, artifactRefs: [] }))
    expect(TrialTraceSchema.parse({ schemaVersion: 1, traceId: 'trace', runId: 'run', trialId: 'trial', spans }).spans).toHaveLength(6)
    expect(TrialTraceSchema.safeParse({ schemaVersion: 1, traceId: 'trace', runId: 'run', trialId: 'trial', spans: spans.filter((span) => span.name !== 'verifier.execute') }).success).toBe(false)
    const cyclic = spans.map((span, index) => index === 1 ? { ...span, parentSpanId: 'span-2' } : index === 2 ? { ...span, parentSpanId: 'span-1' } : span)
    expect(TrialTraceSchema.safeParse({ schemaVersion: 1, traceId: 'trace', runId: 'run', trialId: 'trial', spans: cyclic }).success).toBe(false)
    const sloIds = ['restart-durability', 'duplicate-commit-prevention', 'bounded-cancellation', 'manifest-integrity', 'infrastructure-attribution', 'official-ingest-authority']
    expect(PlatformMetricsSnapshotSchema.safeParse({ schemaVersion: 1, generatedAt: '2026-08-03T00:00:01.000Z', observationStartedAt: '2026-08-03T00:00:00.000Z', queue: { queuedTrials: 0, oldestAgeMs: 0 }, workers: { registered: 1, activeLeases: 0, trialCapacity: 1, utilization: 0 }, environmentPreparation: { count: 1, p50Ms: 10, p95Ms: 10, maxMs: 10 }, firstModelCall: { count: 0, p50Ms: null, p95Ms: null, maxMs: null }, modelCalls: { count: 0, p50Ms: null, p95Ms: null, maxMs: null }, toolCalls: { count: 0, p50Ms: null, p95Ms: null, maxMs: null, failuresByCategory: {} }, artifacts: { uploadFailures: 0, manifestsVerified: 1, manifestFailures: 0 }, grader: { completed: 1, failed: 0, failureRate: 0 }, orchestrator: { lastRecoveryMs: 2, journalTransactions: 4 }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, tokensPerSecond: 1, costUsdPerHour: 0.1 }, terminalOutcomes: { completed: 1 }, flakes: { taskRate: 0, verifierRate: 0, flakyTasks: 0, evaluatedTasks: 1 }, traceCoverage: { trialsWithTrace: 1, completedTrials: 1 }, slos: sloIds.map((id) => ({ id, status: 'meeting', target: 'target', observed: 'observed', evidenceRefs: [] })) }).success).toBe(true)
  })

  it('attributes Agent responsibility only when observable state supports a safer recovery choice', () => {
    expect(decideFailureResponsibility({ category: 'invalid_action', origin: 'agent', observedStateSufficientForRecovery: true, sideEffectMayHaveOccurred: false, retryRequested: false })).toEqual({ category: 'invalid_action', responsibility: 'agent', observedStateSufficientForRecovery: true, retryable: false })
    expect(decideFailureResponsibility({ category: 'agent_failure', origin: 'agent', observedStateSufficientForRecovery: false, sideEffectMayHaveOccurred: true, retryRequested: true })).toEqual({ category: 'indeterminate_side_effect', responsibility: 'indeterminate', observedStateSufficientForRecovery: false, retryable: false })
    expect(decideFailureResponsibility({ category: 'provider_failure', origin: 'provider', observedStateSufficientForRecovery: true, sideEffectMayHaveOccurred: false, retryRequested: true })).toMatchObject({ category: 'provider_failure', responsibility: 'provider', retryable: true })
    expect(decideFailureResponsibility({ category: 'environment_failure', origin: 'environment', observedStateSufficientForRecovery: false, sideEffectMayHaveOccurred: false, retryRequested: true })).toMatchObject({ category: 'environment_failure', responsibility: 'environment', observedStateSufficientForRecovery: false })
    expect(decideFailureResponsibility({ category: 'verifier_failure', origin: 'verifier', observedStateSufficientForRecovery: true, sideEffectMayHaveOccurred: false, retryRequested: true })).toMatchObject({ category: 'verifier_failure', responsibility: 'verifier' })
  })

  it('blocks unsafe reproduction publication, incomplete reports, and unsupported validated insights', () => {
    const reproduction = { schemaVersion: 1, bundleId: 'bundle', findingId: 'finding', failureFingerprint: HASH, environmentLockHash: HASH, files: [], reproduction: { attempts: [], reproduced: 0, expectedSuccessControl: { freshEnvironmentId: 'control', environmentLockHash: HASH, passed: true, evidenceRefs: ['control'] }, minimization: { originalUnits: 1, minimizedUnits: 1, attempts: 1 } }, privacy: { redactionPassed: true, secretScanPassed: false, absolutePathScanPassed: true }, signedPayloadHash: HASH, signature: { algorithm: 'ed25519', keyReference: 'local-key', valueBase64: 'signature' } }
    expect(ReproductionBundleSchema.safeParse(reproduction).success).toBe(false)
    expect(ReportManifestSchema.safeParse({ schemaVersion: 1, reportId: 'report', inputEvidenceHash: HASH, runRefs: ['run'], formats: [], methodologyVersion: '1', includesAllConfiguredRepeats: true, redactionPassed: true, generatedAt: '2026-08-03T00:00:00.000Z' }).success).toBe(false)
    expect(ProductInsightSchema.safeParse({ schemaVersion: 1, insightId: 'insight', evidenceRefs: ['finding'], failureCluster: 'cluster', affectedTaskRate: 0.1, severity: 'high', suspectedLayer: 'tool', confidence: 0.9, recommendation: 'change tool contract', expectedMetric: 'recovery', regressionPackId: 'pack', owner: 'platform', status: 'validated', postFixValidationRefs: [] }).success).toBe(false)
  })

  it('contains no Node imports in production protocol sources', async () => {
    const names = (await readdir(root)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    const sources = await Promise.all(names.map((name) => readFile(join(root, name), 'utf8')))
    expect(sources.join('\n')).not.toMatch(/from ['"]node:/u)
  })
})

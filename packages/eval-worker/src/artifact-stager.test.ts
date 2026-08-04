import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ArtifactStager } from './artifact-stager.js'

const signer = { keyReference: 'fixture-key', validate: async () => undefined, signSha256: async () => ({ algorithm: 'ed25519' as const, keyReference: 'fixture-key', valueBase64: 'fixture-signature' }) }

describe('ArtifactStager privacy boundary', () => {
  it('redacts referenced and generic secrets from failure artifacts and hashes the redacted result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-artifacts-'))
    const stager = new ArtifactStager(root, signer)
    const staged = await stager.stageFailure({
      runId: 'run', trialId: 'trial', leaseId: 'lease', at: '2026-08-03T00:00:00.000Z',
      state: 'agent_error', code: 'AGENT_ERROR',
      message: 'token super-secret-value in /home/example/private/repo and api_key=sk_fixture_123456789012',
      failure: { schemaVersion: 1, category: 'agent_failure', responsibility: 'agent', code: 'AGENT_ERROR', summary: 'token super-secret-value in /home/example/private/repo', retryable: false, observedStateSufficientForRecovery: true, evidenceRefs: ['trial:trial/failure.json'] },
      secrets: ['super-secret-value'],
    })
    await stager.verify(staged)
    const body = await readFile(join(staged.root, 'failure.json'), 'utf8')
    expect(body).not.toContain('super-secret-value')
    expect(body).not.toContain('/home/example')
    expect(body).not.toContain('sk_fixture')
    expect(body).toContain('[REDACTED]')
    expect(body).toContain('[PRIVATE_PATH]')
  })

  it('imports only regular allowlisted files contained by the provider artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-artifacts-'))
    const source = join(root, 'provider')
    await mkdir(source)
    const seededSecret = 'seeded-native-artifact-secret'
    await writeFile(join(source, 'allowed.log'), 'evidence ' + seededSecret)
    await writeFile(join(source, 'binary.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(seededSecret)]))
    await writeFile(join(root, 'secret'), 'must-not-read')
    await symlink(join(root, 'secret'), join(source, 'linked.log'))
    const stager = new ArtifactStager(join(root, 'staged'), signer)
    const base = {
      runId: 'run', trialId: 'trial', leaseId: 'lease',
      agentArtifacts: { completedAt: '2026-08-03T00:00:00.000Z', finalDiff: '', nativeEvents: [], normalizedEvents: [], stdout: '', stderr: '', usage: { availability: 'unavailable' as const, reason: 'fixture' }, version: '1', configHash: 'a'.repeat(64), extraArtifactPaths: [] },
      verification: { result: { schemaVersion: 1 as const, benchmarkId: 'swe-bench' as const, verifierId: 'verifier', verifierVersion: '1', nativeMetrics: {}, rawResultRef: 'verifier-result.json', officialEvidence: true }, stdout: '', stderr: '', artifactPaths: [] },
      analyzerInput: { schemaVersion: 1 as const, runId: 'run', trialId: 'trial', taskId: 'task', traceHash: 'b'.repeat(64), projectionHash: 'c'.repeat(64), normalizationVersion: 'fixture-v1', events: [], constraints: [], constraintLifecycle: [], memoryProbes: [], toolAttempts: [], planSteps: [], workspaceIntegrity: { changedPaths: [], deletedPaths: [], protectedPaths: [], hiddenVerifierPaths: [], verifierLeakagePaths: [], suspiciousLiteralEvidenceRefs: [] }, verifierIntegrity: { passed: true, protectedIntegrityPassed: true, hiddenVerifierPassed: true, selectedTestFraction: 1, evidenceRefs: ['verifier-result.json'] }, inputManifestHash: 'a'.repeat(64) },
      trace: { schemaVersion: 1 as const, traceId: 'trace', runId: 'run', trialId: 'trial', spans: [
        { schemaVersion: 1 as const, traceId: 'trace', spanId: 'run', name: 'evaluation.run' as const, startedAt: '2026-08-03T00:00:00.000Z', completedAt: '2026-08-03T00:00:00.000Z', status: 'ok' as const, refs: { runId: 'run', trialId: 'trial', backendId: 'agent', taskId: 'task' }, artifactRefs: [] },
        ...['evaluation.trial', 'environment.prepare', 'agent.execute', 'workspace.snapshot', 'verifier.execute'].map((name, index) => ({ schemaVersion: 1 as const, traceId: 'trace', spanId: 'span-' + String(index), parentSpanId: 'run', name: name as 'evaluation.trial', startedAt: '2026-08-03T00:00:00.000Z', completedAt: '2026-08-03T00:00:00.000Z', status: 'ok' as const, refs: { runId: 'run', trialId: 'trial', backendId: 'agent', taskId: 'task' }, artifactRefs: [] })),
      ] },
      workspaceBefore: { snapshotId: 'before', createdAt: '2026-08-03T00:00:00.000Z', manifestHash: 'a'.repeat(64), files: [] },
      workspaceAfter: { snapshotId: 'after', createdAt: '2026-08-03T00:00:00.000Z', manifestHash: 'a'.repeat(64), files: [] },
      evidence: { schemaVersion: 1 as const, runId: 'run', trialId: 'trial', agentVariantId: 'agent', taskId: 'task', repeatIndex: 0, environmentLock: { schemaVersion: 1 as const, provider: 'docker' as const, imageDigest: 'sha256:fixture', repositoryRevision: 'revision', dependencyLockHashes: {}, redactedEnvironment: {}, resourcePolicyHash: 'a'.repeat(64), networkPolicyHash: 'b'.repeat(64), toolchainVersions: {}, fixtureVersions: {}, faultInjectorVersions: {} }, nativeEventsRef: 'run/trial/native-events.jsonl', normalizedEventsRef: 'run/trial/normalized-events.jsonl', traceRef: 'run/trial/trace.jsonl', normalizedEventCount: 0, analyzerInputRef: 'run/trial/analyzer-input.json', finalDiffRef: 'run/trial/final.diff', stdoutRef: 'run/trial/stdout.log', stderrRef: 'run/trial/stderr.log', usage: { availability: 'unavailable' as const, reason: 'fixture' }, benchmarkResult: { schemaVersion: 1 as const, benchmarkId: 'swe-bench' as const, verifierId: 'verifier', verifierVersion: '1', nativeMetrics: {}, rawResultRef: 'run/trial/verifier-result.json', officialEvidence: true }, evidenceLevel: 'native' as const },
    }
    const staged = await stager.stage({ ...base, secrets: [seededSecret], importedArtifacts: { root: source, paths: ['allowed.log'], allowlist: ['allowed.log'] } })
    expect(await readFile(join(staged.root, 'extra', 'allowed.log'), 'utf8')).toBe('evidence [REDACTED]')
    expect(staged.artifactManifest.entries.find((entry) => entry.path.endsWith('allowed.log'))?.redaction).toBe('passed')
    const evidenceFor = (trialId: string) => { const prefix = 'run/' + trialId + '/'; return { ...base.evidence, trialId, nativeEventsRef: prefix + 'native-events.jsonl', normalizedEventsRef: prefix + 'normalized-events.jsonl', traceRef: prefix + 'trace.jsonl', analyzerInputRef: prefix + 'analyzer-input.json', finalDiffRef: prefix + 'final.diff', stdoutRef: prefix + 'stdout.log', stderrRef: prefix + 'stderr.log', benchmarkResult: { ...base.evidence.benchmarkResult, rawResultRef: prefix + 'verifier-result.json' } } }
    await expect(stager.stage({ ...base, trialId: 'trial-two', evidence: evidenceFor('trial-two'), importedArtifacts: { root: source, paths: ['../secret'], allowlist: ['../secret'] } })).rejects.toThrow('contained and relative')
    await expect(stager.stage({ ...base, trialId: 'trial-three', evidence: evidenceFor('trial-three'), importedArtifacts: { root: source, paths: ['linked.log'], allowlist: ['linked.log'] } })).rejects.toThrow('non-symlink')
    await expect(stager.stage({ ...base, trialId: 'trial-four', evidence: evidenceFor('trial-four'), importedArtifacts: { root: source, paths: ['allowed.log'], allowlist: [] } })).rejects.toThrow('not allowlisted')
    await expect(stager.stage({ ...base, trialId: 'trial-five', evidence: evidenceFor('trial-five'), secrets: [seededSecret], importedArtifacts: { root: source, paths: ['binary.dat'], allowlist: ['binary.dat'] } })).rejects.toThrow('binary artifact contains a seeded secret')
  })
})

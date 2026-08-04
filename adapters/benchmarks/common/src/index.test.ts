import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'
import { BenchmarkDescriptorSchema, ResolvedTaskSchema } from '@agent-kernel/eval-protocol'
import { DeclarativeBenchmarkAdapter, allStepsMetrics } from './index.js'

const HASH = 'a'.repeat(64)
const execFileAsync = promisify(execFile)
describe('DeclarativeBenchmarkAdapter', () => {
  it('preserves emitted native metrics and writes a benchmark-native result', async () => {
    const adapter = new DeclarativeBenchmarkAdapter({ descriptor: BenchmarkDescriptorSchema.parse({ schemaVersion: 1, id: 'code-understanding', label: 'Code Understanding', version: '1', official: false, nativePrimaryMetric: 'file_recall_at_k', verifierId: 'localization-verifier', verifierVersion: '1' }), taskPackId: 'code-understanding', failureCode: 'LOCALIZATION_FAILED', failureSummary: 'localization failed', deriveMetrics: (steps) => allStepsMetrics('file_recall_at_k', steps) })
    const task = ResolvedTaskSchema.parse({ schemaVersion: 1, taskId: 'task', taskPackId: 'code-understanding', taskPackVersion: '1', title: 'Locate symbol', prompt: 'Locate it', repository: { kind: 'artifact', archiveRef: 'fixture.tar', archiveSha256: HASH, revision: '1' }, fixtureManifestHash: HASH, faultScenarioIds: [], verification: [{ stepId: 'localize', argv: ['verify'], cwd: '.', timeoutMs: 100, requiredExitCode: 0, nativeMetric: 'file_recall_at_k' }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:benchmark-common'] }, publication: { artifact: { status: 'granted', basis: 'test fixture' }, report: { status: 'granted', basis: 'test fixture' }, leaderboard: { status: 'granted', basis: 'test fixture' }, redistribution: { status: 'granted', basis: 'MIT' } } } })
    const calls: unknown[] = []
    const sandbox = { sandboxId: 's', descriptor: { schemaVersion: 1 as const, providerId: 'fixture', kind: 'docker' as const, version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace', execute: async (request: unknown) => { calls.push(request); return { exitCode: 0, stdout: calls.length === 1 ? '{"metrics":{"file_recall_at_k":0.75}}\n' : '', stderr: '', startedAt: '', completedAt: '', timedOut: false } }, putArchive: async () => undefined, getArchive: async () => undefined, snapshot: async () => ({ snapshotId: 's', createdAt: '', manifestHash: HASH, files: [] }) }
    const output = await adapter.verify({ runId: 'run', trialId: 'trial', task, sandbox, agentArtifacts: { completedAt: '', finalDiff: '', nativeEvents: [], normalizedEvents: [], stdout: '', stderr: '', usage: { availability: 'unavailable', reason: 'fixture' }, version: '1', configHash: HASH, extraArtifactPaths: [] }, agentVariant: { variantId: 'a', backendId: 'codex', agentVersion: '1', model: { modelId: 'm' }, configHash: HASH, config: {}, credentialRefs: [] }, signal: new AbortController().signal })
    expect(output.result.nativeMetrics.file_recall_at_k).toBe(0.75)
    expect(output.artifactPaths).toHaveLength(1)
  })

  it('lets the verifier read a repository owned by a different sandbox user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-verifier-git-owner-'))
    const workspace = join(root, 'workspace')
    try {
      await execFileAsync('git', ['init', '-q', workspace])
      await writeFile(join(workspace, 'fixture.txt'), 'owned by Agent user\n')
      await execFileAsync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=user5@example.com', 'add', 'fixture.txt'])
      await execFileAsync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=user5@example.com', 'commit', '-qm', 'fixture'])
      const { stdout: revision } = await execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD'])
      await expect(execFileAsync('git', ['-C', workspace, 'status', '--porcelain'], { env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } })).rejects.toThrow()

      const adapter = new DeclarativeBenchmarkAdapter({ descriptor: BenchmarkDescriptorSchema.parse({ schemaVersion: 1, id: 'code-understanding', label: 'Code Understanding', version: '1', official: false, nativePrimaryMetric: 'repository_readable', verifierId: 'ownership-verifier', verifierVersion: '1' }), taskPackId: 'code-understanding', failureCode: 'REPOSITORY_UNREADABLE', failureSummary: 'repository unreadable', deriveMetrics: (steps) => allStepsMetrics('repository_readable', steps) })
      const task = ResolvedTaskSchema.parse({ schemaVersion: 1, taskId: 'ownership', taskPackId: 'code-understanding', taskPackVersion: '1', title: 'Ownership fixture', prompt: 'Verify repository', repository: { kind: 'artifact', archiveRef: 'fixture.tar', archiveSha256: HASH, revision: revision.trim() }, fixtureManifestHash: HASH, faultScenarioIds: [], verification: [{ stepId: 'repository-readable', argv: ['git', 'diff', '--exit-code', 'HEAD', '--', 'fixture.txt'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0, nativeMetric: 'repository_readable' }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:benchmark-common'] }, publication: { artifact: { status: 'granted', basis: 'test fixture' }, report: { status: 'granted', basis: 'test fixture' }, leaderboard: { status: 'granted', basis: 'test fixture' }, redistribution: { status: 'granted', basis: 'MIT' } } } })
      const execute = async (request: { argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }) => {
        if (request.argv[0] === 'sh' && request.argv[2]?.includes('/artifacts/')) return { exitCode: 0, stdout: '', stderr: '', startedAt: '', completedAt: '', timedOut: false }
        try {
          const result = await execFileAsync(request.argv[0]!, [...request.argv.slice(1)], { cwd: request.cwd, env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', ...request.env } })
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, startedAt: '', completedAt: '', timedOut: false }
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string }
          return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error), startedAt: '', completedAt: '', timedOut: false }
        }
      }
      const sandbox = { sandboxId: 'ownership', descriptor: { schemaVersion: 1 as const, providerId: 'fixture', kind: 'lxd-container' as const, version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: workspace, execute, putArchive: async () => undefined, getArchive: async () => undefined, snapshot: async () => ({ snapshotId: 's', createdAt: '', manifestHash: HASH, files: [] }) }

      const output = await adapter.verify({ runId: 'run', trialId: 'ownership', task, sandbox, agentArtifacts: { completedAt: '', finalDiff: '', nativeEvents: [], normalizedEvents: [], stdout: '', stderr: '', usage: { availability: 'unavailable', reason: 'fixture' }, version: '1', configHash: HASH, extraArtifactPaths: [] }, agentVariant: { variantId: 'a', backendId: 'claude-code', agentVersion: '1', model: { modelId: 'm' }, configHash: HASH, config: {}, credentialRefs: [] }, signal: new AbortController().signal })
      expect(output.result.nativeMetrics.repository_readable).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

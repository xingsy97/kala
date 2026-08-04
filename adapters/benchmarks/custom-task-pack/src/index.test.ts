import { describe, expect, it, vi } from 'vitest'
import { createCustomTaskPackAdapter } from './index.js'

const HASH = 'a'.repeat(64)
const task = { schemaVersion: 1 as const, taskId: 'deterministic-file', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Deterministic file', prompt: 'Create answer.txt.', repository: { kind: 'artifact' as const, archiveRef: 'fixtures/empty.tar', archiveSha256: HASH, revision: 'fixture-v1' }, requiredSandboxImageDigest: 'local:' + HASH, fixtureManifestHash: HASH, faultScenarioIds: [], verification: [{ stepId: 'answer', argv: ['test', '-f', 'answer.txt'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'local evaluation' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:custom-task-pack'] }, publication: { artifact: { status: 'granted', basis: 'test fixture' }, report: { status: 'granted', basis: 'test fixture' }, leaderboard: { status: 'granted', basis: 'test fixture' }, redistribution: { status: 'granted', basis: 'MIT' } } } as const }

describe('CustomTaskPackAdapter', () => {
  it('resolves only custom task-pack tasks', async () => {
    await expect(createCustomTaskPackAdapter().resolveTasks({ tasks: [task] })).resolves.toEqual([task])
  })

  it('preserves declared verifier steps and native result', async () => {
    const execute = vi.fn(async (request: { argv: readonly string[] }) => request.argv[0] === 'test'
      ? { exitCode: 0, stdout: '', stderr: '', timedOut: false, startedAt: '', completedAt: '' }
      : { exitCode: 0, stdout: '', stderr: '', timedOut: false, startedAt: '', completedAt: '' })
    const adapter = createCustomTaskPackAdapter()
    const verified = await adapter.verify({ runId: 'run', trialId: 'trial', task, sandbox: { sandboxId: 'sandbox', descriptor: { schemaVersion: 1, providerId: 'lxd-container', kind: 'lxd-container', version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace', execute, putArchive: vi.fn(), getArchive: vi.fn(), snapshot: vi.fn() }, agentArtifacts: {} as never, agentVariant: {} as never, signal: new AbortController().signal })
    expect(verified.result.nativeMetrics).toMatchObject({ passed: true, passedSteps: 1, totalSteps: 1 })
    expect(verified.result.officialEvidence).toBe(false)
  })
})

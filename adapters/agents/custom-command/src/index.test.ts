import type { AgentRunInput, SandboxExecRequest, SandboxExecutionTarget } from '@agent-kernel/eval-sdk'
import { describe, expect, it, vi } from 'vitest'

import { CustomCommandAgentBackend, evaluationPlugins } from './index.js'

const HASH = 'a'.repeat(64)

describe('CustomCommandAgentBackend', () => {
  it('is a non-ranked public plugin and records command events plus the final diff', async () => {
    const execute = vi.fn(async (request: SandboxExecRequest) => request.argv[0] === 'bash'
      ? result('diff --git a/README.md b/README.md\n')
      : result('worker acceptance\n'))
    const backend = new CustomCommandAgentBackend()
    expect(evaluationPlugins[0]?.descriptor).toMatchObject({ id: 'custom-command', ranked: false })
    const handle = await backend.start(input(execute), new AbortController().signal)
    const events = []
    for await (const event of backend.events(handle)) events.push(event)
    await expect(backend.collect(handle)).resolves.toMatchObject({
      finalResponse: 'worker acceptance\n', finalDiff: 'diff --git a/README.md b/README.md\n',
      normalizedEvents: [{ kind: 'command' }, { kind: 'status' }],
      usage: { availability: 'unavailable' },
    })
    expect(events).toHaveLength(2)
  })

  it('rejects credentials and missing argv during preflight', async () => {
    const backend = new CustomCommandAgentBackend()
    const variant = input(vi.fn()).variant
    const checked = await backend.preflight({ ...variant, config: {}, credentialRefs: [{ referenceId: 'secret', provider: 'example', scope: [] }] })
    expect(checked.ok).toBe(false)
    expect(checked.errors.map((error) => error.code)).toEqual(['CREDENTIALS_UNSUPPORTED', 'INVALID_COMMAND_CONFIG'])
  })
})

function input(execute: SandboxExecutionTarget['execute']): AgentRunInput {
  return {
    runId: 'run', trialId: 'trial',
    task: { schemaVersion: 1, taskId: 'task', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Task', prompt: 'prompt', repository: { kind: 'artifact', archiveRef: 'fixture.tar', archiveSha256: HASH, revision: 'revision' }, fixtureManifestHash: HASH, faultScenarioIds: [], verification: [{ stepId: 'true', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'test' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:agent-adapter'] }, publication: { artifact: { status: 'granted', basis: 'test' }, report: { status: 'granted', basis: 'test' }, leaderboard: { status: 'granted', basis: 'test' }, redistribution: { status: 'granted', basis: 'MIT' } } } },
    variant: { variantId: 'custom', backendId: 'custom-command', agentVersion: '1', model: { modelId: 'deterministic' }, configHash: HASH, config: { argv: ['node', '-e', 'process.stdout.write("worker acceptance\\n")'] }, credentialRefs: [] },
    sandbox: { sandboxId: 'sandbox', descriptor: { schemaVersion: 1, providerId: 'docker', kind: 'docker', version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace', execute, putArchive: async () => undefined, getArchive: async () => undefined, snapshot: async () => ({ snapshotId: 'snapshot', createdAt: new Date().toISOString(), manifestHash: HASH, files: [] }) },
    credentialValues: {}, absoluteDeadline: new Date(Date.now() + 10_000).toISOString(), inactivityTimeoutMs: 1_000,
  }
}
function result(stdout: string) { const at = new Date().toISOString(); return { exitCode: 0, stdout, stderr: '', startedAt: at, completedAt: at, timedOut: false } }

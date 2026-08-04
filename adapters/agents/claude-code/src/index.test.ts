import { describe, expect, it, vi } from 'vitest'

import type { AgentRunInput, SandboxExecRequest } from '@agent-kernel/eval-sdk'

import { ClaudeCodeAgentBackend } from './index.js'

class TestBackend extends ClaudeCodeAgentBackend {
  plan(input: AgentRunInput) { return this.command(input) }
}

describe('ClaudeCodeAgentBackend sandbox user selection', () => {
  it('uses the image ubuntu user when it exists', async () => {
    const execute = vi.fn(async (request: SandboxExecRequest) => result(request.argv[0] === 'id' ? '1000\n' : ''))
    const plan = await new TestBackend().plan(input(execute))

    expect(plan.argv.slice(0, 6)).toEqual(['runuser', '-u', 'ubuntu', '--preserve-environment', '--', 'claude'])
    expect(execute.mock.calls.some(([request]) => request.argv[0] === 'chown')).toBe(true)
  })

  it('uses nobody in a minimal official image without an ubuntu account', async () => {
    const execute = vi.fn(async (request: SandboxExecRequest) => request.argv[0] === 'id' && request.argv[2] === 'ubuntu' ? result('', 1) : result(''))
    const plan = await new TestBackend().plan(input(execute))

    expect(plan.argv.slice(0, 6)).toEqual(['runuser', '-u', 'nobody', '--preserve-environment', '--', 'claude'])
    expect(execute.mock.calls.find(([request]) => request.argv[0] === 'install')?.[0].argv).toEqual(['install', '-d', '-m', '0700', '-o', 'nobody', '-g', 'nogroup', '/tmp/agent-home/claude'])
    expect(execute.mock.calls.find(([request]) => request.argv[0] === 'chown')?.[0].argv[2]).toBe('nobody:nogroup')
  })

  it('refuses to run Claude Code as root when no unprivileged account exists', async () => {
    const execute = vi.fn(async (request: SandboxExecRequest) => request.argv[0] === 'id' ? result('', 1) : result(''))

    await expect(new TestBackend().plan(input(execute))).rejects.toThrow('requires an unprivileged sandbox account')
  })
})

function input(execute: AgentRunInput['sandbox']['execute']): AgentRunInput {
  return {
    runId: 'run', trialId: 'trial', absoluteDeadline: new Date(Date.now() + 60_000).toISOString(), inactivityTimeoutMs: 30_000, credentialValues: { anthropic: 'test' },
    task: { schemaVersion: 1, taskId: 'task', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Task', prompt: 'Fix it.', repository: { kind: 'git', url: 'https://example.test/repo.git', revision: 'revision', repositoryManifestHash: 'a'.repeat(64) }, fixtureManifestHash: 'a'.repeat(64), faultScenarioIds: [], verification: [{ stepId: 'true', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'test' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:agent-adapter'] }, publication: { artifact: { status: 'granted', basis: 'test' }, report: { status: 'granted', basis: 'test' }, leaderboard: { status: 'granted', basis: 'test' }, redistribution: { status: 'granted', basis: 'MIT' } } } },
    variant: { variantId: 'claude', backendId: 'claude-code', agentVersion: '1', model: { modelId: 'claude-sonnet' }, configHash: 'b'.repeat(64), config: {}, credentialRefs: [{ referenceId: 'anthropic', provider: 'anthropic', scope: [] }] },
    sandbox: { sandboxId: 'sandbox', descriptor: { schemaVersion: 1, providerId: 'lxd-container', kind: 'lxd-container', version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace', execute, putArchive: vi.fn(), getArchive: vi.fn(), snapshot: vi.fn() },
  }
}

function result(stdout: string, exitCode = 0) { const at = new Date().toISOString(); return { exitCode, stdout, stderr: '', startedAt: at, completedAt: at, timedOut: false } }

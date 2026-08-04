import { describe, expect, it, vi } from 'vitest'

import type { AgentRunInput, SandboxExecRequest } from '@agent-kernel/eval-sdk'

import { CodexAgentBackend } from './index.js'

class TestBackend extends CodexAgentBackend {
  plan(input: AgentRunInput) { return this.command(input) }
}

describe('CodexAgentBackend transport isolation', () => {
  it('uses the formal app-server driver with an isolated Codex home by default', async () => {
    const execute = vi.fn(async (_request: SandboxExecRequest) => result())
    const plan = await new TestBackend().plan(input(execute, { transport: 'app-server', baseUrl: 'http://127.0.0.1:18080/v1', reasoningEffort: 'high' }))

    expect(plan.argv).toEqual([
      'agent-eval-codex-app-server', '--model', 'gpt-fixture', '--cwd', '/workspace',
      '--final-response', '/tmp/agent-home/final-response.txt', '--effort', 'high',
      '--base-url', 'http://127.0.0.1:18080/v1',
    ])
    expect(plan.env).toEqual({ CODEX_HOME: '/tmp/agent-home/codex' })
    expect(plan.stdin).toBe('Fix it.')
  })

  it('uses ephemeral exec-json fallback without reading user config or session state', async () => {
    const execute = vi.fn(async (_request: SandboxExecRequest) => result())
    const plan = await new TestBackend().plan(input(execute, { transport: 'exec-json', baseUrl: 'http://127.0.0.1:18080/v1' }))

    expect(plan.argv.slice(0, 8)).toEqual([
      'codex', 'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(plan.argv).toContain('--output-last-message')
    expect(plan.argv).toContain('model_provider=\"agent_eval\"')
    expect(plan.argv.at(-1)).toBe('-')
    expect(plan.env).toEqual({ CODEX_HOME: '/tmp/agent-home/codex' })
    expect(execute).toHaveBeenCalledWith({ argv: ['mkdir', '-p', '/tmp/agent-home/codex'], timeoutMs: 10_000 })
  })
})

function input(execute: AgentRunInput['sandbox']['execute'], config: Record<string, unknown>): AgentRunInput {
  return {
    runId: 'run', trialId: 'trial', absoluteDeadline: new Date(Date.now() + 60_000).toISOString(), inactivityTimeoutMs: 30_000,
    task: { schemaVersion: 1, taskId: 'task', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Task', prompt: 'Fix it.', repository: { kind: 'git', url: 'https://example.test/repo.git', revision: 'revision', repositoryManifestHash: 'a'.repeat(64) }, fixtureManifestHash: 'a'.repeat(64), faultScenarioIds: [], verification: [{ stepId: 'true', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'test' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:agent-adapter'] }, publication: { artifact: { status: 'granted', basis: 'test' }, report: { status: 'granted', basis: 'test' }, leaderboard: { status: 'granted', basis: 'test' }, redistribution: { status: 'granted', basis: 'MIT' } } } },
    variant: { variantId: 'codex', backendId: 'codex', agentVersion: '1', model: { provider: 'openai', modelId: 'gpt-fixture' }, configHash: 'b'.repeat(64), config, credentialRefs: [{ referenceId: 'openai', provider: 'openai', scope: [] }] },
    sandbox: { sandboxId: 'sandbox', descriptor: { schemaVersion: 1, providerId: 'lxd-container', kind: 'lxd-container', version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace', execute, putArchive: vi.fn(), getArchive: vi.fn(), snapshot: vi.fn() },
    credentialValues: { openai: 'test' },
  }
}

function result() { const at = new Date().toISOString(); return { exitCode: 0, stdout: '', stderr: '', startedAt: at, completedAt: at, timedOut: false } }

import { type AgentVariantSpec, type ResolvedTask } from '@agent-kernel/eval-protocol'
import type { AgentRunInput, SandboxExecRequest, SandboxExecutionTarget } from '@agent-kernel/eval-sdk'
import { describe, expect, it, vi } from 'vitest'

import { AgentRunLabBackend } from './index.js'

const HASH = 'a'.repeat(64)

describe('AgentRunLabBackend', () => {
  it('rejects missing or ambiguous credential references without exposing values', async () => {
    const backend = new AgentRunLabBackend()
    const missing = await backend.preflight({ ...variant(), credentialRefs: [] })
    expect(missing.ok).toBe(false)
    expect(missing.errors.map((error) => error.code)).toContain('CREDENTIAL_REFERENCE_MISSING')
    const ambiguous = await backend.preflight({ ...variant(), model: { modelId: 'fixture' }, config: {}, credentialRefs: [
      { referenceId: 'secret-one', provider: 'openai', scope: [] },
      { referenceId: 'secret-two', provider: 'anthropic', scope: [] },
    ] })
    expect(ambiguous.errors.map((error) => error.code)).toContain('PROVIDER_AMBIGUOUS')
    expect(JSON.stringify(ambiguous)).not.toContain('credential-value')
  })

  it('captures public wire events, usage, versions, final response, and diff', async () => {
    const execute = vi.fn(async (request: SandboxExecRequest) => {
      if (request.argv[1] === '--version') return result(request.argv[0] + ' 1.2.3')
      if (request.argv[0] === 'bash') return result('diff --git a/a b/a\n')
      const state = { status: 'done', usage: { inputTokens: 11, outputTokens: 7 }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'finished' }] }] }
      request.onStdout?.(JSON.stringify({ type: 'runlab.event.appended', payload: { event: { kind: 'tool_result', callId: 'c1', ok: true }, effects: [] } }) + '\n')
      request.onStdout?.(JSON.stringify({ type: 'runlab.state.changed', payload: { state } }) + '\n')
      return result('driver output')
    })
    const backend = new AgentRunLabBackend()
    const handle = await backend.start(input(execute), new AbortController().signal)
    const events = []
    for await (const event of backend.events(handle)) events.push(event)
    const artifacts = await backend.collect(handle)
    expect(events.map((event) => event.kind)).toEqual(['status', 'tool_call', 'status'])
    expect(artifacts).toMatchObject({
      finalResponse: 'finished', finalDiff: 'diff --git a/a b/a\n',
      usage: { availability: 'available', inputTokens: 11, outputTokens: 7 },
      version: 'host=agent-kernel-host 1.2.3;executor=agent-kernel-executor 1.2.3',
      extraArtifactPaths: ['runlab-session.jsonl', 'runlab-native.tar'],
    })
    const driverRequest = execute.mock.calls.find(([request]) => request.argv[0] === 'agent-eval-runlab-driver')?.[0]
    expect(driverRequest?.env).toMatchObject({ OPENAI_API_KEY: 'credential-value' })
    expect(driverRequest?.env).not.toHaveProperty('AGENT_EVAL_CREDENTIAL_RUNLAB_OPENAI')
  })

  it('propagates cancellation to the whole sandbox execution', async () => {
    let aborted = false
    const execute = vi.fn(async (request: SandboxExecRequest, signal?: AbortSignal) => {
      if (request.argv[1] === '--version') return result('1')
      return await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
    })
    const backend = new AgentRunLabBackend(); const handle = await backend.start(input(execute), new AbortController().signal)
    await backend.cancel(handle)
    expect(aborted).toBe(true)
  })

  it('applies the observe-before-act recovery policy through the immutable Agent config', async () => {
    let driverStdin: string | Uint8Array | undefined
    const execute = vi.fn(async (request: SandboxExecRequest) => {
      if (request.argv[1] === '--version') return result('1')
      if (request.argv[0] === 'bash') return result('diff --git a/a b/a\n')
      driverStdin = request.stdin
      request.onStdout?.(JSON.stringify({ type: 'runlab.state.changed', payload: { state: { status: 'done' } } }) + '\n')
      return result('done')
    })
    const backend = new AgentRunLabBackend()
    const configured = input(execute)
    configured.variant = { ...configured.variant, config: { ...configured.variant.config, recoveryPolicy: 'observe-before-act' } }
    const handle = await backend.start(configured, new AbortController().signal)
    for await (const _event of backend.events(handle)) {}
    await backend.collect(handle)
    expect(String(driverStdin)).toContain('inspect the current observable state')
  })
})

function input(execute: SandboxExecutionTarget['execute']): AgentRunInput {
  const task: ResolvedTask = {
    schemaVersion: 1, taskId: 'task', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Task', prompt: 'prompt',
    repository: { kind: 'artifact', archiveRef: 'task.tar', archiveSha256: HASH, revision: 'revision' }, fixtureManifestHash: HASH, faultScenarioIds: [], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] },
    verification: [{ stepId: 'true', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'test' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:agent-adapter'] }, publication: { artifact: { status: 'granted', basis: 'test' }, report: { status: 'granted', basis: 'test' }, leaderboard: { status: 'granted', basis: 'test' }, redistribution: { status: 'granted', basis: 'MIT' } } },
  }
  return {
    runId: 'run', trialId: 'trial', task, variant: variant(), credentialValues: { 'runlab-openai': 'credential-value' },
    sandbox: {
      sandboxId: 'sandbox', descriptor: { schemaVersion: 1, providerId: 'docker', kind: 'docker', version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace', execute,
      putArchive: async () => undefined, getArchive: async () => undefined, snapshot: async () => ({ snapshotId: 'snapshot', createdAt: new Date().toISOString(), manifestHash: HASH, files: [] }),
    },
    absoluteDeadline: new Date(Date.now() + 10_000).toISOString(), inactivityTimeoutMs: 1_000,
  }
}
function variant(): AgentVariantSpec {
  return { variantId: 'runlab', backendId: 'agent-runlab', agentVersion: '1', model: { provider: 'openai', modelId: 'fixture' }, configHash: HASH, config: { provider: 'openai' }, credentialRefs: [{ referenceId: 'runlab-openai', provider: 'openai', scope: [] }] }
}
function result(stdout: string) { const now = new Date().toISOString(); return { exitCode: 0, stdout, stderr: '', startedAt: now, completedAt: now, timedOut: false } }

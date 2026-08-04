import { AgentBackendDescriptorSchema, type AgentVariantSpec, type NormalizedAgentEvent, type ResolvedTask } from '@agent-kernel/eval-protocol'
import { AgentProviderError, type AgentRunInput, type SandboxExecRequest, type SandboxExecutionTarget } from '@agent-kernel/eval-sdk'
import { describe, expect, it, vi } from 'vitest'

import { StructuredCliAgentBackend, normalizedEvent } from './index.js'

const HASH = 'a'.repeat(64)
class FixtureBackend extends StructuredCliAgentBackend {
  readonly descriptor = AgentBackendDescriptorSchema.parse({ schemaVersion: 1, id: 'codex', label: 'Fixture', version: '1', configSchemaVersion: 1, ranked: true, evidenceLevel: 'native', capabilities: { nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true, absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: true, finalDiff: true, usage: 'available' } })
  protected binary() { return 'fixture' }
  protected async command() { return { argv: ['fixture', '--json'], env: {}, stdin: 'prompt' } }
  protected normalize(native: unknown, sequence: number, at: string): NormalizedAgentEvent { return normalizedEvent(native, sequence, at, 'message') }
  protected credentialEnvironment(input: AgentRunInput) { return { FIXTURE_API_KEY: input.credentialValues.fixture ?? '' } }
  protected acceptedCredentialProviders() { return ['fixture'] }
}

describe('StructuredCliAgentBackend', () => {
  it('returns a live handle, emits lifecycle/native events, records usage and diff', async () => {
    let resolveRun!: (value: Awaited<ReturnType<SandboxExecutionTarget['execute']>>) => void
    const execute = vi.fn(async (request: SandboxExecRequest) => {
      if (request.argv[0] === 'fixture' && request.argv[1] === '--version') return result('fixture 1')
      if (request.argv[0] === 'bash') return result('diff --git a/x b/x\n')
      return await new Promise<Awaited<ReturnType<SandboxExecutionTarget['execute']>>>((resolve) => { resolveRun = resolve })
    })
    const backend = new FixtureBackend()
    const handle = await backend.start(input(execute), new AbortController().signal)
    const events = backend.events(handle)[Symbol.asyncIterator]()
    await expect(events.next()).resolves.toMatchObject({ value: { kind: 'status' }, done: false })
    const nativeLine = '{"type":"message","usage":{"input_tokens":3,"output_tokens":2}}\n'
    const runRequest = execute.mock.calls.find(([request]) => request.argv[1] === '--json')?.[0]
    runRequest?.onStdout?.(nativeLine)
    resolveRun(result(nativeLine))
    await expect(events.next()).resolves.toMatchObject({ value: { kind: 'message' }, done: false })
    await expect(events.next()).resolves.toMatchObject({ done: true })
    await expect(backend.collect(handle)).resolves.toMatchObject({ finalDiff: 'diff --git a/x b/x\n', usage: { availability: 'available', inputTokens: 3, outputTokens: 2 }, normalizedEvents: [{ kind: 'status' }, { kind: 'message' }] })
    const diffRequest = execute.mock.calls.find(([request]) => request.argv[0] === 'bash')?.[0]
    expect(diffRequest?.argv[2]).toContain('GIT_CONFIG_GLOBAL="$git_config" git diff')
    expect(diffRequest?.argv[2]).toContain('GIT_CONFIG_GLOBAL="$git_config" git ls-files')
    expect(diffRequest?.argv[2]).toContain("trap 'rm -f \"$git_config\"' EXIT")
  })

  it('propagates cancellation to the sandbox AbortSignal', async () => {
    let aborted = false
    const execute = vi.fn(async (request: SandboxExecRequest, signal?: AbortSignal) => {
      if (request.argv[1] === '--version') return result('fixture 1')
      return await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))
    })
    const backend = new FixtureBackend(); const handle = await backend.start(input(execute), new AbortController().signal)
    await backend.cancel(handle)
    expect(aborted).toBe(true)
  })

  it('reports missing credentials without exposing secret-like values', async () => {
    const backend = new FixtureBackend()
    const variant = input(vi.fn()).variant
    const result = await backend.preflight({ ...variant, credentialRefs: [{ referenceId: 'private-key', provider: 'unexpected', scope: [] }] })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })

  it.each([
    ['429 Too Many Requests', 'rate_limited'],
    ['upstream request timed out', 'timeout'],
  ])('normalizes a transient provider diagnostic: %s', async (stderr, kind) => {
    const execute = vi.fn(async (request: SandboxExecRequest) => {
      if (request.argv[1] === '--version') return result('fixture 1')
      return { ...result(''), exitCode: 1, stderr }
    })
    const backend = new FixtureBackend()
    const handle = await backend.start(input(execute), new AbortController().signal)
    await expect(async () => { for await (const _event of backend.events(handle)) { /* drain */ } }).rejects.toMatchObject<AgentProviderError>({ code: expect.stringMatching(/^PROVIDER_/u), kind })
  })
})

function input(execute: SandboxExecutionTarget['execute']): AgentRunInput {
  const task: ResolvedTask = { schemaVersion: 1, taskId: 'task', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Task', prompt: 'prompt', repository: { kind: 'artifact', archiveRef: 'task.tar', archiveSha256: HASH, revision: 'revision' }, fixtureManifestHash: HASH, faultScenarioIds: [], verification: [{ stepId: 'true', argv: ['true'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }], analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] }, policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'test' }, training: { status: 'unreviewed' } }, sourceProvenance: { status: 'granted', sourceRefs: ['fixture:agent-adapter'] }, publication: { artifact: { status: 'granted', basis: 'test' }, report: { status: 'granted', basis: 'test' }, leaderboard: { status: 'granted', basis: 'test' }, redistribution: { status: 'granted', basis: 'MIT' } } } }
  const variant: AgentVariantSpec = { variantId: 'fixture', backendId: 'codex', agentVersion: '1', model: { modelId: 'fixture-model' }, configHash: HASH, config: {}, credentialRefs: [{ referenceId: 'fixture', provider: 'fixture', scope: [] }] }
  return { runId: 'run', trialId: 'trial', task, variant, sandbox: { sandboxId: 'sandbox', descriptor: { schemaVersion: 1, providerId: 'docker', kind: 'docker', version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace', execute, putArchive: async () => undefined, getArchive: async () => undefined, snapshot: async () => ({ snapshotId: 'snapshot', createdAt: new Date().toISOString(), manifestHash: HASH, files: [] }) }, credentialValues: { fixture: 'fixture-value' }, absoluteDeadline: new Date(Date.now() + 10_000).toISOString(), inactivityTimeoutMs: 1_000 }
}
function result(stdout: string) { const now = new Date().toISOString(); return { exitCode: 0, stdout, stderr: '', startedAt: now, completedAt: now, timedOut: false } }

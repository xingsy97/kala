import { describe, expect, it } from 'vitest'

import type { AgentVariantSpec, ResolvedTask } from '@agent-kernel/eval-protocol'
import { AgentBackendTimeoutError, type AgentRunInput, type EvaluationAgentBackend, type SandboxExecRequest, type SandboxExecResult, type SandboxExecutionTarget } from '@agent-kernel/eval-sdk'

const HASH = 'a'.repeat(64)

export type OfficialAgentCertification = {
  name: string
  create(): EvaluationAgentBackend
  variant(): AgentVariantSpec
}

/** Defines the binding ten-case certification contract for every ranked official Agent backend. */
export function certifyOfficialAgentBackend(certification: OfficialAgentCertification): void {
  describe(certification.name + ' official Agent certification', () => {
    it('1. reports missing credentials without leaking values', async () => {
      const backend = certification.create()
      const result = await backend.preflight({ ...certification.variant(), credentialRefs: [] })
      expect(result.ok).toBe(false)
      expect(result.errors.map((error) => error.code)).toContain('CREDENTIAL_REFERENCE_MISSING')
      expect(JSON.stringify(result)).not.toContain('certification-secret-value')
    })

    it('2. starts and deterministically finishes one task', async () => {
      const backend = certification.create(); const sandbox = fixtureSandbox()
      const artifacts = await completedRun(backend, runInput(certification.variant(), sandbox.target))
      expect(artifacts.finalResponse ?? 'finished').toContain('finished')
      expect(sandbox.mainRequests).toHaveLength(1)
    })

    it('3. cancellation reaches the sandbox containment boundary for descendants', async () => {
      const backend = certification.create(); const sandbox = fixtureSandbox('blocking')
      const handle = await backend.start(runInput(certification.variant(), sandbox.target), new AbortController().signal)
      await backend.cancel(handle)
      await waitUntil(() => sandbox.commandAborted)
      expect(sandbox.descendantsAlive).toBe(false)
    })

    it('4. enforces the absolute deadline and returns a typed timeout', async () => {
      const backend = certification.create(); const sandbox = fixtureSandbox('timeout')
      const input = runInput(certification.variant(), sandbox.target, 100)
      const handle = await backend.start(input, new AbortController().signal)
      await expect(drain(backend.events(handle))).rejects.toBeInstanceOf(AgentBackendTimeoutError)
      expect(sandbox.mainRequests[0]?.timeoutMs).toBeGreaterThan(0)
      expect(sandbox.mainRequests[0]?.timeoutMs).toBeLessThanOrEqual(100)
    })

    it('5. confines workspace changes to the supplied trial target', async () => {
      const backend = certification.create(); const first = fixtureSandbox(); const second = fixtureSandbox()
      await completedRun(backend, runInput(certification.variant(), first.target))
      expect(first.workspaceChanged).toBe(true)
      expect(second.workspaceChanged).toBe(false)
    })

    it('6. collects the final binary diff', async () => {
      const backend = certification.create(); const sandbox = fixtureSandbox()
      const artifacts = await completedRun(backend, runInput(certification.variant(), sandbox.target))
      expect(artifacts.finalDiff).toBe('diff --git a/file.txt b/file.txt\n')
    })

    it('7. preserves stable raw and normalized event order', async () => {
      const backend = certification.create(); const sandbox = fixtureSandbox()
      const artifacts = await completedRun(backend, runInput(certification.variant(), sandbox.target))
      expect(artifacts.normalizedEvents.map((event) => event.sequence)).toEqual(artifacts.normalizedEvents.map((_event, index) => index))
      expect(artifacts.normalizedEvents.every((event, index) => event.nativeEventRef?.endsWith('#' + String(index)) ?? index === 0)).toBe(true)
    })

    it('8. records version, model command, and immutable config hash', async () => {
      const backend = certification.create(); const sandbox = fixtureSandbox(); const variant = certification.variant()
      const artifacts = await completedRun(backend, runInput(variant, sandbox.target))
      expect(artifacts.version).toContain('1.2.3')
      expect(artifacts.configHash).toBe(variant.configHash)
      expect(sandbox.mainRequests[0]?.argv).toContain(variant.model.modelId)
    })

    it('9. marks unavailable usage evidence explicitly', async () => {
      const backend = certification.create(); const sandbox = fixtureSandbox()
      const artifacts = await completedRun(backend, runInput(certification.variant(), sandbox.target))
      expect(artifacts.usage).toMatchObject({ availability: 'unavailable' })
      if (artifacts.usage.availability === 'unavailable') expect(artifacts.usage.reason.length).toBeGreaterThan(0)
    })

    it('10. repeated execution uses distinct fresh targets and handles', async () => {
      const backend = certification.create(); const first = fixtureSandbox(); const second = fixtureSandbox()
      const firstHandle = await backend.start(runInput(certification.variant(), first.target), new AbortController().signal)
      await drain(backend.events(firstHandle)); await backend.collect(firstHandle)
      const secondHandle = await backend.start(runInput(certification.variant(), second.target), new AbortController().signal)
      await drain(backend.events(secondHandle)); await backend.collect(secondHandle)
      expect(first.target.sandboxId).not.toBe(second.target.sandboxId)
      expect(firstHandle.handleId).not.toBe(secondHandle.handleId)
      expect(first.mainRequests).toHaveLength(1); expect(second.mainRequests).toHaveLength(1)
    })
  })
}

async function completedRun(backend: EvaluationAgentBackend, input: AgentRunInput) {
  const handle = await backend.start(input, new AbortController().signal)
  await drain(backend.events(handle))
  return await backend.collect(handle)
}

async function drain(events: AsyncIterable<unknown>): Promise<void> { for await (const _event of events) { /* consume */ } }

function runInput(variant: AgentVariantSpec, sandbox: SandboxExecutionTarget, deadlineMs = 10_000): AgentRunInput {
  const task: ResolvedTask = {
    schemaVersion: 1, taskId: 'certification-task', taskPackId: 'custom-task-pack', taskPackVersion: '1', title: 'Certification', prompt: 'Create file.txt containing finished.',
    repository: { kind: 'artifact', archiveRef: 'certification.tar', archiveSha256: HASH, revision: 'fixture-revision' }, fixtureManifestHash: HASH, faultScenarioIds: [],
    verification: [{ stepId: 'verify', argv: ['test', '-f', 'file.txt'], cwd: '.', timeoutMs: 1_000, requiredExitCode: 0 }],
    analysis: { constraints: [], protectedPaths: [], hiddenVerifierPaths: [] },
    policy: { license: { status: 'granted', basis: 'MIT' }, permissions: { evaluation: { status: 'granted', basis: 'certification' }, training: { status: 'denied', basis: 'not required' } }, sourceProvenance: { status: 'granted', sourceRefs: ['builtin:agent-certification'] }, publication: { artifact: { status: 'denied', basis: 'internal certification' }, report: { status: 'denied', basis: 'internal certification' }, leaderboard: { status: 'denied', basis: 'internal certification' }, redistribution: { status: 'denied', basis: 'internal certification' } } },
  }
  const reference = variant.credentialRefs[0]
  return {
    runId: 'certification-run', trialId: 'certification-trial-' + sandbox.sandboxId, task, variant, sandbox,
    credentialValues: reference ? { [reference.referenceId]: 'certification-secret-value' } : {},
    absoluteDeadline: new Date(Date.now() + deadlineMs).toISOString(), inactivityTimeoutMs: 1_000,
  }
}

function fixtureSandbox(mode: 'completed' | 'blocking' | 'timeout' = 'completed'): {
  target: SandboxExecutionTarget
  mainRequests: SandboxExecRequest[]
  commandAborted: boolean
  descendantsAlive: boolean
  workspaceChanged: boolean
} {
  const state = { mainRequests: [] as SandboxExecRequest[], commandAborted: false, descendantsAlive: false, workspaceChanged: false }
  const id = 'sandbox-' + Math.random().toString(36).slice(2)
  const target: SandboxExecutionTarget = {
    sandboxId: id, descriptor: { schemaVersion: 1, providerId: 'fixture', kind: 'docker', version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace',
    execute: async (request, signal) => {
      if (request.argv[1] === '--version') return result(request.argv[0] + ' 1.2.3')
      if (isDiffCapture(request)) return result('diff --git a/file.txt b/file.txt\n')
      if (request.argv[0] === 'sh') return result('finished')
      if (request.argv[0] === 'id') return request.argv.at(-1) === 'ubuntu' ? result('1000\n') : { ...result(''), exitCode: 1 }
      if (['install', 'node', 'chown', 'mkdir'].includes(request.argv[0] ?? '')) return result('')
      if (!isAgentExecution(request)) throw new Error('unexpected certification sandbox command: ' + request.argv.join(' '))
      state.mainRequests.push(request); state.workspaceChanged = true; state.descendantsAlive = true
      if (mode === 'blocking') return await new Promise<SandboxExecResult>((_resolve, reject) => {
        const abort = () => { state.commandAborted = true; state.descendantsAlive = false; reject(signal?.reason ?? new Error('cancelled')) }
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
      })
      const lines = nativeLines(request.argv[0] ?? '')
      request.onStdout?.(lines.slice(0, Math.ceil(lines.length / 2)))
      request.onStdout?.(lines.slice(Math.ceil(lines.length / 2)))
      state.descendantsAlive = false
      return mode === 'timeout' ? { ...result(lines), exitCode: 124, timedOut: true } : result(lines)
    },
    putArchive: async () => undefined, getArchive: async () => undefined,
    snapshot: async () => ({ snapshotId: id, createdAt: new Date().toISOString(), manifestHash: HASH, files: [] }),
  }
  return Object.assign(state, { target })
}

function isAgentExecution(request: SandboxExecRequest): boolean {
  return ['agent-eval-runlab-driver', 'runuser', 'agent-eval-codex-app-server', 'codex'].includes(request.argv[0] ?? '')
}

function isDiffCapture(request: SandboxExecRequest): boolean {
  return request.argv[0] === 'git' || (request.argv[0] === 'bash' && request.argv.some((argument) => argument.includes('git diff --binary')))
}

function nativeLines(binary: string): string {
  if (binary === 'agent-eval-runlab-driver') {
    return [
      JSON.stringify({ type: 'runlab.event.appended', payload: { event: { kind: 'llm_response', content: 'finished' }, effects: [] } }),
      JSON.stringify({ type: 'runlab.state.changed', payload: { state: { status: 'done', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'finished' }] }] } } }),
    ].join('\n') + '\n'
  }
  return JSON.stringify({ type: 'message', content: 'finished' }) + '\n'
}

function result(stdout: string): SandboxExecResult {
  const at = new Date().toISOString()
  return { exitCode: 0, stdout, stderr: '', startedAt: at, completedAt: at, timedOut: false }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('certification condition timed out'); await new Promise((resolve) => setTimeout(resolve, 5)) }
}

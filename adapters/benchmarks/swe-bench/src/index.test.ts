import { describe, expect, it, vi } from 'vitest'

import type { AgentVariantSpec } from '@agent-kernel/eval-protocol'
import type { SandboxExecRequest, SandboxExecutionTarget, VerificationInput } from '@agent-kernel/eval-sdk'

import { SweBenchBenchmarkAdapter } from './index.js'

const HASH = 'a'.repeat(64)
const HARNESS = 'f7bbbb2ccdf479001d6467c9e34af59e44a840f9'
const INSTANCE_ID = 'sympy__sympy-20590'

describe('SweBenchBenchmarkAdapter', () => {
  it('resolves a fresh immutable task without consulting Host runs or sessions', async () => {
    const adapter = new SweBenchBenchmarkAdapter()
    expect(adapter.descriptor).toMatchObject({ label: 'SWE-Bench · pinned official harness · local run', official: true })
    const [task] = await adapter.resolveTasks(taskInput())
    expect(task).toMatchObject({
      taskId: INSTANCE_ID, taskPackId: 'swe-bench', requiredSandboxImageDigest: 'local:' + HASH, lxdInitMode: 'keepalive',
      repository: { kind: 'git', revision: 'base-revision' }, benchmarkInput: {
        harnessRevision: HARNESS,
        officialInstanceImageDigest: 'docker.io/swebench/sweb.eval.x86_64.sympy_1776_sympy-20590@sha256:' + HASH,
        trialSandboxImageDigest: 'local:' + HASH,
      },
    })
    expect(JSON.stringify(task)).not.toMatch(/legacy|session|host artifact/iu)
  })

  it('requires the prepared official base revision and a clean workspace', async () => {
    const adapter = new SweBenchBenchmarkAdapter(); const [task] = await adapter.resolveTasks(taskInput())
    const execute = vi.fn(async (request: SandboxExecRequest) => {
      if (request.argv[0] === 'cat') return result(JSON.stringify({ officialInstanceImageDigest: taskInput().officialInstanceImageDigest, harnessRevision: HARNESS }))
      if (request.argv[0] === 'sh') return result('')
      if (request.argv.includes('rev-parse')) return result('base-revision\n')
      return result('')
    })
    await expect(adapter.prepareTask(task!, target(execute))).resolves.toBeUndefined()
    expect(execute.mock.calls[1]?.[0].argv.join(' ')).toContain('mv /testbed /workspace; ln -s /workspace /testbed')
    expect(execute.mock.calls[2]?.[0].env).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/workspace' })
    expect(execute.mock.calls[3]?.[0].env).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/workspace' })
  })

  it('rejects a derived trial image whose official OCI lineage does not match', async () => {
    const adapter = new SweBenchBenchmarkAdapter(); const [task] = await adapter.resolveTasks(taskInput())
    const execute = vi.fn(async () => result(JSON.stringify({ officialInstanceImageDigest: 'docker.io/wrong@sha256:' + HASH, harnessRevision: HARNESS })))
    await expect(adapter.prepareTask(task!, target(execute))).rejects.toThrow('lineage does not match')
  })

  it('grades only the collected final diff and ingests official native evidence', async () => {
    const adapter = new SweBenchBenchmarkAdapter(); const [task] = await adapter.resolveTasks(taskInput())
    const writes: SandboxExecRequest[] = []
    const execute = vi.fn(async (request: SandboxExecRequest) => {
      if (request.argv[0] === 'agent-eval-swe-bench-grade') {
        const payload = JSON.parse(request.stdin!) as { modelPatch: string; modelNameOrPath: string; instance: { instance_id: string } }
        expect(payload).toMatchObject({ modelPatch: 'diff --git a/a b/a\n', modelNameOrPath: 'codex/model', instance: { instance_id: INSTANCE_ID } })
        return result(JSON.stringify({ completed: true, patchApplied: true, report: { [INSTANCE_ID]: { resolved: true, tests_status: { FAIL_TO_PASS: { success: ['test'] } } } } }))
      }
      writes.push(request); return result('')
    })
    const agentVariant: AgentVariantSpec = { variantId: 'codex', backendId: 'codex', agentVersion: '1', model: { modelId: 'model' }, configHash: HASH, config: {}, credentialRefs: [] }
    const verification = await adapter.verify({
      runId: 'run', trialId: 'trial', task: task!, sandbox: target(execute), agentVariant, signal: new AbortController().signal,
      agentArtifacts: { completedAt: new Date().toISOString(), finalDiff: 'diff --git a/a b/a\n', nativeEvents: [], normalizedEvents: [], stdout: '', stderr: '', usage: { availability: 'unavailable', reason: 'fixture' }, version: '1', configHash: HASH, extraArtifactPaths: [] },
    } satisfies VerificationInput)
    expect(verification.result).toMatchObject({ nativeMetrics: { resolved: true, completed: true, patchApplied: true }, officialEvidence: true, verifierVersion: HARNESS })
    expect(verification.artifactPaths).toEqual(['swe-bench/trial/official-result.json'])
    expect(writes[0]?.stdin).toContain('tests_status')
  })

  it('refuses evidence from any unpinned harness revision', async () => {
    const adapter = new SweBenchBenchmarkAdapter(); const [task] = await adapter.resolveTasks({ ...taskInput(), harnessRevision: 'b'.repeat(40) })
    await expect(adapter.verify({ ...verificationFixture(task!), sandbox: target(vi.fn()) })).rejects.toThrow('does not match adapter verifier version')
  })
})

function taskInput() {
  return {
    schemaVersion: 1 as const, datasetId: 'swe-bench-verified', datasetVersion: 'verified-1', split: 'test', harnessRevision: HARNESS,
    officialInstanceImageDigest: 'docker.io/swebench/sweb.eval.x86_64.sympy_1776_sympy-20590@sha256:' + HASH,
    trialSandboxImageDigest: 'local:' + HASH, repositoryManifestHash: HASH, license: 'MIT', evaluationPermission: 'benchmark evaluation',
    officialRecord: { instance_id: INSTANCE_ID, repo: 'sympy/sympy', base_commit: 'base-revision', problem_statement: 'Fix it.', version: '1.8', FAIL_TO_PASS: '["test"]', PASS_TO_PASS: '[]', test_patch: 'diff --git a/test b/test\n' },
  }
}

function verificationFixture(task: NonNullable<Awaited<ReturnType<SweBenchBenchmarkAdapter['resolveTasks']>>[number]>): VerificationInput {
  return { runId: 'run', trialId: 'trial', task, sandbox: undefined as never, agentVariant: { variantId: 'agent', backendId: 'codex', agentVersion: '1', model: { modelId: 'model' }, configHash: HASH, config: {}, credentialRefs: [] }, signal: new AbortController().signal, agentArtifacts: { completedAt: new Date().toISOString(), finalDiff: '', nativeEvents: [], normalizedEvents: [], stdout: '', stderr: '', usage: { availability: 'unavailable', reason: 'fixture' }, version: '1', configHash: HASH, extraArtifactPaths: [] } }
}

function target(execute: SandboxExecutionTarget['execute']): SandboxExecutionTarget {
  return { sandboxId: 'sandbox', descriptor: { schemaVersion: 1, providerId: 'docker', kind: 'docker', version: '1', protocolVersions: [1], capabilities: ['fixture'] }, workspacePath: '/workspace', execute, putArchive: async () => undefined, getArchive: async () => undefined, snapshot: async () => ({ snapshotId: 'snapshot', createdAt: new Date().toISOString(), manifestHash: HASH, files: [] }) }
}
function result(stdout: string) { const at = new Date().toISOString(); return { exitCode: 0, stdout, stderr: '', startedAt: at, completedAt: at, timedOut: false } }

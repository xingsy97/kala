import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostRestartAttempt } from '@agent-kernel/shared'
import { FULL_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { createDedicatedRuntimeReadiness, readDedicatedProcessReadiness, readDedicatedRuntimeReadiness, writeDedicatedProcessReadiness, writeDedicatedRuntimeReadiness } from './dedicated-runtime-readiness.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Dedicated Runtime readiness', () => {
  it('persists process readiness independently from runtime readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'process-readiness-')); roots.push(root)
    const path = join(root, 'process-ready.json')
    await writeDedicatedProcessReadiness(path, { schemaVersion: 1, pid: process.pid, port: 13002, readyAt: new Date().toISOString() })
    await expect(readDedicatedProcessReadiness(path)).resolves.toMatchObject({ pid: process.pid, port: 13002 })
  })

  it('persists deployment ownership, state identity, write lease, capabilities, and continuation results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-readiness-')); roots.push(root)
    const sessionsDir = join(root, 'sessions'); const lease = join(root, 'write.lock'); const path = join(root, 'ready.json')
    await import('node:fs/promises').then((fs) => fs.mkdir(sessionsDir))
    await writeFile(lease, '')
    const deployment = { deploymentId: 'deployment-0001', targetReleaseDigest: 'a'.repeat(64), expectedRouteGeneration: 3, fencingToken: 'fencing-token-0001' }
    const restart: HostRestartAttempt = {
      attemptId: 'restart-0001', phase: 'completed', mode: 'checkpoint', reason: 'deploy', requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 1, deployment,
      sessions: [{ sessionId: 'session-1', cursor: 7, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn', continuationKey: 'continuation-1' }],
      recoveryReceipts: { 'session-1': { continuationKey: 'continuation-1', baselineCursor: 7, state: 'settled', observedCursor: 9 } },
    }
    const readiness = await createDedicatedRuntimeReadiness({ sessionsDir, writeLeasePath: lease, capabilities: FULL_RUNTIME_CAPABILITIES, restart, deployment })
    await writeDedicatedRuntimeReadiness(path, readiness)
    await expect(readDedicatedRuntimeReadiness(path)).resolves.toMatchObject({
      schemaVersion: 1, deployment, capabilities: FULL_RUNTIME_CAPABILITIES,
      continuation: { attemptId: 'restart-0001', participants: 1, completed: 1, failed: 0, sessions: [{ sessionId: 'session-1', cursor: 7, checkpointKind: 'before_llm', outcome: 'settled' }] },
    })
  })

  it('rejects a malformed persisted readiness receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-readiness-invalid-')); roots.push(root)
    const path = join(root, 'ready.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 2, pid: process.pid }))
    await expect(readDedicatedRuntimeReadiness(path)).rejects.toThrow('invalid runtime readiness')
  })

  it('rejects unknown fields and continuation summaries that disagree with Session outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-readiness-strict-')); roots.push(root)
    const path = join(root, 'ready.json')
    const base = {
      schemaVersion: 1, pid: process.pid, readyAt: new Date().toISOString(), extra: true,
      stateRoot: { pathDigest: 'a'.repeat(64), device: '1', inode: '2' }, writeLease: { pathDigest: 'b'.repeat(64) },
      capabilities: FULL_RUNTIME_CAPABILITIES, continuation: { participants: 0, completed: 0, failed: 0, sessions: [] },
    }
    await writeFile(path, JSON.stringify(base))
    await expect(readDedicatedRuntimeReadiness(path)).rejects.toThrow('unknown runtime readiness field')
    await writeFile(path, JSON.stringify({ ...base, extra: undefined, continuation: { participants: 1, completed: 1, failed: 0, sessions: [{ sessionId: 'session-1', cursor: 1, resumeAction: 'continue_turn', outcome: 'pending' }] } }))
    await expect(readDedicatedRuntimeReadiness(path)).rejects.toThrow('counts do not match')
  })
})

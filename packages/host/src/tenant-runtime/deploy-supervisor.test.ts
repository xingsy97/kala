import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StandaloneDeploySupervisor, activateRelease } from './deploy-supervisor.js'

const roots: string[] = []
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

async function release(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, 'releases', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'bundle-dashboard-with-runtime.cjs'), content)
  return dir
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Standalone Deploy Supervisor', () => {
  it('waits outside drain while Unit is busy and keeps the staged release inactive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-supervisor-wait-')); roots.push(root)
    const oldRelease = await release(root, 'old', 'old')
    const nextRelease = await release(root, 'next', 'next')
    await activateRelease(join(root, 'current'), oldRelease)
    const restartUnit = vi.fn(async () => {})
    const supervisor = new StandaloneDeploySupervisor(root, {
      reserveCutover: async () => ({ safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }),
      stopIngress: async () => {},
      startIngress: async () => {},
      inspectQuiescence: async () => ({ safe: false, queueStable: true, activeLlmCalls: 1, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }),
      restartUnit,
      verifyUnit: async () => ({ pid: 2 }),
    })
    const staged = await supervisor.stage({ operationId: 'op-wait', releaseDir: nextRelease, expectedSha256: digest('next') })
    const waiting = await supervisor.reconcile(staged.deploymentId)
    expect(waiting.phase).toBe('waiting_for_boundary')
    expect(restartUnit).not.toHaveBeenCalled()
    expect(await readlink(join(root, 'current'))).toBe(oldRelease)
  })

  it('activates once safe, verifies the Unit, and is idempotent by operation id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-supervisor-complete-')); roots.push(root)
    const nextRelease = await release(root, 'next', 'next')
    const restartUnit = vi.fn(async () => {})
    const supervisor = new StandaloneDeploySupervisor(root, {
      reserveCutover: async () => ({ safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }),
      stopIngress: async () => {},
      startIngress: async () => {},
      inspectQuiescence: async () => ({ safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }),
      restartUnit,
      verifyUnit: async (sha) => { expect(sha).toBe(digest('next')); return { pid: 42 } },
    })
    const staged = await supervisor.stage({ operationId: 'op-complete', releaseDir: nextRelease, expectedSha256: digest('next') })
    expect((await supervisor.stage({ operationId: 'op-complete', releaseDir: nextRelease, expectedSha256: digest('next') })).deploymentId).toBe(staged.deploymentId)
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed).toMatchObject({ phase: 'completed', activatedPid: 42 })
    expect(restartUnit).toHaveBeenCalledTimes(1)
  })

  it('resumes a persisted rollback without reactivating the failed release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-supervisor-resume-')); roots.push(root)
    const oldRelease = await release(root, 'old', 'old')
    const nextRelease = await release(root, 'next', 'next')
    await activateRelease(join(root, 'current'), nextRelease)
    const adapter = {
      inspectQuiescence: async () => ({ safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }),
      reserveCutover: async () => ({ safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }),
      stopIngress: vi.fn(async () => {}), startIngress: vi.fn(async () => {}), restartUnit: vi.fn(async () => {}), verifyUnit: async () => ({ pid: 9 }),
    }
    const supervisor = new StandaloneDeploySupervisor(root, adapter)
    const staged = await supervisor.stage({ operationId: 'op-resume', releaseDir: nextRelease, expectedSha256: digest('next') })
    const receiptPath = join(root, 'receipts', `${staged.deploymentId}.json`)
    await writeFile(receiptPath, JSON.stringify({ ...staged, phase: 'rolling_back', previousRelease: oldRelease, error: 'crashed' }))
    const resumed = await new StandaloneDeploySupervisor(root, adapter).reconcile(staged.deploymentId)
    expect(resumed.phase).toBe('rolled_back')
    expect(await readlink(join(root, 'current'))).toBe(oldRelease)
    expect(adapter.stopIngress).not.toHaveBeenCalled()
  })

  it('rolls the active symlink back when verification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-supervisor-rollback-')); roots.push(root)
    const oldRelease = await release(root, 'old', 'old')
    const nextRelease = await release(root, 'next', 'next')
    await activateRelease(join(root, 'current'), oldRelease)
    let verification = 0
    const supervisor = new StandaloneDeploySupervisor(root, {
      reserveCutover: async () => ({ safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }),
      stopIngress: async () => {},
      startIngress: async () => {},
      inspectQuiescence: async () => ({ safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }),
      restartUnit: async () => {},
      verifyUnit: async () => { verification += 1; if (verification === 1) throw new Error('unhealthy'); return { pid: 7 } },
    })
    const staged = await supervisor.stage({ operationId: 'op-rollback', releaseDir: nextRelease, expectedSha256: digest('next') })
    expect((await supervisor.reconcile(staged.deploymentId)).phase).toBe('rolled_back')
    expect(await readlink(join(root, 'current'))).toBe(oldRelease)
  })
})

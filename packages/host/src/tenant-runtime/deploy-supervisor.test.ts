import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StandaloneDeploySupervisor } from './deploy-supervisor.js'
import type { StandaloneRouteState, StandaloneSlot } from './standalone-slot-state.js'

const roots: string[] = []
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const safe = { safe: true, queueStable: true, activeLlmCalls: 0, activeToolCalls: 0, activeCompactions: 0, unsafeSessions: [], observedAt: new Date().toISOString() }

async function release(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, 'releases', name); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'bundle-dashboard-with-runtime.cjs'), content); return dir
}
function initialRoute(): StandaloneRouteState { return { schemaVersion: 1, generation: 1, activeSlot: 'blue', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'old' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'old' } }, updatedAt: new Date().toISOString() } }
function harness(route = initialRoute()) {
  let current = route
  const calls: string[] = []
  const adapter = {
    routeState: async () => current,
    inspectQuiescence: vi.fn(async (_slot: StandaloneSlot) => safe),
    reserveCutover: vi.fn(async (_slot: StandaloneSlot) => safe),
    selfTestRelease: vi.fn(async (_dir: string) => {}),
    activateSlot: vi.fn(async (slot: StandaloneSlot, dir: string) => { calls.push(`activate:${slot}:${dir.split('/').at(-1)}`) }),
    startSlot: vi.fn(async (slot: StandaloneSlot) => { calls.push(`start:${slot}`) }),
    stopSlot: vi.fn(async (slot: StandaloneSlot) => { calls.push(`stop:${slot}`) }),
    verifySlot: vi.fn(async (slot: StandaloneSlot, _sha: string) => { calls.push(`verify:${slot}`); return { pid: slot === 'green' ? 42 : 7 } }),
    switchRoute: vi.fn(async (next: StandaloneRouteState) => { calls.push(`route:${next.activeSlot}`); current = next }),
  }
  return { adapter, calls, route: () => current, failNextVerification: () => adapter.verifySlot.mockImplementationOnce(async () => { throw new Error('unhealthy') }) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Standalone Deploy Supervisor slots', () => {
  it('waits outside drain while active slot is busy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-slot-wait-')); roots.push(root); await release(root, 'old', 'old'); const next = await release(root, 'next', 'next')
    const h = harness(); h.adapter.inspectQuiescence.mockResolvedValueOnce({ ...safe, safe: false, activeLlmCalls: 1 })
    const supervisor = new StandaloneDeploySupervisor(root, h.adapter)
    const staged = await supervisor.stage({ operationId: 'op-wait', releaseDir: next, expectedSha256: digest('next') })
    expect((await supervisor.reconcile(staged.deploymentId)).phase).toBe('waiting_for_boundary')
    expect(h.adapter.stopSlot).not.toHaveBeenCalled(); expect(h.route().activeSlot).toBe('blue')
  })

  it('hands the write lease from blue to green before routing new traffic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-slot-ok-')); roots.push(root); await release(root, 'old', 'old'); const next = await release(root, 'next', 'next')
    const h = harness(); const supervisor = new StandaloneDeploySupervisor(root, h.adapter)
    const staged = await supervisor.stage({ operationId: 'op-ok', releaseDir: next, expectedSha256: digest('next') })
    const completed = await supervisor.reconcile(staged.deploymentId)
    expect(completed).toMatchObject({ phase: 'completed', previousSlot: 'blue', candidateSlot: 'green', activatedPid: 42 })
    expect(h.calls).toEqual(['stop:blue', 'activate:green:next', 'start:green', 'verify:green', 'route:green'])
    expect(h.route()).toMatchObject({ generation: 2, activeSlot: 'green', slots: { blue: { releaseId: 'old' }, green: { releaseId: 'next' } } })
    expect((await supervisor.stage({ operationId: 'op-ok', releaseDir: next, expectedSha256: digest('next') })).deploymentId).toBe(staged.deploymentId)
  })

  it('restores the previous slot and route when candidate verification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-slot-rollback-')); roots.push(root); const old = await release(root, 'old', 'old'); const next = await release(root, 'next', 'next')
    const h = harness(); h.failNextVerification(); const supervisor = new StandaloneDeploySupervisor(root, h.adapter)
    const staged = await supervisor.stage({ operationId: 'op-bad', releaseDir: next, expectedSha256: digest('next') })
    const receipt = await supervisor.reconcile(staged.deploymentId)
    expect(receipt.phase).toBe('rolled_back')
    expect(h.calls).toEqual(['stop:blue', 'activate:green:next', 'start:green', 'stop:green', 'activate:blue:old', 'start:blue', 'verify:blue', 'route:blue'])
    expect(h.route().activeSlot).toBe('blue')
  })

  it('resumes a persisted rollback after Supervisor restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-slot-resume-')); roots.push(root); const old = await release(root, 'old', 'old'); const next = await release(root, 'next', 'next')
    const h = harness(); const supervisor = new StandaloneDeploySupervisor(root, h.adapter)
    const staged = await supervisor.stage({ operationId: 'op-resume', releaseDir: next, expectedSha256: digest('next') })
    await writeFile(join(root, 'receipts', `${staged.deploymentId}.json`), JSON.stringify({ ...staged, phase: 'rolling_back', previousRelease: old, previousSlot: 'blue', candidateSlot: 'green', error: 'crashed' }))
    const receipt = await new StandaloneDeploySupervisor(root, h.adapter).reconcile(staged.deploymentId)
    expect(receipt.phase).toBe('rolled_back'); expect(h.calls).toEqual(['stop:green', 'activate:blue:old', 'start:blue', 'verify:blue', 'route:blue'])
  })
})

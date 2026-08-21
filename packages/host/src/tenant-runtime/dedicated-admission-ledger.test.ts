import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AdmissionBackpressureError, DedicatedAdmissionLedger, type AdmissionMessage } from './dedicated-admission-ledger.js'

const roots: string[] = []
const principal = 'a'.repeat(64)

function message(operationId: string, sessionId = 'session-1', text = operationId): AdmissionMessage {
  return { schemaVersion: 1, principalDigest: principal, unitId: 'local', sessionId, operationId, mode: 'queue', text }
}

async function ledger(capacity = 1000): Promise<{ path: string; value: DedicatedAdmissionLedger }> {
  const root = await mkdtemp(join(tmpdir(), 'admission-ledger-'))
  roots.push(root)
  const path = join(root, 'ledger.json')
  return { path, value: new DedicatedAdmissionLedger(path, capacity) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DedicatedAdmissionLedger', () => {
  it('durably reloads an accepted operation and returns its original outcome', async () => {
    const { path, value } = await ledger()
    const first = await value.append(message('operation-0001'), 4)
    const duplicate = await new DedicatedAdmissionLedger(path).append(message('operation-0001'), 5)
    expect(first).toMatchObject({ duplicate: false, record: { sequence: 1, routeGeneration: 4, state: 'pending' } })
    expect(duplicate).toMatchObject({ duplicate: true, record: { sequence: 1, routeGeneration: 4, state: 'pending' } })
  })

  it('binds operation identity globally to principal, Session, mode, and content', async () => {
    const { value } = await ledger()
    await value.append(message('operation-0002'), 1)
    await expect(value.append({ ...message('operation-0002'), principalDigest: 'b'.repeat(64) }, 1)).rejects.toThrow('conflicts')
    await expect(value.append(message('operation-0002', 'session-2'), 1)).rejects.toThrow('conflicts')
  })

  it('applies capacity backpressure to uncommitted records', async () => {
    const { value } = await ledger(1)
    await value.append(message('operation-0003'), 1)
    await expect(value.append(message('operation-0004'), 1)).rejects.toBeInstanceOf(AdmissionBackpressureError)
  })

  it('leases in per-Session order while allowing other Sessions to progress', async () => {
    const { value } = await ledger()
    await value.append(message('operation-0005', 'session-a'), 3)
    await value.append(message('operation-0006', 'session-a'), 3)
    await value.append(message('operation-0007', 'session-b'), 3)
    expect((await value.leaseNext('worker-a', 3))?.operationId).toBe('operation-0005')
    expect((await value.leaseNext('worker-b', 3))?.operationId).toBe('operation-0007')
    expect(await value.leaseNext('worker-c', 3)).toBeUndefined()
    await value.commit('operation-0005', 'worker-a', 3, 12)
    expect((await value.leaseNext('worker-c', 3))?.operationId).toBe('operation-0006')
  })

  it('reclaims stale generation leases and fences stale commits', async () => {
    const { path, value } = await ledger()
    await value.append(message('operation-0008'), 7)
    await value.leaseNext('old-worker', 7)
    expect((await new DedicatedAdmissionLedger(path).leaseNext('new-worker', 8))?.operationId).toBe('operation-0008')
    await expect(value.commit('operation-0008', 'old-worker', 7)).rejects.toThrow('stale admission lease')
  })

  it('recovers an expired lease and commits exactly once after restart', async () => {
    const { path, value } = await ledger()
    await value.append(message('operation-0009'), 2)
    await value.leaseNext('first-worker', 2, 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const restarted = new DedicatedAdmissionLedger(path)
    expect((await restarted.leaseNext('second-worker', 2))?.operationId).toBe('operation-0009')
    const first = await restarted.commit('operation-0009', 'second-worker', 2, 20)
    const duplicate = await restarted.commit('operation-0009', 'other-worker', 99, 21)
    expect(first).toMatchObject({ state: 'committed', sessionCursor: 20 })
    expect(duplicate).toMatchObject({ state: 'committed', sessionCursor: 20 })
  })

  it('accepts a durable Runtime handoff receipt after lease-owner process replacement', async () => {
    const { path, value } = await ledger()
    await value.append(message('operation-0010'), 2)
    await value.leaseNext('dead-ingress', 2, 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const restarted = new DedicatedAdmissionLedger(path)
    await restarted.leaseNext('new-ingress', 2)
    await expect(restarted.committed('operation-0010', 2, 30)).resolves.toMatchObject({ state: 'committed', sessionCursor: 30 })
  })
})

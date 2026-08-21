import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { advanceDedicatedRoute, otherSlot, readDedicatedRouteState, writeDedicatedRouteState } from './dedicated-slot-state.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const initial = () => ({ schemaVersion: 1 as const, generation: 1, activeSlot: 'blue' as const, slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'old' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'old' } }, updatedAt: new Date().toISOString() })

describe('Dedicated route state', () => {
  it('alternates slots and atomically persists a monotonic route generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'route-state-')); roots.push(root); const path = join(root, 'route.json')
    const next = advanceDedicatedRoute(initial(), { slot: otherSlot('blue'), releaseId: 'next' })
    await writeDedicatedRouteState(path, next)
    expect(await readDedicatedRouteState(path)).toEqual(next)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ generation: 2, activeSlot: 'green' })
    await expect((await import('node:fs/promises')).stat(path).then((stat) => stat.mode & 0o777)).resolves.toBe(0o644)
  })

  it('rejects public or malformed slot origins', async () => {
    expect(() => advanceDedicatedRoute({ ...initial(), slots: { ...initial().slots, green: { origin: 'https://public.example', releaseId: 'x' } } }, { slot: 'green', releaseId: 'x' })).toThrow('invalid green slot')
    expect(() => advanceDedicatedRoute({ ...initial(), slots: { ...initial().slots, green: { origin: 'http://127.0.0.1:99999', releaseId: 'x' } } }, { slot: 'green', releaseId: 'x' })).toThrow('invalid green slot')
    expect(() => advanceDedicatedRoute({ ...initial(), unexpected: true } as never, { slot: 'green', releaseId: 'x' })).toThrow('unknown route state field')
  })
})

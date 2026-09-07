import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'

import { RuntimeUnitMaterializationStore, type RuntimeUnitMaterialization } from './materialization-store.js'
import { parseTenantRuntimeUnitId } from './unit.js'

const roots: string[] = []
function entry(generation: number, operation: string): RuntimeUnitMaterialization {
  return { schemaVersion: 1, unitId: parseTenantRuntimeUnitId('a'), routingKeyDigest: 'sha256:test', routingKeyVersion: 1, generation, desiredState: 'ready', dataRoot: '/data/a', capabilities: AGENT_RUNTIME_CAPABILITIES, lastOperationId: operation, updatedAt: new Date(0).toISOString() }
}
function deletedEntry(generation: number, operation: string): RuntimeUnitMaterialization {
  return { ...entry(generation, operation), desiredState: 'deleted' }
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('RuntimeUnitMaterializationStore', () => {
  it('persists atomically and reloads entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-catalog-')); roots.push(root)
    const path = join(root, 'catalog.json')
    const catalog = new RuntimeUnitMaterializationStore(path)
    await catalog.apply(entry(1, 'op-1'))
    expect(JSON.parse(await readFile(path, 'utf8')).units).toHaveLength(1)
    const reloaded = new RuntimeUnitMaterializationStore(path)
    await reloaded.load()
    expect(reloaded.get(parseTenantRuntimeUnitId('a'))?.generation).toBe(1)
  })

  it('normalizes legacy closed materializations to deleted tombstones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-catalog-')); roots.push(root)
    const path = join(root, 'catalog.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, units: [{ ...entry(4, 'legacy-close'), desiredState: 'closed' }] }))
    const catalog = new RuntimeUnitMaterializationStore(path)
    await catalog.load()
    expect(catalog.get(parseTenantRuntimeUnitId('a'))).toMatchObject({ desiredState: 'deleted', generation: 4 })
  })

  it('deduplicates operation id and rejects stale generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-catalog-')); roots.push(root)
    const catalog = new RuntimeUnitMaterializationStore(join(root, 'catalog.json'))
    const first = await catalog.apply(entry(2, 'same'))
    expect(await catalog.apply({ ...entry(3, 'same') })).toBe(first)
    await expect(catalog.apply(entry(1, 'new'))).rejects.toThrow('stale')
  })

  it('persists deleted tombstones and blocks Unit resurrection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-catalog-')); roots.push(root)
    const path = join(root, 'catalog.json')
    const catalog = new RuntimeUnitMaterializationStore(path)
    await catalog.apply(entry(2, 'provision'))
    await catalog.tombstone(deletedEntry(3, 'delete'))
    expect(catalog.get(parseTenantRuntimeUnitId('a'))).toMatchObject({ desiredState: 'deleted', generation: 3 })
    await expect(catalog.apply(entry(4, 'resume'))).rejects.toThrow('deleted TenantRuntimeUnit cannot be resumed')
    await expect(catalog.apply(entry(2, 'stale'))).rejects.toThrow('stale')
    const reloaded = new RuntimeUnitMaterializationStore(path)
    await reloaded.load()
    expect(reloaded.get(parseTenantRuntimeUnitId('a'))).toMatchObject({ desiredState: 'deleted', generation: 3 })
  })
})

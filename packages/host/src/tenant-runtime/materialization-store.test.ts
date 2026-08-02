import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SAAS_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'

import { RuntimeUnitMaterializationStore, type RuntimeUnitMaterialization } from './materialization-store.js'
import { parseTenantRuntimeUnitId } from './unit.js'

const roots: string[] = []
function entry(generation: number, operation: string): RuntimeUnitMaterialization {
  return { schemaVersion: 1, unitId: parseTenantRuntimeUnitId('a'), routingKeyDigest: 'sha256:test', routingKeyVersion: 1, generation, desiredState: 'ready', dataRoot: '/data/a', capabilities: SAAS_RUNTIME_CAPABILITIES, lastOperationId: operation, updatedAt: new Date(0).toISOString() }
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

  it('deduplicates operation id and rejects stale generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'unit-catalog-')); roots.push(root)
    const catalog = new RuntimeUnitMaterializationStore(join(root, 'catalog.json'))
    const first = await catalog.apply(entry(2, 'same'))
    expect(await catalog.apply({ ...entry(3, 'same') })).toBe(first)
    await expect(catalog.apply(entry(1, 'new'))).rejects.toThrow('stale')
  })
})

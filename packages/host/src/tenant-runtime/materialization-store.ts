import type { RuntimeCapabilities } from '@agent-kernel/shared'

import { readJsonFile, writeJsonFile } from './atomic-json-file.js'
import { parseTenantRuntimeUnitId, type TenantRuntimeUnitId, type TenantRuntimeUnitState } from './unit.js'

export type RuntimeUnitMaterialization = {
  schemaVersion: 1
  unitId: TenantRuntimeUnitId
  routingKeyDigest: string
  routingKeyVersion: number
  generation: number
  desiredState: Extract<TenantRuntimeUnitState, 'ready' | 'suspended' | 'closed'>
  dataRoot: string
  capabilities: RuntimeCapabilities
  lastOperationId: string
  updatedAt: string
}

type CatalogFile = { schemaVersion: 1; units: RuntimeUnitMaterialization[] }

export class RuntimeUnitMaterializationStore {
  private readonly entries = new Map<TenantRuntimeUnitId, RuntimeUnitMaterialization>()
  private mutation = Promise.resolve()

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    const parsed = await readJsonFile<CatalogFile>(this.path)
    if (!parsed) return
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.units)) throw new Error('unsupported TenantRuntimeUnit catalog')
    this.entries.clear()
    for (const entry of parsed.units) {
      const id = parseTenantRuntimeUnitId(entry.unitId)
      if (this.entries.has(id)) throw new Error(`duplicate TenantRuntimeUnit catalog id: ${id}`)
      this.entries.set(id, { ...entry, unitId: id })
    }
  }

  get(id: TenantRuntimeUnitId): RuntimeUnitMaterialization | undefined {
    return this.entries.get(id)
  }

  list(): readonly RuntimeUnitMaterialization[] {
    return [...this.entries.values()]
  }

  async apply(entry: RuntimeUnitMaterialization): Promise<RuntimeUnitMaterialization> {
    return this.serialize(async () => {
      const existing = this.entries.get(entry.unitId)
      if (existing?.lastOperationId === entry.lastOperationId) return existing
      if (existing && entry.generation <= existing.generation) throw new Error('stale TenantRuntimeUnit generation')
      this.entries.set(entry.unitId, entry)
      try {
        await this.persist()
      } catch (error) {
        if (existing) this.entries.set(entry.unitId, existing)
        else this.entries.delete(entry.unitId)
        throw error
      }
      return entry
    })
  }

  async remove(id: TenantRuntimeUnitId, operationId: string, generation: number): Promise<void> {
    await this.serialize(async () => {
      const existing = this.entries.get(id)
      if (!existing) return
      if (existing.lastOperationId === operationId) return
      if (generation <= existing.generation) throw new Error('stale TenantRuntimeUnit generation')
      this.entries.delete(id)
      try { await this.persist() } catch (error) { this.entries.set(id, existing); throw error }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(): Promise<void> {
    const body: CatalogFile = { schemaVersion: 1, units: [...this.entries.values()] }
    await writeJsonFile(this.path, body)
  }
}

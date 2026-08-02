export type TenantRuntimeUnitId = string & { readonly __parseTenantRuntimeUnitId: unique symbol }

export type TenantRuntimeUnitState =
  | 'provisioning'
  | 'loading'
  | 'ready'
  | 'draining'
  | 'suspended'
  | 'failed'
  | 'closed'

const UNIT_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/u

export function parseTenantRuntimeUnitId(value: string): TenantRuntimeUnitId {
  if (!UNIT_ID.test(value) || value === '.' || value === '..') {
    throw new Error('invalid TenantRuntimeUnit id')
  }
  return value as TenantRuntimeUnitId
}

export interface TenantRuntimeUnit {
  readonly id: TenantRuntimeUnitId
  readonly state: TenantRuntimeUnitState
  readonly origin: string
  drain(): Promise<void>
  close(): Promise<void>
}

export type TenantRuntimeUnitFactory = (id: TenantRuntimeUnitId) => Promise<TenantRuntimeUnit>

/** Serializes first load and owns the lifecycle of all loaded runtime Units. */
export class TenantRuntimeUnitRegistry {
  private readonly units = new Map<TenantRuntimeUnitId, TenantRuntimeUnit>()
  private readonly loading = new Map<TenantRuntimeUnitId, Promise<TenantRuntimeUnit>>()
  private draining = false

  constructor(private readonly factory: TenantRuntimeUnitFactory, private readonly maxLoadedUnits = Number.POSITIVE_INFINITY) {}

  get(id: TenantRuntimeUnitId): TenantRuntimeUnit | undefined {
    return this.units.get(id)
  }

  list(): readonly TenantRuntimeUnit[] {
    return [...this.units.values()]
  }

  async getOrLoad(id: TenantRuntimeUnitId): Promise<TenantRuntimeUnit> {
    const loaded = this.units.get(id)
    if (loaded) return loaded
    if (this.draining) throw new Error('TenantRuntimeUnitRegistry is draining')
    const pending = this.loading.get(id)
    if (pending) return pending
    if (this.units.size + this.loading.size >= this.maxLoadedUnits) throw new Error('TenantRuntimeUnit capacity exceeded')
    const creation = this.factory(id).then((unit) => {
      if (unit.id !== id) throw new Error('TenantRuntimeUnit factory returned a mismatched id')
      this.units.set(id, unit)
      return unit
    }).finally(() => this.loading.delete(id))
    this.loading.set(id, creation)
    return creation
  }

  async close(id: TenantRuntimeUnitId): Promise<void> {
    const pending = this.loading.get(id)
    const unit = this.units.get(id) ?? (pending ? await pending : undefined)
    if (!unit) return
    this.units.delete(id)
    await unit.close()
  }

  async drainAll(): Promise<void> {
    this.draining = true
    await Promise.all([...this.loading.values()].map((pending) => pending.catch(() => undefined)))
    await Promise.all([...this.units.values()].map((unit) => unit.drain()))
  }

  async closeAll(): Promise<void> {
    this.draining = true
    await Promise.all([...this.loading.values()].map((pending) => pending.catch(() => undefined)))
    const units = [...this.units.values()]
    this.units.clear()
    await Promise.all(units.map((unit) => unit.close()))
  }
}

import { describe, expect, it, vi } from 'vitest'

import type { ControlPlaneDatabase } from '../persistence/postgres.js'
import { RuntimeUnitProvisioner, type RuntimeHostResponse } from './runtime-unit-provisioner.js'

type Placement = {
  organization_id: string
  placement_organization_id: string
  generation: number
  desired_state: 'ready' | 'suspended' | 'deleted'
  last_operation_id: string
}

function databaseWith(initial: Placement, bigintAsString = false) {
  let placement = { ...initial }
  const queries: Array<{ sql: string; values: readonly unknown[] }> = []
  const query = async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values })
    if (sql.startsWith('SELECT o.id AS organization_id')) return result([placement])
    if (sql.startsWith('UPDATE runtime_unit_placements')) {
      if (values[3] !== placement.placement_organization_id || Number(values[4]) !== Number(placement.generation)) return result([])
      placement = { ...placement, generation: bigintAsString ? String(values[1]) as unknown as number : Number(values[1]), last_operation_id: String(values[2]) }
      return result([{ ...placement, organization_id: undefined }])
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const database = {
    query,
    transaction: async <T>(operation: (transaction: { query: typeof query }) => Promise<T>) => await operation({ query }),
    health: async () => ({ ok: true as const, schemaVersion: 1 }),
    close: async () => undefined,
  } as unknown as ControlPlaneDatabase
  return { database, queries, placement: () => placement }
}

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
}

const ok = (): RuntimeHostResponse => ({ status: 200, body: Buffer.from('{"ok":true}') })
const upgradeRequired = (): RuntimeHostResponse => ({ status: 409, body: Buffer.from('{"code":"organization_binding_upgrade_required"}') })

describe('RuntimeUnitProvisioner', () => {
  it('materializes and retries a new unit from its unique authoritative organization placement', async () => {
    const fixture = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: 1, desired_state: 'ready', last_operation_id: 'create-org' })
    const requestHost = vi.fn(async (_body: unknown) => ok())
    const service = new RuntimeUnitProvisioner(fixture.database, requestHost)

    await service.provision('unit_acme')
    await service.provision('unit_acme')

    expect(requestHost).toHaveBeenCalledTimes(2)
    expect(requestHost.mock.calls[0]?.[0]).toEqual({ unitId: 'unit_acme', organizationId: 'org_acme', operationId: 'host-materialize:unit_acme:1:ready', generation: 1, action: 'provision' })
    expect(requestHost.mock.calls[1]?.[0]).toEqual(requestHost.mock.calls[0]?.[0])
  })

  it('normalizes PostgreSQL BIGINT generation strings before contacting Host', async () => {
    const fixture = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: '1' as unknown as number, desired_state: 'ready', last_operation_id: 'create-org' })
    const requestHost = vi.fn(async (_body: unknown) => ok())
    await new RuntimeUnitProvisioner(fixture.database, requestHost).provision('unit_acme')
    expect(requestHost).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, organizationId: 'org_acme' }))
  })

  it('fails closed before contacting Host for cross-organization or invalid-generation mappings', async () => {
    const mismatch = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_other', generation: 1, desired_state: 'ready', last_operation_id: 'create-org' })
    const requestHost = vi.fn(async (_body: unknown) => ok())
    await expect(new RuntimeUnitProvisioner(mismatch.database, requestHost).provision('unit_acme')).rejects.toThrow('cross-organization placement mismatch')

    const invalid = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: 0, desired_state: 'ready', last_operation_id: 'create-org' })
    await expect(new RuntimeUnitProvisioner(invalid.database, requestHost).provision('unit_acme')).rejects.toThrow('invalid placement generation')
    expect(requestHost).not.toHaveBeenCalled()
  })

  it('advances the trusted placement once and explicitly upgrades a legacy unbound unit', async () => {
    const fixture = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: 4, desired_state: 'ready', last_operation_id: 'prior-lifecycle-op' })
    const requestHost = vi.fn<(body: unknown) => Promise<RuntimeHostResponse>>()
      .mockResolvedValueOnce(upgradeRequired())
      .mockResolvedValueOnce(ok())
    await new RuntimeUnitProvisioner(fixture.database, requestHost).provision('unit_acme')

    expect(fixture.placement()).toMatchObject({ generation: 5, last_operation_id: 'host-bind-organization:unit_acme:5' })
    expect(requestHost.mock.calls[1]?.[0]).toEqual({ unitId: 'unit_acme', organizationId: 'org_acme', operationId: 'host-bind-organization:unit_acme:5', generation: 5, action: 'bind-organization', desiredState: 'ready' })
  })

  it('normalizes PostgreSQL BIGINT strings returned after a binding upgrade', async () => {
    const fixture = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: '1' as unknown as number, desired_state: 'ready', last_operation_id: 'prior-op' }, true)
    const requestHost = vi.fn<(body: unknown) => Promise<RuntimeHostResponse>>()
      .mockResolvedValueOnce(upgradeRequired())
      .mockResolvedValueOnce(ok())
    await new RuntimeUnitProvisioner(fixture.database, requestHost).provision('unit_acme')
    expect(requestHost.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ generation: 2, action: 'bind-organization' }))
  })

  it('recovers a binding upgrade after Host disconnect without advancing generation again', async () => {
    const fixture = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: 1, desired_state: 'ready', last_operation_id: 'create-org' })
    const firstRequest = vi.fn<(body: unknown) => Promise<RuntimeHostResponse>>()
      .mockResolvedValueOnce(upgradeRequired())
      .mockRejectedValueOnce(new Error('connection reset'))
    await expect(new RuntimeUnitProvisioner(fixture.database, firstRequest).provision('unit_acme')).rejects.toThrow('connection reset')

    const retryRequest = vi.fn(async (_body: unknown) => ok())
    await new RuntimeUnitProvisioner(fixture.database, retryRequest).provision('unit_acme')
    expect(fixture.placement().generation).toBe(2)
    expect(retryRequest).toHaveBeenCalledWith({ unitId: 'unit_acme', organizationId: 'org_acme', operationId: 'host-bind-organization:unit_acme:2', generation: 2, action: 'bind-organization', desiredState: 'ready' })
  })

  it('does not trust a malformed binding operation and preserves a non-ready legacy lifecycle state', async () => {
    const malformed = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: 2, desired_state: 'ready', last_operation_id: 'host-bind-organization:unit_acme:999' })
    const requestHost = vi.fn(async (_body: unknown) => ok())
    await new RuntimeUnitProvisioner(malformed.database, requestHost).provision('unit_acme')
    expect(requestHost).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'host-materialize:unit_acme:2:ready', action: 'provision' }))

    const suspended = databaseWith({ organization_id: 'org_acme', placement_organization_id: 'org_acme', generation: 3, desired_state: 'suspended', last_operation_id: 'suspend-op' })
    const needsUpgrade = vi.fn<(body: unknown) => Promise<RuntimeHostResponse>>()
      .mockResolvedValueOnce(upgradeRequired())
      .mockResolvedValueOnce(ok())
    await new RuntimeUnitProvisioner(suspended.database, needsUpgrade).provision('unit_acme')
    expect(suspended.placement().generation).toBe(4)
    expect(needsUpgrade.mock.calls[1]?.[0]).toEqual({ unitId: 'unit_acme', organizationId: 'org_acme', operationId: 'host-bind-organization:unit_acme:4', generation: 4, action: 'bind-organization', desiredState: 'suspended' })
  })
})

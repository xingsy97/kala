import { describe, expect, it } from 'vitest'

import { OrganizationProvisioningService } from './provisioning.js'
import type { ControlPlaneDatabase, SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

describe('OrganizationProvisioningService', () => {
  it('provisions an active organization with default P0 control-plane records', async () => {
    const database = new FakeProvisioningDatabase()
    const service = new OrganizationProvisioningService(database)

    const result = await service.provision({
      operationId: 'op-provision',
      name: ' Acme ',
      owner: { issuer: 'https://id.example', subject: 'alice', displayName: 'Alice', email: 'alice@example.test' },
      contractReference: 'contract-acme',
      supportTier: 'business',
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: new Date('2027-01-01T00:00:00Z'),
      seatLimit: 10,
      concurrentSessionLimit: 3,
      monthlyTokenLimit: 1_000_000n,
      storageBytesLimit: 10_000_000n,
    })

    expect(result).toMatchObject({ alreadyApplied: false })
    expect(database.statements('INSERT INTO organizations')).toHaveLength(1)
    expect(database.statements('INSERT INTO organization_memberships')).toHaveLength(1)
    expect(database.statements('INSERT INTO contract_entitlements')).toHaveLength(1)
    expect(database.statements('INSERT INTO retention_policies')).toHaveLength(1)
    expect(database.statements('INSERT INTO runtime_unit_placements')).toHaveLength(1)
    expect(database.statements('INSERT INTO executor_pools')).toHaveLength(1)
    expect(database.statements('UPDATE organizations SET status=')).toHaveLength(1)
    expect(database.statements('INSERT INTO audit_events')).toHaveLength(1)
    expect(database.statements('INSERT INTO outbox_events')).toHaveLength(1)
  })

  it('maps lifecycle status changes to runtime placement and revokes live sessions', async () => {
    const database = new FakeProvisioningDatabase()
    const service = new OrganizationProvisioningService(database)

    await expect(service.setStatus({
      operationId: 'op-suspend',
      organizationId: 'org_acme',
      status: 'suspended',
      actorPrincipalId: 'prn_admin',
    })).resolves.toEqual({ alreadyApplied: false })

    expect(database.statements('UPDATE organizations SET status=')).toHaveLength(1)
    expect(database.statements('UPDATE runtime_unit_placements SET desired_state=')).toHaveLength(1)
    expect(database.executed.find((entry) => entry.sql.includes('UPDATE runtime_unit_placements'))?.values).toContain('suspended')
    expect(database.statements('UPDATE browser_sessions SET revoked_at=')).toHaveLength(1)
    expect(database.statements('INSERT INTO audit_events')).toHaveLength(1)
    expect(database.statements('INSERT INTO outbox_events')).toHaveLength(1)
  })

  it('is idempotent by operation id', async () => {
    const database = new FakeProvisioningDatabase(new Set(['op-suspend']))
    const service = new OrganizationProvisioningService(database)

    await expect(service.setStatus({
      operationId: 'op-suspend',
      organizationId: 'org_acme',
      status: 'closed',
      actorPrincipalId: 'prn_admin',
    })).resolves.toEqual({ alreadyApplied: true })

    expect(database.statements('UPDATE organizations SET status=')).toEqual([])
  })
})

class FakeProvisioningDatabase implements ControlPlaneDatabase, SqlExecutor {
  readonly executed: Array<{ sql: string; values: readonly unknown[] }> = []
  constructor(private readonly appliedOperations = new Set<string>()) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    this.executed.push({ sql, values })
    if (sql.startsWith('SELECT e.aggregate_id,o.runtime_unit_id FROM outbox_events')) {
      const operationId = String(values[0])
      return this.appliedOperations.has(operationId)
        ? result([{ aggregate_id: 'org_acme', runtime_unit_id: 'tenant_acme' } as unknown as Row])
        : result([])
    }
    if (sql.startsWith('UPDATE organizations SET status=')) return result([], 1)
    return result([])
  }

  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return operation(this)
  }

  async health() { return { ok: true as const, schemaVersion: 1 } }
  async close() {}

  statements(prefix: string): Array<{ sql: string; values: readonly unknown[] }> {
    return this.executed.filter((entry) => entry.sql.startsWith(prefix))
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}

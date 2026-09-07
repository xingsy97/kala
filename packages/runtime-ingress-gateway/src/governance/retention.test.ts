import { describe, expect, it } from 'vitest'

import { RetentionService } from './retention.js'
import type { ControlPlaneDatabase, SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

describe('RetentionService', () => {
  it('purges tenant-scoped sessions and devices using the organization retention policy', async () => {
    const database = new FakeRetentionDatabase()
    const service = new RetentionService(database)
    const now = new Date('2026-09-07T04:00:00Z')

    await expect(service.purgeOrganization('org_acme', now)).resolves.toEqual({ sessions: 2, devices: 1 })

    expect(database.transactionCount).toBe(1)
    expect(database.executed.map((entry) => entry.sql)).toEqual([
      'SELECT session_days FROM retention_policies WHERE organization_id=$1',
      "DELETE FROM notification_devices WHERE organization_id=$1 AND updated_at < $2::timestamptz - ($3::text || ' days')::interval",
      "DELETE FROM browser_sessions WHERE organization_id=$1 AND COALESCE(revoked_at,absolute_expires_at) < $2::timestamptz - ($3::text || ' days')::interval",
    ])
    expect(database.executed[1]?.values).toEqual(['org_acme', now, 30])
    expect(database.executed[2]?.values).toEqual(['org_acme', now, 30])
  })

  it('fails closed when retention policy is missing', async () => {
    const database = new FakeRetentionDatabase({ policyRows: [] })
    const service = new RetentionService(database)

    await expect(service.purgeOrganization('org_missing')).rejects.toThrow('retention policy not found')
    expect(database.executed.some((entry) => entry.sql.startsWith('DELETE '))).toBe(false)
  })

  it('exports only the requested organization control-plane records', async () => {
    const database = new FakeRetentionDatabase()
    const service = new RetentionService(database)

    const exported = await service.exportOrganization('org_acme')

    expect(exported).toMatchObject({
      schemaVersion: 1,
      organization: { id: 'org_acme' },
      memberships: [{ organization_id: 'org_acme' }],
      usage: [{ organization_id: 'org_acme' }],
      audit: [{ organization_id: 'org_acme' }],
    })
    expect(database.executed.slice(-4).map((entry) => entry.values)).toEqual([
      ['org_acme'],
      ['org_acme'],
      ['org_acme'],
      ['org_acme'],
    ])
  })
})

class FakeRetentionDatabase implements ControlPlaneDatabase, SqlExecutor {
  readonly executed: Array<{ sql: string; values: readonly unknown[] }> = []
  transactionCount = 0

  constructor(private readonly options: { policyRows?: Array<{ session_days: number }> } = {}) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    this.executed.push({ sql, values })
    if (sql.startsWith('SELECT session_days FROM retention_policies')) return result((this.options.policyRows ?? [{ session_days: 30 }]) as unknown as Row[])
    if (sql.startsWith('DELETE FROM notification_devices')) return result([], 1)
    if (sql.startsWith('DELETE FROM browser_sessions')) return result([], 2)
    if (sql.startsWith('SELECT * FROM organizations')) return result([{ id: values[0] } as unknown as Row])
    if (sql.startsWith('SELECT m.* FROM organization_memberships')) return result([{ organization_id: values[0] } as unknown as Row])
    if (sql.startsWith('SELECT * FROM usage_ledger')) return result([{ organization_id: values[0] } as unknown as Row])
    if (sql.startsWith('SELECT * FROM audit_events')) return result([{ organization_id: values[0] } as unknown as Row])
    return result([])
  }

  async transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1
    return operation(this)
  }

  async health() { return { ok: true as const, schemaVersion: 1 } }
  async close() {}
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}

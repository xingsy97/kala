import { describe, expect, it } from 'vitest'

import { ServiceAccountService, type ServiceAccountScope } from './service-accounts.js'
import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

describe('ServiceAccountService', () => {
  it('enforces configured active service account quotas before issuing a token', async () => {
    const database = new FakeServiceAccountDatabase({ activeCount: 1 })
    const service = new ServiceAccountService(database, { maxActiveServiceAccounts: 1 })

    await expect(service.create({ organizationId: 'org_acme', name: 'automation', scopes: ['organization:read'] }))
      .rejects.toThrow('service account quota exceeded')
    expect(database.executed.some((entry) => entry.sql.startsWith('INSERT INTO'))).toBe(false)
  })

  it('deduplicates valid scopes and stores only a token hash', async () => {
    const database = new FakeServiceAccountDatabase({ activeCount: 0 })
    const service = new ServiceAccountService(database, { maxActiveServiceAccounts: 2 })

    const created = await service.create({ organizationId: 'org_acme', name: ' automation ', scopes: ['organization:read', 'organization:read', 'audit:read'] })

    expect(created.id).toMatch(/^prn_/u)
    expect(created.token).toMatch(/^ak_sa_/u)
    const tokenInsert = database.executed.find((entry) => entry.sql.startsWith('INSERT INTO service_account_tokens'))
    expect(tokenInsert?.values[3]).toMatch(/^[a-f0-9]{64}$/u)
    expect(tokenInsert?.values).not.toContain(created.token)
    expect(tokenInsert?.values[4]).toEqual(['organization:read', 'audit:read'])
  })

  it('rejects invalid scopes and quota configuration', async () => {
    expect(() => new ServiceAccountService(new FakeServiceAccountDatabase(), { maxActiveServiceAccounts: 0 })).toThrow('maxActiveServiceAccounts')
    const service = new ServiceAccountService(new FakeServiceAccountDatabase())
    await expect(service.create({ organizationId: 'org_acme', name: 'automation', scopes: ['root:all' as ServiceAccountScope] })).rejects.toThrow('invalid service account')
  })
})

class FakeServiceAccountDatabase implements SqlExecutor {
  readonly executed: Array<{ sql: string; values: readonly unknown[] }> = []

  constructor(private readonly options: { activeCount?: number } = {}) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    this.executed.push({ sql, values })
    if (sql.startsWith('SELECT COUNT(*)')) return result([{ count: String(this.options.activeCount ?? 0) } as unknown as Row])
    return result([])
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): SqlQueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}

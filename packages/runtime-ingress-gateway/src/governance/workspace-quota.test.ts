import { describe, expect, it } from 'vitest'

import { PostgresWorkspaceQuota } from './workspace-quota.js'
import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'

describe('PostgresWorkspaceQuota', () => {
  it('allows workspace creation below the active workspace entitlement', async () => {
    const quota = new PostgresWorkspaceQuota(new FakeWorkspaceQuotaDatabase({ activeWorkspaces: '2', workspaceLimit: '5' }))

    await expect(quota.assertCanCreateWorkspace('org_acme')).resolves.toEqual({ activeWorkspaces: 2, limit: 5 })
  })

  it('fails closed without entitlements and rejects exhausted workspace quota', async () => {
    await expect(new PostgresWorkspaceQuota(new FakeWorkspaceQuotaDatabase({ rows: [] })).assertCanCreateWorkspace('org_missing'))
      .rejects.toThrow('contract entitlement not found')
    await expect(new PostgresWorkspaceQuota(new FakeWorkspaceQuotaDatabase({ activeWorkspaces: '5', workspaceLimit: '5' })).assertCanCreateWorkspace('org_acme'))
      .rejects.toThrow('organization workspace quota exceeded')
  })
})

class FakeWorkspaceQuotaDatabase implements SqlExecutor {
  constructor(private readonly options: { rows?: Array<{ active_workspaces: string; workspace_limit: string }>; activeWorkspaces?: string; workspaceLimit?: string }) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
    return result((this.options.rows ?? [{
      active_workspaces: this.options.activeWorkspaces ?? '0',
      workspace_limit: this.options.workspaceLimit ?? '5',
    }]) as unknown as Row[])
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[]): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
}

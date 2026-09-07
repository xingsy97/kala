import type { SqlExecutor } from '../persistence/postgres.js'

export class PostgresWorkspaceQuota {
  constructor(private readonly database: SqlExecutor) {}

  async assertCanCreateWorkspace(organizationId: string): Promise<{ activeWorkspaces: number; limit: number }> {
    const result = await this.database.query<{ active_workspaces: string; workspace_limit: string }>(`
      SELECT COUNT(w.id)::text AS active_workspaces,e.workspace_limit::text
      FROM contract_entitlements e
      LEFT JOIN workspaces w ON w.organization_id=e.organization_id AND w.status='active'
      WHERE e.organization_id=$1
      GROUP BY e.workspace_limit
    `, [organizationId])
    if (!result.rows[0]) throw new Error('contract entitlement not found')
    const activeWorkspaces = Number(result.rows[0].active_workspaces)
    const limit = Number(result.rows[0].workspace_limit)
    if (!Number.isSafeInteger(activeWorkspaces) || !Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid workspace entitlement')
    if (activeWorkspaces >= limit) throw new Error('organization workspace quota exceeded')
    return { activeWorkspaces, limit }
  }
}

import type { SqlExecutor } from '../persistence/postgres.js'

export type UsageEntry = { id: string; organizationId: string; workspaceId?: string; principalId?: string; sessionId?: string; modelKey?: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; occurredAt: Date; operationId: string }

export class PostgresUsageLedger {
  constructor(private readonly database: SqlExecutor) {}
  async append(entry: UsageEntry): Promise<boolean> {
    const result = await this.database.query(`INSERT INTO usage_ledger(id,organization_id,workspace_id,principal_id,session_id,model_key,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,occurred_at,source_operation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (organization_id,source_operation_id) DO NOTHING`, [entry.id, entry.organizationId, entry.workspaceId ?? null, entry.principalId ?? null, entry.sessionId ?? null, entry.modelKey ?? null, entry.inputTokens, entry.outputTokens, entry.cacheReadTokens ?? 0, entry.cacheCreationTokens ?? 0, entry.occurredAt, entry.operationId])
    return result.rowCount === 1
  }
  async currentMonth(organizationId: string): Promise<{ tokens: number; limit?: number; exhausted: boolean }> {
    const result = await this.database.query<{ tokens: string; monthly_token_limit: string | null }>(`SELECT COALESCE(SUM(u.input_tokens+u.output_tokens+u.cache_read_tokens+u.cache_creation_tokens),0)::text AS tokens,e.monthly_token_limit::text
      FROM contract_entitlements e LEFT JOIN usage_ledger u ON u.organization_id=e.organization_id AND u.occurred_at>=date_trunc('month',now()) WHERE e.organization_id=$1 GROUP BY e.monthly_token_limit`, [organizationId])
    const tokens = Number(result.rows[0]?.tokens ?? 0), limit = result.rows[0]?.monthly_token_limit === null || result.rows[0]?.monthly_token_limit === undefined ? undefined : Number(result.rows[0]!.monthly_token_limit)
    return { tokens, ...(limit !== undefined ? { limit } : {}), exhausted: limit !== undefined && tokens >= limit }
  }
}

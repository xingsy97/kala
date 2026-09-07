import { randomUUID } from 'node:crypto'

import type { SqlExecutor } from '../persistence/postgres.js'

export class PostgresUsageAlertService {
  constructor(private readonly database: SqlExecutor) {}

  async checkMonthlyTokenBudget(organizationId: string, thresholdPercent = 80): Promise<{ emitted: boolean; percent?: number; tokens?: number; limit?: number }> {
    if (!Number.isSafeInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) throw new Error('invalid usage alert threshold')
    const result = await this.database.query<{ tokens: string; monthly_token_limit: string | null }>(`SELECT COALESCE(SUM(u.input_tokens+u.output_tokens+u.cache_read_tokens+u.cache_creation_tokens),0)::text AS tokens,e.monthly_token_limit::text
      FROM contract_entitlements e LEFT JOIN usage_ledger u ON u.organization_id=e.organization_id AND u.occurred_at>=date_trunc('month',now()) WHERE e.organization_id=$1 GROUP BY e.monthly_token_limit`, [organizationId])
    if (!result.rows[0]) throw new Error('contract entitlement not found')
    const tokens = Number(result.rows[0].tokens)
    const limit = result.rows[0].monthly_token_limit === null ? undefined : Number(result.rows[0].monthly_token_limit)
    if (limit === undefined || limit === 0) return { emitted: false, tokens, limit }
    if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(limit) || tokens < 0 || limit < 0) throw new Error('invalid usage alert accounting')
    const percent = Math.floor((tokens / limit) * 100)
    if (percent < thresholdPercent) return { emitted: false, percent, tokens, limit }
    const month = new Date().toISOString().slice(0, 7)
    const eventId = `usage-alert:${organizationId}:tokens:${month}:${thresholdPercent}`
    const inserted = await this.database.query(`INSERT INTO outbox_events(id,organization_id,topic,aggregate_type,aggregate_id,payload) VALUES($1,$2,'usage.monthly_token_threshold','organization',$2,$3) ON CONFLICT (id) DO NOTHING`, [
      eventId,
      organizationId,
      { eventId: randomUUID(), organizationId, tokens, limit, percent, thresholdPercent, month },
    ])
    return { emitted: inserted.rowCount === 1, percent, tokens, limit }
  }
}

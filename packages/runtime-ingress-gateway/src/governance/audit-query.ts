import type { SqlExecutor } from '../persistence/postgres.js'

export type AuditQuery = { organizationId: string; actorPrincipalId?: string; action?: string; from?: Date; to?: Date; limit?: number }
export class PostgresAuditQueryService {
  constructor(private readonly database: SqlExecutor) {}
  async query(input: AuditQuery): Promise<readonly Record<string, unknown>[]> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000)
    const result = await this.database.query<Record<string, unknown>>(`SELECT id,actor_principal_id,actor_kind,action,target_type,target_id,result,request_id,trace_id,metadata,occurred_at
      FROM audit_events WHERE organization_id=$1 AND ($2::text IS NULL OR actor_principal_id=$2) AND ($3::text IS NULL OR action=$3)
      AND ($4::timestamptz IS NULL OR occurred_at >= $4) AND ($5::timestamptz IS NULL OR occurred_at < $5) ORDER BY occurred_at DESC,id DESC LIMIT $6`, [input.organizationId, input.actorPrincipalId ?? null, input.action ?? null, input.from ?? null, input.to ?? null, limit])
    return result.rows
  }
  toCsv(rows: readonly Record<string, unknown>[]): string {
    const columns = ['id','actor_principal_id','actor_kind','action','target_type','target_id','result','request_id','trace_id','occurred_at']
    return [columns.join(','), ...rows.map((row) => columns.map((column) => csv(row[column])).join(','))].join('\n') + '\n'
  }
}
function csv(value: unknown): string { const text = value === undefined || value === null ? '' : String(value); return `"${text.replace(/"/gu, '""')}"` }

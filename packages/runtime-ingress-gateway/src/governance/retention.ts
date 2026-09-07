import { randomUUID } from 'node:crypto'

import type { ControlPlaneDatabase } from '../persistence/postgres.js'

export type RetentionPurgeResult = {
  organizationId: string
  sessions: number
  devices: number
  hostSessions: number
}

export type RetentionPurgeFailure = {
  organizationId: string
  error: string
}

export class RetentionService {
  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly hostData?: {
      purgeOrganizationSessions(params: { organizationId: string; before: Date }): Promise<{ sessions: number }>
    },
  ) {}
  async purgeOrganization(organizationId: string, now = new Date()): Promise<{ sessions: number; devices: number; hostSessions: number }> {
    const controlPlane = await this.database.transaction(async (transaction) => {
      const policy = await transaction.query<{ session_days: number }>('SELECT session_days FROM retention_policies WHERE organization_id=$1', [organizationId])
      if (!policy.rows[0]) throw new Error('retention policy not found')
      const devices = await transaction.query(`DELETE FROM notification_devices WHERE organization_id=$1 AND updated_at < $2::timestamptz - ($3::text || ' days')::interval`, [organizationId, now, policy.rows[0].session_days])
      const sessions = await transaction.query(`DELETE FROM browser_sessions WHERE organization_id=$1 AND COALESCE(revoked_at,absolute_expires_at) < $2::timestamptz - ($3::text || ' days')::interval`, [organizationId, now, policy.rows[0].session_days])
      return { sessionDays: policy.rows[0].session_days, sessions: sessions.rowCount ?? 0, devices: devices.rowCount ?? 0 }
    })
    const before = new Date(now.getTime() - controlPlane.sessionDays * 24 * 60 * 60 * 1000)
    const hostSessions = this.hostData ? (await this.hostData.purgeOrganizationSessions({ organizationId, before })).sessions : 0
    const result = { sessions: controlPlane.sessions, devices: controlPlane.devices, hostSessions }
    await this.writePurgeAudit(organizationId, result, before)
    return result
  }
  async purgeAllOrganizations(now = new Date()): Promise<{ purged: RetentionPurgeResult[]; failures: RetentionPurgeFailure[] }> {
    const organizations = await this.database.query<{ organization_id: string }>(`
      SELECT r.organization_id
      FROM retention_policies r
      JOIN organizations o ON o.id=r.organization_id
      WHERE o.status IN ('active','suspended','closing')
      ORDER BY r.organization_id
    `)
    const purged: RetentionPurgeResult[] = []
    const failures: RetentionPurgeFailure[] = []
    for (const row of organizations.rows) {
      try {
        purged.push({ organizationId: row.organization_id, ...await this.purgeOrganization(row.organization_id, now) })
      } catch (error) {
        failures.push({ organizationId: row.organization_id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { purged, failures }
  }
  async exportOrganization(organizationId: string): Promise<Record<string, unknown>> {
    const [organization, members, usage, audit] = await Promise.all([
      this.database.query('SELECT * FROM organizations WHERE id=$1', [organizationId]),
      this.database.query('SELECT m.* FROM organization_memberships m WHERE organization_id=$1', [organizationId]),
      this.database.query('SELECT * FROM usage_ledger WHERE organization_id=$1 ORDER BY occurred_at', [organizationId]),
      this.database.query('SELECT * FROM audit_events WHERE organization_id=$1 ORDER BY occurred_at', [organizationId]),
    ])
    if (!organization.rows[0]) throw new Error('organization not found')
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), organization: organization.rows[0], memberships: members.rows, usage: usage.rows, audit: audit.rows }
  }

  private async writePurgeAudit(organizationId: string, result: { sessions: number; devices: number; hostSessions: number }, before: Date): Promise<void> {
    await this.database.query(
      `INSERT INTO audit_events(id,organization_id,actor_principal_id,actor_kind,action,target_type,target_id,result,metadata) VALUES($1,$2,'system','system','retention.purge','organization',$2,'succeeded',$3)`,
      [randomUUID(), organizationId, { before: before.toISOString(), ...result }],
    )
  }
}

export function startRetentionScheduler(options: {
  service: RetentionService
  intervalMs: number
  now?: () => Date
  onResult?: (result: Awaited<ReturnType<RetentionService['purgeAllOrganizations']>>) => void
  onError?: (error: Error) => void
}): { stop(): void } {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 60_000) throw new Error('retention scheduler interval must be at least 60000ms')
  let running = false
  const run = (): void => {
    if (running) return
    running = true
    void options.service.purgeAllOrganizations(options.now?.() ?? new Date())
      .then((result) => options.onResult?.(result))
      .catch((error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))))
      .finally(() => { running = false })
  }
  const timer = setInterval(run, options.intervalMs)
  timer.unref?.()
  run()
  return { stop: () => clearInterval(timer) }
}

import type { ControlPlaneDatabase } from '../persistence/postgres.js'

export class RetentionService {
  constructor(private readonly database: ControlPlaneDatabase) {}
  async purgeOrganization(organizationId: string, now = new Date()): Promise<{ sessions: number; devices: number }> {
    return this.database.transaction(async (transaction) => {
      const policy = await transaction.query<{ session_days: number }>('SELECT session_days FROM retention_policies WHERE organization_id=$1', [organizationId])
      if (!policy.rows[0]) throw new Error('retention policy not found')
      const devices = await transaction.query(`DELETE FROM notification_devices WHERE organization_id=$1 AND updated_at < $2::timestamptz - ($3::text || ' days')::interval`, [organizationId, now, policy.rows[0].session_days])
      const sessions = await transaction.query(`DELETE FROM browser_sessions WHERE organization_id=$1 AND COALESCE(revoked_at,absolute_expires_at) < $2::timestamptz - ($3::text || ' days')::interval`, [organizationId, now, policy.rows[0].session_days])
      return { sessions: sessions.rowCount ?? 0, devices: devices.rowCount ?? 0 }
    })
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
}

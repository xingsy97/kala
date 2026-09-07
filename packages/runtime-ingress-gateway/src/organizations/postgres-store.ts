import { createHash, randomBytes } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import { identityKey, inviteKey } from '../assignments/store.js'
import type { SqlExecutor } from '../persistence/postgres.js'
import type { Organization, OrganizationAccess, OrganizationMembership, OrganizationRole, OrganizationStatus, OrganizationStore } from './store.js'

export class PostgresOrganizationStore implements OrganizationStore {
  constructor(private readonly database: SqlExecutor & { transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> }) {}

  async getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<OrganizationAccess> {
    const existing = await this.findAccess(identity)
    if (existing) return existing
    throw new Error('organization_not_provisioned')
  }

  async findAccess(identity: AuthenticatedIdentity): Promise<OrganizationAccess | undefined> {
    const result = await this.database.query<AccessRow>(`
      SELECT o.id, o.name, o.status, o.runtime_unit_id, o.created_at, m.role, m.created_at AS membership_created_at
      FROM principals p
      JOIN organization_memberships m ON m.principal_id = p.id AND m.status = 'active'
      JOIN organizations o ON o.id = m.organization_id
      WHERE p.kind = 'human' AND p.issuer = $1 AND p.subject = $2
      ORDER BY m.created_at LIMIT 1`, [identity.issuer, identity.subject])
    const row = result.rows[0]
    return row ? accessFromRow(row, identity) : undefined
  }

  async listMembers(organizationId: string): Promise<readonly OrganizationMembership[]> {
    const result = await this.database.query<MemberRow>(`
      SELECT p.issuer, p.subject, p.display_name, p.email, m.role, m.created_at
      FROM organization_memberships m JOIN principals p ON p.id = m.principal_id
      WHERE m.organization_id = $1 AND m.status = 'active' ORDER BY m.created_at`, [organizationId])
    return result.rows.map((row) => membershipFromRow(organizationId, row))
  }

  async addMember(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<OrganizationMembership> {
    return this.database.transaction(async (transaction) => {
      const principalId = principalIdFor(identity)
      await transaction.query(`INSERT INTO principals(id, kind, issuer, subject, display_name, email)
        VALUES ($1, 'human', $2, $3, $4, $5)
        ON CONFLICT (issuer, subject) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, updated_at = now()`,
      [principalId, identity.issuer, identity.subject, identity.displayName ?? null, identity.email ?? null])
      const result = await transaction.query<{ created_at: Date }>(`INSERT INTO organization_memberships(organization_id, principal_id, role, status)
        VALUES ($1, (SELECT id FROM principals WHERE issuer = $2 AND subject = $3), $4, 'active')
        ON CONFLICT (organization_id, principal_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()
        RETURNING created_at`, [organizationId, identity.issuer, identity.subject, role])
      await bumpAuthorizationVersion(transaction, organizationId)
      return { organizationId, identity, role, createdAt: result.rows[0]!.created_at.toISOString() }
    })
  }

  async updateMemberRole(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const result = await transaction.query(`UPDATE organization_memberships m SET role = $4, updated_at = now()
        FROM principals p WHERE m.principal_id = p.id AND m.organization_id = $1 AND p.issuer = $2 AND p.subject = $3 AND m.role <> 'owner'`,
      [organizationId, identity.issuer, identity.subject, role])
      if (result.rowCount !== 1) throw new Error('membership not found or immutable')
      await bumpAuthorizationVersion(transaction, organizationId)
    })
  }

  async removeMember(organizationId: string, identity: AuthenticatedIdentity): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const result = await transaction.query(`DELETE FROM organization_memberships m USING principals p
        WHERE m.principal_id = p.id AND m.organization_id = $1 AND p.issuer = $2 AND p.subject = $3 AND m.role <> 'owner'`,
      [organizationId, identity.issuer, identity.subject])
      if (result.rowCount !== 1) throw new Error('membership not found or immutable')
      await bumpAuthorizationVersion(transaction, organizationId)
    })
  }

  async transferOwnership(organizationId: string, currentOwner: AuthenticatedIdentity, nextOwner: AuthenticatedIdentity): Promise<void> {
    await this.database.transaction(async (transaction) => {
      // Lock all active memberships so there is never a visible zero-owner or
      // two-owner state, and concurrent transfer/removal operations serialize.
      const locked = await transaction.query<MemberRoleRow>(`SELECT p.issuer,p.subject,m.role FROM organization_memberships m
        JOIN principals p ON p.id=m.principal_id WHERE m.organization_id=$1 AND m.status='active' FOR UPDATE OF m`, [organizationId])
      const current = locked.rows.find((row) => row.issuer === currentOwner.issuer && row.subject === currentOwner.subject)
      const next = locked.rows.find((row) => row.issuer === nextOwner.issuer && row.subject === nextOwner.subject)
      if (!current || current.role !== 'owner') throw new Error('current owner not found')
      if (!next || next.role === 'owner') throw new Error('next owner must be an active member')
      await transaction.query(`UPDATE organization_memberships m SET role=CASE WHEN p.issuer=$2 AND p.subject=$3 THEN 'admin' ELSE 'owner' END,updated_at=now()
        FROM principals p WHERE m.principal_id=p.id AND m.organization_id=$1 AND ((p.issuer=$2 AND p.subject=$3) OR (p.issuer=$4 AND p.subject=$5))`,
      [organizationId, currentOwner.issuer, currentOwner.subject, nextOwner.issuer, nextOwner.subject])
      await bumpAuthorizationVersion(transaction, organizationId)
    })
  }

  async bindExecutorInvite(inviteToken: string, unitId: string): Promise<void> {
    const organization = await this.database.query<{ id: string }>('SELECT id FROM organizations WHERE runtime_unit_id = $1 AND status = \'active\'', [unitId])
    if (!organization.rows[0]) throw new Error('organization not found')
    const pool = await this.database.query<{ id: string }>('SELECT id FROM executor_pools WHERE organization_id = $1 ORDER BY created_at LIMIT 1', [organization.rows[0].id])
    if (!pool.rows[0]) throw new Error('executor pool not configured')
    await this.database.query(`INSERT INTO executor_enrollment_tokens(id, organization_id, pool_id, token_hash, created_by, expires_at)
      SELECT $1, $2, $3, $4, m.principal_id, now() + interval '15 minutes'
      FROM organization_memberships m WHERE m.organization_id = $2 AND m.role = 'owner' AND m.status = 'active' ORDER BY m.created_at LIMIT 1`,
    [`enr_${randomBytes(13).toString('hex')}`, organization.rows[0].id, pool.rows[0].id, inviteKey(inviteToken)])
  }

  async findUnitByExecutorInvite(inviteToken: string): Promise<string | undefined> {
    const result = await this.database.query<{ runtime_unit_id: string }>(`SELECT o.runtime_unit_id
      FROM executor_enrollment_tokens t JOIN organizations o ON o.id = t.organization_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.used_count < t.max_uses AND t.expires_at > now() AND o.status = 'active'`, [inviteKey(inviteToken)])
    return result.rows[0]?.runtime_unit_id
  }

  async administrationSnapshot(organizationId: string): Promise<Record<string, unknown>> {
    const queries = await Promise.all([
      this.database.query('SELECT id,name,status,runtime_unit_id,authorization_version,created_at,updated_at FROM organizations WHERE id=$1', [organizationId]),
      this.database.query('SELECT contract_reference,support_tier,starts_at,ends_at,grace_ends_at,seat_limit,concurrent_session_limit,workspace_limit,monthly_token_limit,storage_bytes_limit FROM contract_entitlements WHERE organization_id=$1', [organizationId]),
      this.database.query('SELECT session_days,artifact_days,audit_days,deleted_resource_grace_days,version,updated_at FROM retention_policies WHERE organization_id=$1', [organizationId]),
      this.database.query(`SELECT COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens),0)::text AS tokens,COUNT(DISTINCT session_id)::int AS sessions,COUNT(*)::int AS entries FROM usage_ledger WHERE organization_id=$1 AND occurred_at>=date_trunc('month',now())`, [organizationId]),
      this.database.query('SELECT id,name,status,policy_version,created_at,updated_at FROM workspaces WHERE organization_id=$1 ORDER BY name', [organizationId]),
      this.database.query('SELECT id,workspace_id,name,mode,created_at FROM executor_pools WHERE organization_id=$1 ORDER BY created_at', [organizationId]),
      this.database.query('SELECT id,pool_id,name,status,credential_version,platform,capabilities,enrolled_at,last_seen_at,revoked_at,created_at FROM executors WHERE organization_id=$1 ORDER BY created_at DESC', [organizationId]),
      this.database.query('SELECT id,email_normalized,role,created_at,expires_at,accepted_at,revoked_at FROM organization_invites WHERE organization_id=$1 ORDER BY created_at DESC', [organizationId]),
      this.database.query('SELECT id,device,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,revocation_reason FROM browser_sessions WHERE organization_id=$1 ORDER BY last_seen_at DESC LIMIT 100', [organizationId]),
      this.database.query(`SELECT t.id,p.display_name,p.email,t.scopes,t.created_at,t.expires_at,t.revoked_at FROM service_account_tokens t JOIN principals p ON p.id=t.principal_id WHERE t.organization_id=$1 ORDER BY t.created_at DESC`, [organizationId]),
      this.database.query('SELECT id,url,topics,enabled,created_at FROM webhook_endpoints WHERE organization_id=$1 ORDER BY created_at DESC', [organizationId]),
      this.database.query('SELECT id,actor_kind,action,target_type,target_id,result,metadata,occurred_at FROM audit_events WHERE organization_id=$1 ORDER BY occurred_at DESC LIMIT 100', [organizationId]),
    ])
    const [organization, entitlement, retention, usage, workspaces, pools, executors, invites, sessions, serviceAccounts, webhooks, audit] = queries
    return { organization: organization.rows[0], entitlement: entitlement.rows[0], retention: retention.rows[0], usage: usage.rows[0], workspaces: workspaces.rows, executorPools: pools.rows, executors: executors.rows, invites: invites.rows, browserSessions: sessions.rows, serviceAccounts: serviceAccounts.rows, webhooks: webhooks.rows, audit: audit.rows, integrations: { secrets: 'local', artifacts: 'session-jsonl', telemetry: false, errorReporting: false, ticketing: false } }
  }

  async updateRetentionPolicy(organizationId: string, policy: { sessionDays: number; artifactDays: number; auditDays: number; deletedResourceGraceDays: number }): Promise<void> {
    const values = [policy.sessionDays, policy.artifactDays, policy.auditDays, policy.deletedResourceGraceDays]
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || values.slice(0, 3).some((value) => value < 1)) throw new Error('invalid_retention_policy')
    const result = await this.database.query(`UPDATE retention_policies SET session_days=$2,artifact_days=$3,audit_days=$4,deleted_resource_grace_days=$5,version=version+1,updated_at=now() WHERE organization_id=$1`, [organizationId, ...values])
    if (result.rowCount !== 1) throw new Error('retention_policy_not_found')
  }
}

type AccessRow = { id: string; name: string; status: OrganizationStatus; runtime_unit_id: string; created_at: Date; role: OrganizationRole; membership_created_at: Date }
type MemberRow = { issuer: string; subject: string; display_name: string | null; email: string | null; role: OrganizationRole; created_at: Date }
type MemberRoleRow = { issuer: string; subject: string; role: OrganizationRole }

function accessFromRow(row: AccessRow, identity: AuthenticatedIdentity): OrganizationAccess {
  const organization: Organization = { id: row.id, name: row.name, unitId: row.runtime_unit_id, status: row.status, createdAt: row.created_at.toISOString() }
  return { organization, membership: { organizationId: row.id, identity, role: row.role, createdAt: row.membership_created_at.toISOString() } }
}
function membershipFromRow(organizationId: string, row: MemberRow): OrganizationMembership {
  const identity: AuthenticatedIdentity = { issuer: row.issuer, subject: row.subject, ...(row.display_name ? { displayName: row.display_name } : {}), ...(row.email ? { email: row.email } : {}) }
  return { organizationId, identity, role: row.role, createdAt: row.created_at.toISOString() }
}
function principalIdFor(identity: AuthenticatedIdentity): string { return `prn_${createHash('sha256').update(identityKey(identity)).digest('base64url').slice(0, 26)}` }
async function bumpAuthorizationVersion(transaction: SqlExecutor, organizationId: string): Promise<void> {
  const result = await transaction.query('UPDATE organizations SET authorization_version = authorization_version + 1, updated_at = now() WHERE id = $1', [organizationId])
  if (result.rowCount !== 1) throw new Error('organization not found')
}

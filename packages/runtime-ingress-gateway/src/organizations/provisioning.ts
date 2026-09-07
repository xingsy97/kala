import { createHash, randomBytes } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import { identityKey } from '../assignments/store.js'
import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'

export type ProvisionOrganizationInput = {
  operationId: string
  name: string
  owner: AuthenticatedIdentity
  contractReference: string
  supportTier: 'standard' | 'business' | 'enterprise'
  startsAt: Date
  endsAt: Date
  graceEndsAt?: Date
  seatLimit: number
  concurrentSessionLimit: number
  workspaceLimit?: number
  monthlyTokenLimit?: bigint
  storageBytesLimit?: bigint
}

export class OrganizationProvisioningService {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async provision(input: ProvisionOrganizationInput): Promise<{ organizationId: string; runtimeUnitId: string; alreadyApplied: boolean }> {
    validateProvisioning(input)
    return this.database.transaction(async (transaction) => {
      const prior = await findOperation(transaction, input.operationId)
      if (prior) return { organizationId: prior.aggregate_id, runtimeUnitId: prior.runtime_unit_id, alreadyApplied: true }
      const organizationId = newId('org')
      const runtimeUnitId = newId('tenant')
      const ownerId = principalId(input.owner)
      const poolId = newId('pool')
      await transaction.query(`INSERT INTO principals(id,kind,issuer,subject,display_name,email)
        VALUES($1,'human',$2,$3,$4,$5) ON CONFLICT (issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name,email=EXCLUDED.email`,
      [ownerId, input.owner.issuer, input.owner.subject, input.owner.displayName ?? null, input.owner.email ?? null])
      await transaction.query(`INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES($1,$2,'provisioning',$3)`, [organizationId, input.name.trim(), runtimeUnitId])
      await transaction.query(`INSERT INTO organization_memberships(organization_id,principal_id,role,status) VALUES($1,(SELECT id FROM principals WHERE issuer=$2 AND subject=$3),'owner','active')`, [organizationId, input.owner.issuer, input.owner.subject])
      await transaction.query(`INSERT INTO contract_entitlements(organization_id,contract_reference,support_tier,starts_at,ends_at,grace_ends_at,seat_limit,concurrent_session_limit,workspace_limit,monthly_token_limit,storage_bytes_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [organizationId, input.contractReference, input.supportTier, input.startsAt, input.endsAt, input.graceEndsAt ?? null, input.seatLimit, input.concurrentSessionLimit, input.workspaceLimit ?? 5, input.monthlyTokenLimit ?? null, input.storageBytesLimit ?? null])
      await transaction.query(`INSERT INTO retention_policies(organization_id,session_days,artifact_days,audit_days,deleted_resource_grace_days) VALUES($1,90,90,365,30)`, [organizationId])
      await transaction.query(`INSERT INTO runtime_unit_placements(runtime_unit_id,organization_id,desired_state,generation,last_operation_id) VALUES($1,$2,'ready',1,$3)`, [runtimeUnitId, organizationId, input.operationId])
      await transaction.query(`INSERT INTO executor_pools(id,organization_id,name,mode) VALUES($1,$2,'Default organization pool','organization')`, [poolId, organizationId])
      await transaction.query(`UPDATE organizations SET status='active',updated_at=now() WHERE id=$1`, [organizationId])
      await appendControlEvent(transaction, input.operationId, organizationId, ownerId, 'organization.provisioned', { contractReference: input.contractReference })
      return { organizationId, runtimeUnitId, alreadyApplied: false }
    })
  }

  async setStatus(input: {
    operationId: string
    organizationId: string
    status: 'active' | 'suspended' | 'closing' | 'closed'
    actorPrincipalId: string
    closeConfirmation?: string
    backupReference?: string
  }): Promise<{ alreadyApplied: boolean }> {
    return this.database.transaction(async (transaction) => {
      if (await findOperation(transaction, input.operationId)) return { alreadyApplied: true }
      if (input.status === 'closed') validateCloseConfirmation(input.organizationId, input.closeConfirmation, input.backupReference)
      const desiredState = input.status === 'active' ? 'ready' : input.status === 'closed' ? 'deleted' : 'suspended'
      const result = await transaction.query(`UPDATE organizations SET status=$2,authorization_version=authorization_version+1,updated_at=now(),
        suspended_at=CASE WHEN $2='suspended' THEN now() ELSE suspended_at END,closed_at=CASE WHEN $2='closed' THEN now() ELSE closed_at END WHERE id=$1 AND status<>'closed'`, [input.organizationId, input.status])
      if (result.rowCount !== 1) throw new Error('organization not found or already closed')
      await transaction.query(`UPDATE runtime_unit_placements SET desired_state=$2,generation=generation+1,last_operation_id=$3,updated_at=now() WHERE organization_id=$1`, [input.organizationId, desiredState, input.operationId])
      await transaction.query(`UPDATE browser_sessions SET revoked_at=now(),revocation_reason='administrator' WHERE organization_id=$1 AND revoked_at IS NULL`, [input.organizationId])
      await appendControlEvent(transaction, input.operationId, input.organizationId, input.actorPrincipalId, `organization.${input.status}`, input.status === 'closed'
        ? { backupReference: input.backupReference, closeConfirmation: 'verified' }
        : {})
      return { alreadyApplied: false }
    })
  }

  async renew(input: { operationId: string; organizationId: string; endsAt: Date; graceEndsAt?: Date; actorPrincipalId: string }): Promise<{ alreadyApplied: boolean }> {
    return this.database.transaction(async (transaction) => {
      if (await findOperation(transaction, input.operationId)) return { alreadyApplied: true }
      const result = await transaction.query(`UPDATE contract_entitlements SET ends_at=$2,grace_ends_at=$3,updated_at=now() WHERE organization_id=$1 AND $2>starts_at`, [input.organizationId, input.endsAt, input.graceEndsAt ?? null])
      if (result.rowCount !== 1) throw new Error('invalid entitlement renewal')
      await appendControlEvent(transaction, input.operationId, input.organizationId, input.actorPrincipalId, 'organization.contract_renewed', { endsAt: input.endsAt.toISOString() })
      return { alreadyApplied: false }
    })
  }
}

async function appendControlEvent(transaction: SqlExecutor, operationId: string, organizationId: string, actorPrincipalId: string, action: string, metadata: object): Promise<void> {
  await transaction.query(`INSERT INTO audit_events(id,organization_id,actor_principal_id,actor_kind,action,target_type,target_id,result,metadata) VALUES($1,$2,$3,'human',$4,'organization',$2,'succeeded',$5)`, [newId('aud'), organizationId, actorPrincipalId, action, metadata])
  await transaction.query(`INSERT INTO outbox_events(id,organization_id,topic,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,'organization',$2,$4)`, [operationId, organizationId, action, { operationId, action, organizationId, ...metadata }])
}
async function findOperation(transaction: SqlExecutor, operationId: string): Promise<{ aggregate_id: string; runtime_unit_id: string } | undefined> {
  const result = await transaction.query<{ aggregate_id: string; runtime_unit_id: string }>(`SELECT e.aggregate_id,o.runtime_unit_id FROM outbox_events e JOIN organizations o ON o.id=e.aggregate_id WHERE e.id=$1`, [operationId])
  return result.rows[0]
}
function validateProvisioning(input: ProvisionOrganizationInput): void {
  if (!input.operationId || input.operationId.length > 200) throw new Error('invalid operationId')
  if (!input.name.trim() || input.name.trim().length > 200) throw new Error('invalid organization name')
  if (!input.owner.issuer || !input.owner.subject) throw new Error('invalid owner identity')
  if (!input.contractReference || input.endsAt <= input.startsAt || (input.graceEndsAt && input.graceEndsAt < input.endsAt)) throw new Error('invalid contract term')
  if (!Number.isSafeInteger(input.seatLimit) || input.seatLimit < 1 || !Number.isSafeInteger(input.concurrentSessionLimit) || input.concurrentSessionLimit < 1) throw new Error('invalid contract limits')
  if (input.workspaceLimit !== undefined && (!Number.isSafeInteger(input.workspaceLimit) || input.workspaceLimit < 1)) throw new Error('invalid workspace limit')
}
function validateCloseConfirmation(organizationId: string, confirmation: string | undefined, backupReference: string | undefined): void {
  if (confirmation !== `DELETE ${organizationId}`) throw new Error('organization close confirmation required')
  if (!backupReference?.trim() || backupReference.length > 200) throw new Error('organization close backup reference required')
}
function principalId(identity: AuthenticatedIdentity): string { return `prn_${createHash('sha256').update(identityKey(identity)).digest('base64url').slice(0,26)}` }
function newId(prefix: string): string { return `${prefix}_${randomBytes(16).toString('base64url')}` }

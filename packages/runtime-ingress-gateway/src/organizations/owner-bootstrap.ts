import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import { OrganizationProvisioningService, type ProvisionOrganizationInput } from './provisioning.js'
import { normalizeInviteEmail } from './store.js'

const TOKEN_PREFIX = 'ak_owner_bootstrap_'
const MAX_LIFETIME_MS = 30 * 60_000
// Only exact, unprivileged localhost HTTP origins are eligible; the operator also
// verifies that issuer and public origin equal the persisted installation config.
function localHttpOrigin(value: string): boolean {
  const match = /^http:\/\/localhost:([1-9][0-9]{3,4})$/u.exec(value)
  return Boolean(match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535)
}

export type OwnerBootstrapContract = Omit<ProvisionOrganizationInput, 'owner'>
export type OwnerBootstrapStatus = {
  id: string
  expectedIssuer: string
  expectedEmail: string
  expiresAt: string
  state: 'awaiting_login' | 'awaiting_confirmation' | 'confirmed' | 'expired'
  candidate?: { issuer: string; subject: string; email: string; displayName?: string }
  organizationId?: string
}

export interface OwnerBootstrapGateway {
  assertAvailable(tokenHash: string): Promise<void>
  captureCandidate(tokenHash: string, identity: AuthenticatedIdentity): Promise<{ bootstrapId: string; confirmationCode: string }>
}

export class OwnerBootstrapService implements OwnerBootstrapGateway {
  private readonly provisioning: OrganizationProvisioningService

  constructor(private readonly database: ControlPlaneDatabase, private readonly now: () => number = Date.now) {
    this.provisioning = new OrganizationProvisioningService(database)
  }

  async create(input: { expectedIssuer: string; expectedEmail: string; expiresAt: Date; contract: OwnerBootstrapContract }): Promise<{ id: string; token: string; expiresAt: string }> {
    const expectedIssuer = normalizeOwnerBootstrapIssuer(input.expectedIssuer)
    const expectedEmail = normalizeInviteEmail(input.expectedEmail)
    const now = this.now()
    if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= now || input.expiresAt.getTime() > now + MAX_LIFETIME_MS) throw new Error('invalid_owner_bootstrap_expiration')
    const id = `ob_${randomBytes(16).toString('base64url')}`
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    await this.database.query(`INSERT INTO owner_bootstrap_authorizations(
      id,token_hash,expected_issuer,expected_email,organization_name,contract_reference,support_tier,starts_at,ends_at,grace_ends_at,
      seat_limit,concurrent_session_limit,workspace_limit,operation_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [
      id, ownerBootstrapHash(token), expectedIssuer, expectedEmail, input.contract.name.trim(), input.contract.contractReference,
      input.contract.supportTier, input.contract.startsAt, input.contract.endsAt, input.contract.graceEndsAt ?? null,
      input.contract.seatLimit, input.contract.concurrentSessionLimit, input.contract.workspaceLimit ?? 5,
      input.contract.operationId, input.expiresAt,
    ])
    return { id, token, expiresAt: input.expiresAt.toISOString() }
  }

  async assertAvailable(tokenHash: string): Promise<void> {
    const result = await this.database.query(`SELECT id FROM owner_bootstrap_authorizations
      WHERE token_hash=$1 AND confirmed_at IS NULL AND candidate_at IS NULL AND expires_at>now()`, [tokenHash])
    if (!result.rows[0]) throw new Error('owner_bootstrap_not_available')
  }

  async captureCandidate(tokenHash: string, identity: AuthenticatedIdentity): Promise<{ bootstrapId: string; confirmationCode: string }> {
    return this.database.transaction(async (transaction) => {
      const row = await findAuthorizationByToken(transaction, tokenHash)
      if (!row || row.confirmed_at || row.candidate_at || row.expires_at.getTime() <= this.now()) throw new Error('owner_bootstrap_not_available')
      if (normalizeOwnerBootstrapIssuer(identity.issuer) !== row.expected_issuer) throw new Error('owner_bootstrap_issuer_mismatch')
      if (!identity.email || identity.emailVerified !== true) throw new Error('owner_bootstrap_verified_email_required')
      if (normalizeInviteEmail(identity.email) !== row.expected_email) throw new Error('owner_bootstrap_email_mismatch')
      const confirmationCode = randomBytes(9).toString('base64url')
      const updated = await transaction.query(`UPDATE owner_bootstrap_authorizations SET
        candidate_issuer=$2,candidate_subject=$3,candidate_email=$4,candidate_display_name=$5,candidate_code_hash=$6,candidate_at=now()
        WHERE id=$1 AND candidate_at IS NULL AND confirmed_at IS NULL AND expires_at>now()`, [
        row.id, normalizeOwnerBootstrapIssuer(identity.issuer), identity.subject, normalizeInviteEmail(identity.email), identity.displayName ?? null, ownerBootstrapHash(confirmationCode),
      ])
      if (updated.rowCount !== 1) throw new Error('owner_bootstrap_not_available')
      return { bootstrapId: row.id, confirmationCode }
    })
  }

  async status(id: string): Promise<OwnerBootstrapStatus> {
    const result = await this.database.query<AuthorizationRow>('SELECT * FROM owner_bootstrap_authorizations WHERE id=$1', [id])
    const row = result.rows[0]
    if (!row) throw new Error('owner_bootstrap_not_found')
    return statusFromRow(row, this.now())
  }

  async confirm(id: string, confirmationCode: string): Promise<{ organizationId: string; runtimeUnitId: string }> {
    if (!/^[A-Za-z0-9_-]{12}$/u.test(confirmationCode)) throw new Error('owner_bootstrap_confirmation_mismatch')
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<AuthorizationRow>('SELECT * FROM owner_bootstrap_authorizations WHERE id=$1 FOR UPDATE', [id])
      const row = result.rows[0]
      if (!row || row.confirmed_at) throw new Error('owner_bootstrap_not_available')
      if (row.expires_at.getTime() <= this.now()) throw new Error('owner_bootstrap_expired')
      if (!row.candidate_at || !row.candidate_issuer || !row.candidate_subject || !row.candidate_email || !row.candidate_code_hash) throw new Error('owner_bootstrap_candidate_required')
      if (!sameHash(row.candidate_code_hash, ownerBootstrapHash(confirmationCode))) throw new Error('owner_bootstrap_confirmation_mismatch')
      const provisioned = await this.provisioning.provisionInTransaction(transaction, {
        operationId: row.operation_id,
        name: row.organization_name,
        owner: { issuer: row.candidate_issuer, subject: row.candidate_subject, email: row.candidate_email, emailVerified: true, ...(row.candidate_display_name ? { displayName: row.candidate_display_name } : {}) },
        contractReference: row.contract_reference,
        supportTier: row.support_tier,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        ...(row.grace_ends_at ? { graceEndsAt: row.grace_ends_at } : {}),
        seatLimit: row.seat_limit,
        concurrentSessionLimit: row.concurrent_session_limit,
        workspaceLimit: row.workspace_limit,
      })
      if (provisioned.alreadyApplied) throw new Error('owner_bootstrap_operation_already_applied')
      const consumed = await transaction.query('UPDATE owner_bootstrap_authorizations SET confirmed_at=now(),organization_id=$2 WHERE id=$1 AND confirmed_at IS NULL', [id, provisioned.organizationId])
      if (consumed.rowCount !== 1) throw new Error('owner_bootstrap_not_available')
      return { organizationId: provisioned.organizationId, runtimeUnitId: provisioned.runtimeUnitId }
    })
  }
}

export function ownerBootstrapHash(value: string): string {
  return createHash('sha256').update(`kala-owner-bootstrap\0${value}`).digest('hex')
}

export function isOwnerBootstrapToken(value: string): boolean {
  return new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`, 'u').test(value)
}

type AuthorizationRow = {
  id: string; expected_issuer: string; expected_email: string; organization_name: string; contract_reference: string
  support_tier: 'standard' | 'business' | 'enterprise'; starts_at: Date; ends_at: Date; grace_ends_at: Date | null
  seat_limit: number; concurrent_session_limit: number; workspace_limit: number; operation_id: string; expires_at: Date
  candidate_issuer: string | null; candidate_subject: string | null; candidate_email: string | null; candidate_display_name: string | null
  candidate_code_hash: string | null; candidate_at: Date | null; confirmed_at: Date | null; organization_id: string | null
}

async function findAuthorizationByToken(transaction: SqlExecutor, tokenHash: string): Promise<AuthorizationRow | undefined> {
  const result = await transaction.query<AuthorizationRow>('SELECT * FROM owner_bootstrap_authorizations WHERE token_hash=$1 FOR UPDATE', [tokenHash])
  return result.rows[0]
}

function statusFromRow(row: AuthorizationRow, now: number): OwnerBootstrapStatus {
  const state = row.confirmed_at ? 'confirmed' : row.expires_at.getTime() <= now ? 'expired' : row.candidate_at ? 'awaiting_confirmation' : 'awaiting_login'
  return {
    id: row.id, expectedIssuer: row.expected_issuer, expectedEmail: row.expected_email, expiresAt: row.expires_at.toISOString(), state,
    ...(row.candidate_issuer && row.candidate_subject && row.candidate_email ? { candidate: { issuer: row.candidate_issuer, subject: row.candidate_subject, email: row.candidate_email, ...(row.candidate_display_name ? { displayName: row.candidate_display_name } : {}) } } : {}),
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
  }
}

export function normalizeOwnerBootstrapIssuer(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('invalid_owner_bootstrap_issuer') }
  if ((parsed.protocol !== 'https:' && !localHttpOrigin(value)) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('invalid_owner_bootstrap_issuer')
  return parsed.href.replace(/\/$/u, '')
}

export function normalizeOwnerBootstrapOrigin(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('invalid_owner_bootstrap_origin') }
  if ((parsed.protocol !== 'https:' && !localHttpOrigin(value)) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('invalid_owner_bootstrap_origin')
  return parsed.origin
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex'), rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

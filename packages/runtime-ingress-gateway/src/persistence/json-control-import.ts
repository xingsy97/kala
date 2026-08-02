import { createHash } from 'node:crypto'
import { copyFile, readFile } from 'node:fs/promises'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import { identityKey } from '../assignments/store.js'
import type { BrowserSession } from '../auth/browser-session-store.js'
import type { SqlExecutor } from './postgres.js'

export type JsonControlImportPlan = {
  checksum: string
  organizations: Array<{ id: string; name: string; unitId: string; createdAt: string }>
  memberships: Array<{ organizationId: string; identity: AuthenticatedIdentity; role: 'owner' | 'admin' | 'member' | 'viewer'; createdAt: string }>
  sessions: BrowserSession[]
  skippedExecutorInvites: number
}

export async function planJsonControlImport(directoryPath: string, sessionPath?: string): Promise<JsonControlImportPlan> {
  const directoryRaw = await readFile(directoryPath, 'utf8')
  const directory = JSON.parse(directoryRaw) as {
    schemaVersion: number
    organizations?: JsonControlImportPlan['organizations']
    memberships?: JsonControlImportPlan['memberships']
    executorInviteUnits?: Record<string, string>
  }
  if (directory.schemaVersion !== 4 || !Array.isArray(directory.organizations) || !Array.isArray(directory.memberships)) throw new Error('JSON control import requires organization schemaVersion 4')
  const sessionsRaw = sessionPath ? await readFile(sessionPath, 'utf8') : undefined
  const sessionsFile = sessionsRaw ? JSON.parse(sessionsRaw) as { schemaVersion: number; sessions?: BrowserSession[] } : undefined
  if (sessionsFile && (sessionsFile.schemaVersion !== 1 || !Array.isArray(sessionsFile.sessions))) throw new Error('unsupported browser session JSON')
  const organizationIds = new Set(directory.organizations.map((organization) => organization.id))
  if (organizationIds.size !== directory.organizations.length) throw new Error('duplicate organization id')
  for (const membership of directory.memberships) if (!organizationIds.has(membership.organizationId)) throw new Error('dangling organization membership')
  const checksum = createHash('sha256').update(directoryRaw).update('\0').update(sessionsRaw ?? '').digest('hex')
  return {
    checksum,
    organizations: directory.organizations,
    memberships: directory.memberships,
    sessions: sessionsFile?.sessions ?? [],
    skippedExecutorInvites: Object.keys(directory.executorInviteUnits ?? {}).length,
  }
}

export async function importJsonControlPlan(
  transaction: SqlExecutor,
  plan: JsonControlImportPlan,
  sourceBackupPath: string,
): Promise<{ organizations: number; memberships: number; sessions: number; alreadyImported: boolean }> {
  const existing = await transaction.query('SELECT 1 FROM control_plane_imports WHERE source_kind=$1 AND source_checksum=$2', ['json-v4', plan.checksum])
  if (existing.rowCount) return { organizations: 0, memberships: 0, sessions: 0, alreadyImported: true }
  for (const organization of plan.organizations) {
    await transaction.query(`INSERT INTO organizations(id,name,status,runtime_unit_id,created_at,updated_at)
      VALUES($1,$2,'active',$3,$4,$4) ON CONFLICT (id) DO NOTHING`, [organization.id, organization.name, organization.unitId, organization.createdAt])
    await transaction.query(`INSERT INTO runtime_unit_placements(runtime_unit_id,organization_id,desired_state,generation,last_operation_id)
      VALUES($1,$2,'ready',1,$3) ON CONFLICT (runtime_unit_id) DO NOTHING`, [organization.unitId, organization.id, `json-import:${plan.checksum}`])
  }
  for (const membership of plan.memberships) {
    const principalId = principalIdFor(membership.identity)
    await transaction.query(`INSERT INTO principals(id,kind,issuer,subject,display_name,email,created_at,updated_at)
      VALUES($1,'human',$2,$3,$4,$5,$6,$6) ON CONFLICT (issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name,email=EXCLUDED.email`,
    [principalId, membership.identity.issuer, membership.identity.subject, membership.identity.displayName ?? null, membership.identity.email ?? null, membership.createdAt])
    await transaction.query(`INSERT INTO organization_memberships(organization_id,principal_id,role,status,created_at,updated_at)
      VALUES($1,(SELECT id FROM principals WHERE issuer=$2 AND subject=$3),$4,'active',$5,$5) ON CONFLICT (organization_id,principal_id) DO NOTHING`,
    [membership.organizationId, membership.identity.issuer, membership.identity.subject, membership.role, membership.createdAt])
  }
  for (const session of plan.sessions) {
    const organization = plan.memberships.find((membership) => sameIdentity(membership.identity, session.identity))
    if (!organization) throw new Error(`browser session ${session.id} has no imported membership`)
    await transaction.query(`INSERT INTO browser_sessions(id,principal_id,organization_id,token_hash,cache_namespace,device,encrypted_refresh_token,provider_refresh_after,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,revocation_reason)
      VALUES($1,(SELECT id FROM principals WHERE issuer=$2 AND subject=$3),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`, [
      session.id, session.identity.issuer, session.identity.subject, organization.organizationId, session.tokenHash, session.cacheNamespace, session.device,
      session.refreshToken ?? null, dateOrNull(session.providerRefreshAfter), new Date(session.createdAt), new Date(session.lastSeenAt), new Date(session.idleExpiresAt), new Date(session.absoluteExpiresAt), dateOrNull(session.revokedAt), session.revocationReason ?? null,
    ])
  }
  const summary = { organizations: plan.organizations.length, memberships: plan.memberships.length, sessions: plan.sessions.length, skippedExecutorInvites: plan.skippedExecutorInvites }
  await transaction.query(`INSERT INTO control_plane_imports(id,source_kind,source_checksum,source_backup_path,summary)
    VALUES($1,'json-v4',$2,$3,$4)`, [`import_${plan.checksum.slice(0, 26)}`, plan.checksum, sourceBackupPath, summary])
  return { organizations: summary.organizations, memberships: summary.memberships, sessions: summary.sessions, alreadyImported: false }
}

export async function backupJsonControlFiles(directoryPath: string, backupPrefix: string, sessionPath?: string): Promise<string> {
  const directoryBackup = `${backupPrefix}.directory.json`
  await copyFile(directoryPath, directoryBackup)
  if (sessionPath) await copyFile(sessionPath, `${backupPrefix}.sessions.json`)
  return directoryBackup
}

function principalIdFor(identity: AuthenticatedIdentity): string { return `prn_${createHash('sha256').update(identityKey(identity)).digest('base64url').slice(0, 26)}` }
function sameIdentity(left: AuthenticatedIdentity, right: AuthenticatedIdentity): boolean { return left.issuer === right.issuer && left.subject === right.subject }
function dateOrNull(value?: number): Date | null { return value === undefined ? null : new Date(value) }

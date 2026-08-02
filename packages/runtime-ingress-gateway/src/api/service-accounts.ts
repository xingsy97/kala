import { createHash, randomBytes } from 'node:crypto'
import type { SqlExecutor } from '../persistence/postgres.js'

export type ServiceAccountScope = 'organization:read' | 'organization:write' | 'workspace:read' | 'workspace:write' | 'audit:read'
export class ServiceAccountService {
  constructor(private readonly database: SqlExecutor) {}
  async create(input: { organizationId: string; name: string; scopes: readonly ServiceAccountScope[] }): Promise<{ id: string; token: string }> {
    if (!input.name.trim() || input.scopes.length === 0) throw new Error('invalid service account')
    const id = `prn_${randomBytes(16).toString('base64url')}`, token = `ak_sa_${randomBytes(32).toString('base64url')}`
    await this.database.query(`INSERT INTO principals(id,kind,display_name) VALUES($1,'service_account',$2)`, [id, input.name.trim()])
    await this.database.query(`INSERT INTO service_account_tokens(id,organization_id,principal_id,token_hash,scopes) VALUES($1,$2,$3,$4,$5)`, [`sat_${randomBytes(16).toString('base64url')}`, input.organizationId, id, hash(token), input.scopes])
    return { id, token }
  }
  async authenticate(token: string): Promise<{ principalId: string; organizationId: string; scopes: readonly ServiceAccountScope[] } | undefined> {
    const result = await this.database.query<{ principal_id: string; organization_id: string; scopes: ServiceAccountScope[] }>('SELECT principal_id,organization_id,scopes FROM service_account_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())', [hash(token)])
    const row = result.rows[0]; return row ? { principalId: row.principal_id, organizationId: row.organization_id, scopes: row.scopes } : undefined
  }
  async revoke(principalId: string): Promise<void> { await this.database.query('UPDATE service_account_tokens SET revoked_at=now() WHERE principal_id=$1 AND revoked_at IS NULL', [principalId]) }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

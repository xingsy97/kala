import { describe, expect, it } from 'vitest'

import type { ControlPlaneDatabase, SqlQueryResult } from '../persistence/postgres.js'
import { normalizeOwnerBootstrapOrigin, OwnerBootstrapService, ownerBootstrapHash } from './owner-bootstrap.js'

type Row = Record<string, unknown>

class BootstrapDatabase implements ControlPlaneDatabase {
  authorization?: Row
  organizationsCreated = 0
  private transactions = Promise.resolve()

  async transaction<T>(operation: (transaction: this) => Promise<T>): Promise<T> {
    const prior = this.transactions
    let release!: () => void
    this.transactions = new Promise<void>((resolve) => { release = resolve })
    await prior
    try { return await operation(this) } finally { release() }
  }

  async query<Result extends Row = Row>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
    const sql = text.trim().replace(/\s+/gu, ' ')
    if (sql.startsWith('INSERT INTO owner_bootstrap_authorizations')) {
      this.authorization = {
        id: values[0], token_hash: values[1], expected_issuer: values[2], expected_email: values[3], organization_name: values[4],
        contract_reference: values[5], support_tier: values[6], starts_at: values[7], ends_at: values[8], grace_ends_at: values[9],
        seat_limit: values[10], concurrent_session_limit: values[11], workspace_limit: values[12], operation_id: values[13], expires_at: values[14],
        candidate_issuer: null, candidate_subject: null, candidate_email: null, candidate_display_name: null, candidate_code_hash: null,
        candidate_at: null, confirmed_at: null, organization_id: null,
      }
      return result([], 1)
    }
    if (sql.startsWith('SELECT * FROM owner_bootstrap_authorizations WHERE token_hash')) {
      return result(this.authorization && this.authorization.token_hash === values[0] ? [this.authorization as Result] : [])
    }
    if (sql.startsWith('SELECT * FROM owner_bootstrap_authorizations WHERE id=')) {
      return result(this.authorization && this.authorization.id === values[0] ? [this.authorization as Result] : [])
    }
    if (sql.startsWith('SELECT id FROM owner_bootstrap_authorizations')) {
      const live = this.authorization && this.authorization.token_hash === values[0] && !this.authorization.candidate_at && !this.authorization.confirmed_at
      return result(live ? [{ id: this.authorization!.id } as unknown as Result] : [])
    }
    if (sql.startsWith('UPDATE owner_bootstrap_authorizations SET candidate_issuer')) {
      if (!this.authorization || this.authorization.id !== values[0] || this.authorization.candidate_at) return result([], 0)
      Object.assign(this.authorization, { candidate_issuer: values[1], candidate_subject: values[2], candidate_email: values[3], candidate_display_name: values[4], candidate_code_hash: values[5], candidate_at: new Date() })
      return result([], 1)
    }
    if (sql.startsWith('UPDATE owner_bootstrap_authorizations SET confirmed_at')) {
      if (!this.authorization || this.authorization.id !== values[0] || this.authorization.confirmed_at) return result([], 0)
      Object.assign(this.authorization, { confirmed_at: new Date(), organization_id: values[1] })
      return result([], 1)
    }
    if (sql.startsWith('SELECT e.aggregate_id')) return result([])
    if (sql.startsWith('SELECT m.organization_id')) return result([])
    if (sql.startsWith('INSERT INTO organizations')) this.organizationsCreated += 1
    return result([], 1)
  }

  async health(): Promise<{ ok: true; schemaVersion: number }> { return { ok: true, schemaVersion: 5 } }
  async close(): Promise<void> {}
}

function result<Result extends Row>(rows: Result[], rowCount = rows.length): SqlQueryResult<Result> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}

function setup() {
  let now = Date.parse('2026-10-07T03:00:00Z')
  const database = new BootstrapDatabase()
  const service = new OwnerBootstrapService(database, () => now)
  const create = (expectedIssuer = 'https://idp.example.test') => service.create({
    expectedIssuer, expectedEmail: 'owner@example.test', expiresAt: new Date(now + 15 * 60_000),
    contract: { operationId: 'first-owner-1', name: 'Example Org', contractReference: 'contract-1', supportTier: 'standard', startsAt: new Date(now), endsAt: new Date(now + 86_400_000), seatLimit: 10, concurrentSessionLimit: 5 },
  })
  return { database, service, create, advance(ms: number) { now += ms } }
}

describe('trusted owner bootstrap', () => {
  it('accepts a configured localhost HTTP issuer and still waits for operator confirmation', async () => {
    const { database, service, create } = setup()
    const created = await create('http://localhost:13102')
    const candidate = await service.captureCandidate(ownerBootstrapHash(created.token), {
      issuer: 'http://localhost:13102', subject: 'opaque-owner-sub', email: 'owner@example.test', emailVerified: true,
    })

    expect(database.organizationsCreated).toBe(0)
    expect(await service.status(created.id)).toMatchObject({
      state: 'awaiting_confirmation',
      candidate: { issuer: 'http://localhost:13102', subject: 'opaque-owner-sub', email: 'owner@example.test' },
    })
    await expect(service.confirm(created.id, 'AAAAAAAAAAAA')).rejects.toThrow('owner_bootstrap_confirmation_mismatch')
    expect(candidate.confirmationCode).toMatch(/^[A-Za-z0-9_-]{12}$/u)
    expect(database.organizationsCreated).toBe(0)
  })

  it.each([
    'http://localhost:13002/',
    'http://localhost:13002/path',
    'http://localhost:13002?query=value',
    'http://localhost:999',
    'http://localhost:65536',
    'http://127.0.0.1:13002',
    `http://${[192, 168, 1, 55].join('.')}:13102`,
    'http://idp.example.test',
  ])('rejects non-whitelisted HTTP issuer %s', async (issuer) => {
    const { database, create } = setup()
    await expect(create(issuer)).rejects.toThrow('invalid_owner_bootstrap_issuer')
    expect(database.authorization).toBeUndefined()
    expect(database.organizationsCreated).toBe(0)
  })

  it('allows a configured localhost bootstrap origin and rejects other HTTP origins', () => {
    expect(normalizeOwnerBootstrapOrigin('http://localhost:13101')).toBe('http://localhost:13101')
    expect(normalizeOwnerBootstrapOrigin('https://kala.example.test')).toBe('https://kala.example.test')
    for (const origin of ['http://localhost:13001/', 'http://localhost:13001/path', 'http://localhost:999', 'http://127.0.0.1:13001', `http://${[192, 168, 1, 55].join('.')}:13101`, 'http://kala.example.test']) {
      expect(() => normalizeOwnerBootstrapOrigin(origin)).toThrow('invalid_owner_bootstrap_origin')
    }
  })

  it.each([
    ['unverified email', { issuer: 'https://idp.example.test', subject: 'owner-sub', email: 'owner@example.test', emailVerified: false }, 'owner_bootstrap_verified_email_required'],
    ['invalid email', { issuer: 'https://idp.example.test', subject: 'owner-sub', email: 'not-an-email', emailVerified: true }, 'invalid_invite_email'],
    ['wrong email', { issuer: 'https://idp.example.test', subject: 'owner-sub', email: 'attacker@example.test', emailVerified: true }, 'owner_bootstrap_email_mismatch'],
    ['wrong issuer', { issuer: 'https://other-idp.example.test', subject: 'owner-sub', email: 'owner@example.test', emailVerified: true }, 'owner_bootstrap_issuer_mismatch'],
  ])('rejects %s callback claims without creating an organization', async (_label, identity, error) => {
    const { database, service, create } = setup()
    const created = await create()
    await expect(service.captureCandidate(ownerBootstrapHash(created.token), identity)).rejects.toThrow(error)
    expect(database.organizationsCreated).toBe(0)
  })

  it('rejects an expired callback and never provisions from browser completion alone', async () => {
    const { database, service, create, advance } = setup()
    const created = await create()
    advance(16 * 60_000)
    await expect(service.captureCandidate(ownerBootstrapHash(created.token), { issuer: 'https://idp.example.test', subject: 'owner-sub', email: 'owner@example.test', emailVerified: true })).rejects.toThrow('owner_bootstrap_not_available')
    expect(database.organizationsCreated).toBe(0)
  })

  it('requires the operator-held comparison step, rejects replay, and serializes concurrent confirmation', async () => {
    const { database, service, create } = setup()
    const created = await create()
    const candidate = await service.captureCandidate(ownerBootstrapHash(created.token), { issuer: 'https://idp.example.test', subject: 'opaque-owner-sub', email: 'owner@example.test', emailVerified: true, displayName: 'Owner' })
    expect(database.organizationsCreated).toBe(0)
    await expect(service.confirm(created.id, 'AAAAAAAAAAAA')).rejects.toThrow('owner_bootstrap_confirmation_mismatch')
    expect(database.organizationsCreated).toBe(0)

    const attempts = await Promise.allSettled([service.confirm(created.id, candidate.confirmationCode), service.confirm(created.id, candidate.confirmationCode)])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    expect(database.organizationsCreated).toBe(1)
    await expect(service.confirm(created.id, candidate.confirmationCode)).rejects.toThrow('owner_bootstrap_not_available')
    expect((await service.status(created.id)).state).toBe('confirmed')
  })
})

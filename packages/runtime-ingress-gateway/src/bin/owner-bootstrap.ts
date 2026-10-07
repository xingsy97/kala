import process from 'node:process'

import { normalizeOwnerBootstrapOrigin, OwnerBootstrapService } from '../organizations/owner-bootstrap.js'
import { createPostgresControlPlaneDatabase } from '../persistence/postgres.js'

async function main(): Promise<void> {
  const database = createPostgresControlPlaneDatabase({ connectionString: required('KALA_INGRESS_DATABASE_URL'), applicationName: 'kala-owner-bootstrap', maxConnections: 1 })
  try {
    const service = new OwnerBootstrapService(database)
    const action = required('OWNER_BOOTSTRAP_ACTION')
    if (action === 'create') {
      const now = new Date()
      const endsAt = new Date(required('OWNER_BOOTSTRAP_ENDS_AT'))
      if (!Number.isFinite(endsAt.getTime()) || endsAt <= now) throw new Error('OWNER_BOOTSTRAP_ENDS_AT must be a future ISO date')
      const lifetimeMinutes = numberEnv('OWNER_BOOTSTRAP_TTL_MINUTES', 15)
      if (lifetimeMinutes > 30) throw new Error('OWNER_BOOTSTRAP_TTL_MINUTES must not exceed 30')
      const created = await service.create({
        expectedIssuer: required('OWNER_BOOTSTRAP_EXPECTED_ISSUER'),
        expectedEmail: required('OWNER_BOOTSTRAP_EXPECTED_EMAIL'),
        expiresAt: new Date(Date.now() + lifetimeMinutes * 60_000),
        contract: {
          operationId: required('OWNER_BOOTSTRAP_OPERATION_ID'), name: required('OWNER_BOOTSTRAP_ORGANIZATION_NAME'),
          contractReference: required('OWNER_BOOTSTRAP_CONTRACT_REFERENCE'), supportTier: 'standard', startsAt: now, endsAt,
          seatLimit: numberEnv('OWNER_BOOTSTRAP_SEAT_LIMIT', 10), concurrentSessionLimit: numberEnv('OWNER_BOOTSTRAP_CONCURRENT_SESSION_LIMIT', 5),
        },
      })
      const origin = httpsOrigin(required('OWNER_BOOTSTRAP_PUBLIC_ORIGIN'))
      process.stdout.write(`${JSON.stringify({ ok: true, authorizationId: created.id, expiresAt: created.expiresAt, url: `${origin}/auth/owner-bootstrap?token=${encodeURIComponent(created.token)}` })}\n`)
      return
    }
    const id = bootstrapId(required('OWNER_BOOTSTRAP_ID'))
    if (action === 'status') {
      process.stdout.write(`${JSON.stringify({ ok: true, authorization: await service.status(id) })}\n`)
      return
    }
    if (action === 'confirm') {
      const status = await service.status(id)
      if (status.state !== 'awaiting_confirmation' || !status.candidate) throw new Error('owner bootstrap has no live candidate to confirm')
      const result = await service.confirm(id, required('OWNER_BOOTSTRAP_CONFIRMATION_CODE'))
      process.stdout.write(`${JSON.stringify({ ok: true, authorizationId: id, candidate: status.candidate, ...result })}\n`)
      return
    }
    throw new Error('OWNER_BOOTSTRAP_ACTION must be create, status, or confirm')
  } finally { await database.close() }
}

function required(name: string): string { const value = process.env[name]; if (!value?.trim()) throw new Error(`${name} is required`); return value.trim() }
function numberEnv(name: string, fallback: number): number { const value = Number(process.env[name] ?? fallback); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value }
function bootstrapId(value: string): string { if (!/^ob_[A-Za-z0-9_-]{22}$/u.test(value)) throw new Error('OWNER_BOOTSTRAP_ID is invalid'); return value }
function httpsOrigin(value: string): string { try { return normalizeOwnerBootstrapOrigin(value) } catch { throw new Error('OWNER_BOOTSTRAP_PUBLIC_ORIGIN must be an HTTPS origin or the fixed local Kala origin') } }

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1) })

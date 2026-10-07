#!/usr/bin/env node
import process from 'node:process'
import { normalizeOwnerBootstrapIssuer } from '../organizations/owner-bootstrap.js'
import { OrganizationProvisioningService } from '../organizations/provisioning.js'
import { createPostgresControlPlaneDatabase } from '../persistence/postgres.js'

async function main(): Promise<void> {
  const connectionString = required('KALA_INGRESS_DATABASE_URL')
  const issuer = httpsIssuer(required('PROVISION_OWNER_ISSUER'))
  const subject = exactSubject(required('PROVISION_OWNER_SUBJECT'))
  const email = ownerEmail(required('PROVISION_OWNER_EMAIL'))
  const now = new Date()
  const endsAt = new Date(process.env.PROVISION_ENDS_AT ?? Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()))
  if (!Number.isFinite(endsAt.getTime()) || endsAt <= now) throw new Error('PROVISION_ENDS_AT must be a valid future ISO date')
  const database = createPostgresControlPlaneDatabase({ connectionString, applicationName: 'agent-runlab-organization-provisioner', maxConnections: 1 })
  try {
    const service = new OrganizationProvisioningService(database)
    const result = await service.provision({
      operationId: process.env.PROVISION_OPERATION_ID ?? `manual:${subject}`,
      name: process.env.PROVISION_ORGANIZATION_NAME ?? `${email}'s organization`,
      owner: { issuer, subject, email, displayName: process.env.PROVISION_OWNER_DISPLAY_NAME ?? email },
      contractReference: process.env.PROVISION_CONTRACT_REFERENCE ?? `acceptance-${subject}`,
      supportTier: 'standard', startsAt: now, endsAt,
      seatLimit: numberEnv('PROVISION_SEAT_LIMIT', 10), concurrentSessionLimit: numberEnv('PROVISION_CONCURRENT_SESSION_LIMIT', 5),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally { await database.close() }
}
function required(name: string): string { const value=process.env[name]; if (!value?.trim()) { const hint = name === 'PROVISION_OWNER_SUBJECT' ? '; obtain the exact sub claim from the external IdP, because email is not a safe substitute' : ''; throw new Error(`${name} is required${hint}`) } return value }
function numberEnv(name: string, fallback: number): number { const value=Number(process.env[name] ?? fallback); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value }
function httpsIssuer(value: string): string { try { return normalizeOwnerBootstrapIssuer(value) } catch { throw new Error('PROVISION_OWNER_ISSUER must be HTTPS or the fixed local identity issuer without credentials, query, or fragment') } }
function exactSubject(value: string): string { if (value !== value.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('PROVISION_OWNER_SUBJECT must be the exact IdP sub claim, at most 255 characters; do not infer it from email'); return value }
function ownerEmail(value: string): string { const email = value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('PROVISION_OWNER_EMAIL must be a valid email address and is not a substitute for PROVISION_OWNER_SUBJECT'); return email }
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

#!/usr/bin/env node
import process from 'node:process'
import { OrganizationProvisioningService } from '../organizations/provisioning.js'
import { createPostgresControlPlaneDatabase } from '../persistence/postgres.js'

async function main(): Promise<void> {
  const connectionString = required('RUNTIME_INGRESS_DATABASE_URL')
  const subject = required('PROVISION_OWNER_SUBJECT')
  const email = required('PROVISION_OWNER_EMAIL')
  const now = new Date()
  const endsAt = new Date(process.env.PROVISION_ENDS_AT ?? Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()))
  const database = createPostgresControlPlaneDatabase({ connectionString, applicationName: 'agent-runlab-organization-provisioner', maxConnections: 1 })
  try {
    const service = new OrganizationProvisioningService(database)
    const result = await service.provision({
      operationId: process.env.PROVISION_OPERATION_ID ?? `manual:${subject}`,
      name: process.env.PROVISION_ORGANIZATION_NAME ?? `${email}'s organization`,
      owner: { issuer: process.env.PROVISION_OWNER_ISSUER ?? 'http://localhost:13002', subject, email, displayName: process.env.PROVISION_OWNER_DISPLAY_NAME ?? email },
      contractReference: process.env.PROVISION_CONTRACT_REFERENCE ?? `acceptance-${subject}`,
      supportTier: 'standard', startsAt: now, endsAt,
      seatLimit: numberEnv('PROVISION_SEAT_LIMIT', 10), concurrentSessionLimit: numberEnv('PROVISION_CONCURRENT_SESSION_LIMIT', 5),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally { await database.close() }
}
function required(name: string): string { const value=process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value }
function numberEnv(name: string, fallback: number): number { const value=Number(process.env[name] ?? fallback); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value }
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

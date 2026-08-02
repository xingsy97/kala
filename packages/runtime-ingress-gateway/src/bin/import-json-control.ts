#!/usr/bin/env node
import process from 'node:process'
import { resolve } from 'node:path'

import { backupJsonControlFiles, importJsonControlPlan, planJsonControlImport } from '../persistence/json-control-import.js'
import { createPostgresControlPlaneDatabase } from '../persistence/postgres.js'

async function main(): Promise<void> {
  const connectionString = process.env.RUNTIME_INGRESS_DATABASE_URL
  const directoryPath = process.env.RUNTIME_INGRESS_JSON_DIRECTORY
  if (!connectionString || !directoryPath) throw new Error('RUNTIME_INGRESS_DATABASE_URL and RUNTIME_INGRESS_JSON_DIRECTORY are required')
  const sessionsPath = process.env.RUNTIME_INGRESS_JSON_SESSIONS
  const plan = await planJsonControlImport(resolve(directoryPath), sessionsPath ? resolve(sessionsPath) : undefined)
  if (plan.skippedExecutorInvites > 0) throw new Error('legacy Executor invites cannot be migrated safely; revoke them and issue new enrollment tokens')
  if (process.argv.includes('--dry-run')) {
    process.stdout.write(`${JSON.stringify({ event: 'json_control_import_plan', ...counts(plan), checksum: plan.checksum })}\n`)
    return
  }
  const backupPrefix = resolve(process.env.RUNTIME_INGRESS_JSON_BACKUP_PREFIX ?? `${directoryPath}.pre-postgres-${Date.now()}`)
  const backupPath = await backupJsonControlFiles(resolve(directoryPath), backupPrefix, sessionsPath ? resolve(sessionsPath) : undefined)
  const database = createPostgresControlPlaneDatabase({ connectionString, applicationName: 'agent-runlab-json-control-import', maxConnections: 1 })
  try {
    const result = await database.transaction((transaction) => importJsonControlPlan(transaction, plan, backupPath))
    process.stdout.write(`${JSON.stringify({ event: 'json_control_imported', checksum: plan.checksum, backupPath, ...result })}\n`)
  } finally { await database.close() }
}
function counts(plan: Awaited<ReturnType<typeof planJsonControlImport>>) { return { organizations: plan.organizations.length, memberships: plan.memberships.length, sessions: plan.sessions.length, skippedExecutorInvites: plan.skippedExecutorInvites } }
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1 })

#!/usr/bin/env node
import process from 'node:process'
import { resolve } from 'node:path'

import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } from '../persistence/postgres.js'

async function main(): Promise<void> {
  const connectionString = process.env.RUNTIME_INGRESS_DATABASE_URL
  if (!connectionString) throw new Error('RUNTIME_INGRESS_DATABASE_URL is required')
  const directory = resolve(process.env.RUNTIME_INGRESS_MIGRATIONS_DIR ?? 'migrations')
  const database = createPostgresControlPlaneDatabase({ connectionString, applicationName: 'agent-runlab-control-plane-migrator', maxConnections: 1 })
  try {
    const migrations = await readControlPlaneMigrations(directory)
    const version = await migrateControlPlane(database, migrations)
    process.stdout.write(`${JSON.stringify({ event: 'control_plane_migrated', version, migrations: migrations.length })}\n`)
  } finally {
    await database.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

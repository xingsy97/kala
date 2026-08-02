#!/usr/bin/env node
import process from 'node:process'
import pg from 'pg'
import { resolve } from 'node:path'
import { createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations } from '../persistence/postgres.js'

const { Client } = pg
async function main(): Promise<void> {
  const adminUrl = process.env.RUNTIME_INGRESS_ADMIN_DATABASE_URL
  const databaseUrl = process.env.RUNTIME_INGRESS_DATABASE_URL
  if (!adminUrl || !databaseUrl) throw new Error('RUNTIME_INGRESS_ADMIN_DATABASE_URL and RUNTIME_INGRESS_DATABASE_URL are required')
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname='runlab_control'")
    if (exists.rowCount === 0) await admin.query('CREATE DATABASE runlab_control')
  } finally { await admin.end() }
  const database = createPostgresControlPlaneDatabase({ connectionString: databaseUrl, applicationName: 'agent-runlab-control-plane-init', maxConnections: 1 })
  try {
    const migrations = await readControlPlaneMigrations(resolve(process.env.RUNTIME_INGRESS_MIGRATIONS_DIR ?? 'migrations'))
    const version = await migrateControlPlane(database, migrations)
    process.stdout.write(`${JSON.stringify({ event: 'control_plane_initialized', version })}\n`)
  } finally { await database.close() }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exit(1) })

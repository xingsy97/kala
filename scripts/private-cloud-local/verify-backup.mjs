#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const dir = resolve(process.argv[2] ?? '')
if (!process.argv[2] || dir.startsWith('/tmp/')) throw new Error('usage: verify-backup.mjs PERSISTENT_BACKUP_DIR')
const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'))
for (const [name, expected] of Object.entries(manifest.files)) {
  const path = resolve(dir, name)
  if ((await stat(path)).size !== expected.bytes || await hash(path) !== expected.sha256) throw new Error(`${name} failed integrity check`)
}

const identity = randomBytes(10).toString('hex')
const tenantVolume = `agent-runlab-backup-verify-tenant-${identity}`
const controlVolume = `agent-runlab-backup-verify-control-${identity}`
const postgresVolume = `agent-runlab-backup-verify-postgres-${identity}`
const postgresContainer = `agent-runlab-backup-verify-postgres-${identity}`
const restored = {}

try {
  restored.tenant = await restoreArchive('tenant-data.tar', tenantVolume)
  restored.control = await restoreArchive('control-data.tar', controlVolume)
  restored.postgres = await restorePostgres(postgresContainer, postgresVolume)
  process.stdout.write(`${JSON.stringify({ event: 'backup_restore_verified', profile: manifest.profile, files: Object.keys(manifest.files), restored })}\n`)
} finally {
  await run('docker', ['rm', '--force', postgresContainer], { allowFailure: true })
  for (const volume of [tenantVolume, controlVolume, postgresVolume]) await run('docker', ['volume', 'rm', '--force', volume], { allowFailure: true })
}

async function restoreArchive(name, volume) {
  await run('docker', ['volume', 'create', volume])
  const archive = resolve(dir, name)
  const script = ['set -eu', 'mkdir -p /expected', 'tar -xf /backup.tar -C /expected', 'tar -xf /backup.tar -C /restore', 'diff -qr /expected /restore', 'find /restore -type f | wc -l'].join('; ')
  const output = await run('docker', ['run', '--rm', '--network', 'none', '-v', `${archive}:/backup.tar:ro`, '-v', `${volume}:/restore`, 'alpine:3.22.2', 'sh', '-ceu', script], { capture: true })
  return { volume, regularFiles: Number(output.trim()) }
}

async function restorePostgres(container, volume) {
  const password = randomBytes(24).toString('base64url')
  await run('docker', ['volume', 'create', volume])
  await run('docker', ['run', '--detach', '--name', container, '--network', 'none', '-e', `POSTGRES_PASSWORD=${password}`, '-v', `${volume}:/var/lib/postgresql/data`, '-v', `${resolve(dir, 'control-plane.pgdump')}:/backup/control-plane.pgdump:ro`, 'postgres:17.10-alpine'])
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if ((await run('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { allowFailure: true })).ok) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  if (!(await run('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { allowFailure: true })).ok) throw new Error('disposable PostgreSQL did not become ready')
  await run('docker', ['exec', container, 'createdb', '-U', 'postgres', 'restore_verify'])
  await run('docker', ['exec', container, 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '-U', 'postgres', '-d', 'restore_verify', '/backup/control-plane.pgdump'])
  const output = await run('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'restore_verify', '--tuples-only', '--no-align', '--command', 'SELECT COALESCE(max(version), 0) FROM control_plane_schema_migrations;'], { capture: true })
  const schemaVersion = Number(output.trim())
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error('restored PostgreSQL has no schema version')
  return { volume, schemaVersion }
}

async function run(command, args, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' })
    let stdout = ''; let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveRun(options.capture ? stdout : { ok: true })
      else if (options.allowFailure) resolveRun({ ok: false, code, stderr })
      else reject(new Error(`${command} exited ${String(code)}: ${stderr}`))
    })
  })
}

async function hash(path) {
  const digest = createHash('sha256')
  await new Promise((resolveHash, reject) => createReadStream(path).on('data', (chunk) => digest.update(chunk)).on('end', resolveHash).on('error', reject))
  return digest.digest('hex')
}

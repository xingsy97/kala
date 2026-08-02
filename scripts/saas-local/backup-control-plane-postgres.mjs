#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const databaseUrl = process.env.RUNTIME_INGRESS_DATABASE_URL
if (!databaseUrl) throw new Error('RUNTIME_INGRESS_DATABASE_URL is required')
const outputDir = resolve(process.env.RUNLAB_BACKUP_DIR ?? 'backups/control-plane')
await mkdir(outputDir, { recursive: true, mode: 0o700 })
const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
const dumpPath = resolve(outputDir, `control-plane-${stamp}.dump`)
await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dumpPath, databaseUrl])
const bytes = (await stat(dumpPath)).size
const checksum = await hashFile(dumpPath)
const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), file: basename(dumpPath), bytes, sha256: checksum, format: 'postgres-custom' }
await writeFile(`${dumpPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify({ event: 'control_plane_backup_created', path: dumpPath, bytes, sha256: checksum })}\n`)

async function hashFile(path) {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', resolvePromise).on('error', reject))
  return hash.digest('hex')
}
function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
  })
}

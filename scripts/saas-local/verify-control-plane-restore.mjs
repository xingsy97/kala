#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const databaseUrl = process.env.RUNTIME_INGRESS_DATABASE_URL
const dumpPath = process.argv[2] ? resolve(process.argv[2]) : undefined
if (!databaseUrl || !dumpPath) throw new Error('usage: RUNTIME_INGRESS_DATABASE_URL=... verify-control-plane-restore.mjs BACKUP.dump')
const manifest = JSON.parse(await readFile(`${dumpPath}.json`, 'utf8'))
if ((await stat(dumpPath)).size !== manifest.bytes || await hashFile(dumpPath) !== manifest.sha256) throw new Error('backup manifest verification failed')
await run('pg_restore', ['--exit-on-error', '--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', databaseUrl, dumpPath])
const output = await capture('psql', ['--tuples-only', '--no-align', '--dbname', databaseUrl, '--command', `SELECT json_build_object(
  'schemaVersion',(SELECT max(version) FROM control_plane_schema_migrations),
  'organizations',(SELECT count(*) FROM organizations),
  'memberships',(SELECT count(*) FROM organization_memberships),
  'sessions',(SELECT count(*) FROM browser_sessions),
  'auditEvents',(SELECT count(*) FROM audit_events),
  'usageEvents',(SELECT count(*) FROM usage_ledger));`])
const summary = JSON.parse(output.trim())
if (!summary.schemaVersion) throw new Error('restored database has no schema version')
process.stdout.write(`${JSON.stringify({ event: 'control_plane_restore_verified', ...summary })}\n`)

async function hashFile(path) { const hash=createHash('sha256'); await new Promise((ok,fail)=>createReadStream(path).on('data',(chunk)=>hash.update(chunk)).on('end',ok).on('error',fail)); return hash.digest('hex') }
function run(command,args){return new Promise((ok,fail)=>{const child=spawn(command,args,{stdio:'inherit'});child.on('error',fail);child.on('exit',(code)=>code===0?ok():fail(new Error(`${command} exited ${code}`)))})}
function capture(command,args){return new Promise((ok,fail)=>{let stdout='',stderr='';const child=spawn(command,args);child.stdout.on('data',(chunk)=>stdout+=chunk);child.stderr.on('data',(chunk)=>stderr+=chunk);child.on('error',fail);child.on('exit',(code)=>code===0?ok(stdout):fail(new Error(`${command} exited ${code}: ${stderr}`)))})}

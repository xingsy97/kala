#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const dir=resolve(process.argv[2]??'');if(!process.argv[2]||dir.startsWith('/tmp/'))throw new Error('usage: verify-backup.mjs PERSISTENT_BACKUP_DIR')
const manifest=JSON.parse(await readFile(resolve(dir,'manifest.json'),'utf8'))
for(const [name,expected] of Object.entries(manifest.files)){const path=resolve(dir,name);if((await stat(path)).size!==expected.bytes||await hash(path)!==expected.sha256)throw new Error(`${name} failed integrity check`)}
const list=spawnSync('docker',['run','--rm','--network','none','-v',`${resolve(dir,'tenant-data.tar')}:/backup.tar:ro`,'alpine:3.22.2','tar','-tf','/backup.tar'],{encoding:'utf8'})
if(list.status!==0)throw new Error(`session archive unreadable: ${list.stderr}`)
const pg=spawnSync('docker',['run','--rm','--network','none','-v',`${resolve(dir,'control-plane.pgdump')}:/backup:ro`,'postgres:17.10-alpine','pg_restore','--list','/backup'],{encoding:'utf8'})
if(pg.status!==0)throw new Error(`PostgreSQL dump unreadable: ${pg.stderr}`)
console.log(JSON.stringify({event:'backup_verified',profile:manifest.profile,files:Object.keys(manifest.files),sessionEntries:list.stdout.trim().split('\n').length}))
async function hash(path){const h=createHash('sha256');await new Promise((ok,fail)=>createReadStream(path).on('data',(c)=>h.update(c)).on('end',ok).on('error',fail));return h.digest('hex')}

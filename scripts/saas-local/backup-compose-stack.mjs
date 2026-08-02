#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { composeFiles, selectedProfile } from './profile.mjs'

const root = resolve(import.meta.dirname, '../..')
const backupRoot = resolve(process.env.RUNLAB_BACKUP_DIR ?? resolve(root, 'deploy/saas/backups'))
if (backupRoot.startsWith('/tmp/')) throw new Error('RUNLAB_BACKUP_DIR must be persistent; /tmp is forbidden')
const out = resolve(process.argv[2] ?? `${backupRoot}/${new Date().toISOString().replace(/[:.]/gu, '-')}`)
await mkdir(out, { recursive: true, mode: 0o700 })
async function run(command, args, file) {
  const handle = file ? await open(resolve(out, file), 'w', 0o600) : undefined
  try { await new Promise((ok, fail) => { const child=spawn(command,args,{stdio:['ignore',handle?.fd??'inherit','inherit']});child.on('error',fail);child.on('exit',(code)=>code===0?ok():fail(new Error(`${command} exited ${code}`))) }) }
  finally { await handle?.close() }
}
await run('docker', ['exec', 'agent-runlab-saas-control-postgres-1', 'pg_dump', '-U', 'runlab', '-d', 'runlab_control', '--format=custom', '--no-owner', '--no-acl'], 'control-plane.pgdump')
for (const [volume, file] of [['agent-runlab-saas_tenant-data', 'tenant-data.tar'], ['agent-runlab-saas_control-data', 'control-data.tar']]) await run('docker', ['run','--rm','--network','none','-v',`${volume}:/source:ro`,'alpine:3.22.2','tar','-C','/source','-cf','-','.'], file)
const profile = selectedProfile()
const manifest = { createdAt:new Date().toISOString(), profile, gitSha:capture('git',['rev-parse','HEAD']).trim(), files:{}, composeFiles:composeFiles(profile).map((p)=>p.slice(root.length+1)), encryption:{ requiredForOffHost:true, applied:false } }
for (const name of ['control-plane.pgdump','tenant-data.tar','control-data.tar']) { const path=resolve(out,name); manifest.files[name]={ bytes:(await stat(path)).size, sha256:await hash(path) } }
await writeFile(resolve(out,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600})
console.log(`Backup written to ${out}`)
async function hash(path){const h=createHash('sha256');await new Promise((ok,fail)=>createReadStream(path).on('data',(c)=>h.update(c)).on('end',ok).on('error',fail));return h.digest('hex')}
function capture(command,args){const x=spawnSync(command,args,{cwd:root,encoding:'utf8'});if(x.status!==0)throw new Error(x.stderr);return x.stdout}

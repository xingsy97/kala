#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { composeArgs, selectedProfile } from './profile.mjs'

const root=resolve(import.meta.dirname,'../..'); const profile=selectedProfile()
const compose=run('docker',['compose',...composeArgs(profile),'config','--images']).trim().split('\n').filter(Boolean)
const manifest={createdAt:new Date().toISOString(),profile,gitSha:run('git',['rev-parse','HEAD']).trim(),dirty:run('git',['status','--porcelain']).trim().length>0,images:{}}
for(const image of compose){const inspect=spawnSync('docker',['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8'});manifest.images[image]=inspect.status===0?inspect.stdout.trim():'not-built'}
const body=`${JSON.stringify(manifest,null,2)}\n`;manifest.sha256=createHash('sha256').update(body).digest('hex')
const output=resolve(process.argv[2]??'deploy/private-cloud/release-manifest.local.json');await writeFile(output,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});console.log(output)
function run(command,args){const x=spawnSync(command,args,{cwd:root,encoding:'utf8',env:process.env});if(x.status!==0)throw new Error(`${command}: ${x.stderr}`);return x.stdout}

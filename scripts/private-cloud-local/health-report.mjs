#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { composeArgs, root, selectedProfile } from './profile.mjs'
const profile=selectedProfile();const ps=spawnSync('docker',['compose',...composeArgs(profile),'ps','--format','json'],{cwd:root,encoding:'utf8',env:process.env});if(ps.status!==0)throw new Error(ps.stderr)
const rows=ps.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);const bad=rows.filter((x)=>x.State!=='running'||(x.Health&&x.Health!=='healthy'));const fs=await statfs(root);const free=fs.bavail*fs.bsize
console.log(JSON.stringify({event:'deployment_health',profile,services:rows.map((x)=>({service:x.Service,state:x.State,health:x.Health||null})),diskFreeBytes:free,ok:bad.length===0&&free>=5*1024**3}))
if(bad.length||free<5*1024**3)process.exit(1)

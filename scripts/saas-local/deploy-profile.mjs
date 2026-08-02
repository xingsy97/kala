#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { composeArgs, root, selectedProfile } from './profile.mjs'

const profile=selectedProfile(); const action=process.argv[2]??'apply'
run('node',['scripts/saas-local/preflight.mjs'])
if(action==='apply'){
  run('node',['scripts/saas-local/backup-compose-stack.mjs'])
  run('node',['scripts/saas-local/release-manifest.mjs'])
  run('docker',['compose',...composeArgs(profile),'up','-d','--build','--wait'])
}else if(action==='rollback'){
  const manifest=process.argv[3]
  if(!manifest)throw new Error('usage: deploy-profile.mjs rollback MANIFEST.json')
  console.error('Rollback requires the image IDs in the supplied manifest to remain present; database rollback is intentionally separate.')
  run('docker',['compose',...composeArgs(profile),'up','-d','--wait','--no-build'])
}else throw new Error(`unknown action ${action}`)
function run(command,args){const x=spawnSync(command,args,{cwd:root,stdio:'inherit',env:{...process.env,RUNLAB_PROFILE:profile}});if(x.status!==0)process.exit(x.status??1)}

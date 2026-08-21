#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { composeArgs, root, selectedProfile } from './profile.mjs'

const profile=selectedProfile();const failures=[]
const validationEnv={
 ...process.env,
 OIDC_ISSUER: process.env.OIDC_ISSUER ?? 'https://identity.invalid',
 OIDC_DISCOVERY_ORIGIN: process.env.OIDC_DISCOVERY_ORIGIN ?? 'https://identity.invalid',
 RUNLAB_PUBLIC_ORIGIN: process.env.RUNLAB_PUBLIC_ORIGIN ?? 'http://localhost:13001',
}
const rendered=spawnSync('docker',['compose',...composeArgs(profile),'config'],{cwd:root,encoding:'utf8',env:validationEnv})
if(rendered.status!==0)failures.push(`compose config failed: ${rendered.stderr.trim()}`)
const text=rendered.stdout
for(const forbidden of ['privileged: true','network_mode: host','/var/run/docker.sock','0.0.0.0:13001'])if(text.includes(forbidden))failures.push(`forbidden compose setting: ${forbidden}`)
if(!/host_ip: 127\.0\.0\.1[\s\S]*?target: 13001[\s\S]*?published: "13001"/u.test(text))failures.push('Gateway must bind only to loopback port 13001')
for(const service of ['init-volumes','init-app-secrets','control-postgres','control-plane-init','runtime-host','dashboard','runtime-ingress']){
 const match=text.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^networks:|^volumes:)`,'mu'));const block=match?.[1]??''
 if(!block.includes('no-new-privileges:true'))failures.push(`${service} lacks no-new-privileges`)
 if(!block.includes('cap_drop:\n      - ALL'))failures.push(`${service} does not drop capabilities`)
}
if(!/networks:\n  control:[\s\S]*?internal: true/u.test(text)||!/networks:[\s\S]*?\n  runtime:[\s\S]*?internal: true/u.test(text))failures.push('control/runtime networks must be internal')
const runtimeHost=text.match(/^  runtime-host:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:|^networks:|^volumes:)/mu)?.[1]??''
if(!runtimeHost.includes('AGENT_RUNLAB_DEPLOYMENT_CONFIG: /etc/agent-runlab/deployment.json'))failures.push('Runtime Host must declare the authoritative deployment config')
if(runtimeHost.includes('RUNTIME_HOST_DASHBOARD_DIR'))failures.push('Private Cloud Runtime Host must not serve Dashboard assets')
if(!runtimeHost.includes('target: /etc/agent-runlab/deployment.json')||!runtimeHost.includes('source: ')||!runtimeHost.includes('read_only: true'))failures.push('Runtime Host must mount deployment.json read-only')
const ingress=text.match(/^  runtime-ingress:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:|^networks:|^volumes:)/mu)?.[1]??''
if(!ingress.includes('RUNTIME_DASHBOARD_ORIGIN: http://dashboard:8080'))failures.push('Private Cloud Ingress must route to the independent Dashboard service')
if(profile==='cloudflare'&&!/^\s+INGRESS_PUBLIC_ORIGIN: https:\/\//mu.test(text))failures.push('Cloudflare profile requires an HTTPS public origin')
if(profile==='cloudflare'&&!/^\s+OIDC_ISSUER: https:\/\//mu.test(text))failures.push('Cloudflare profile requires an HTTPS issuer')
if(profile!=='local-volume'){
 const storage=await readFile('deploy/private-cloud/compose.storage-nfs.yaml','utf8')
 if(profile!=='external-nfs'&&(!storage.includes('nfs-server:')||!storage.includes('hectorm/nfs-ganesha@sha256:')))failures.push('Docker NFS profile missing pinned server')
}
for(const failure of failures)console.error(`FAIL ${failure}`)
if(failures.length)process.exit(1)
console.log(`PASS Compose security policy profile=${profile}`)

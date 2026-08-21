#!/usr/bin/env node
import { access, readFile, stat, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { composeArgs, identityDeploymentEnv, root, selectedProfile } from './profile.mjs'

const profile = selectedProfile()
const failures = []
const warnings = []
const secretDir = resolve(root, process.env.RUNLAB_SECRETS_DIR ?? 'deploy/private-cloud/.secrets')
const requiredSecrets = ['control_postgres_password', 'session_secret', 'ingress_secret', 'oidc_client_id', 'oidc_client_secret', 'llm_api_key']
for (const name of requiredSecrets) {
  const path = resolve(secretDir, name)
  try {
    await access(path, constants.R_OK)
    const info = await stat(path)
    if ((info.mode & 0o077) !== 0) failures.push(`${path} permissions must deny group/other access`)
    const value = (await readFile(path, 'utf8')).trim()
    if (!value || value.startsWith('REPLACE_')) failures.push(`${path} is empty or placeholder`)
  } catch { failures.push(`missing secret file ${path}`) }
}
const compose = spawnSync('docker', ['compose', ...composeArgs(profile), 'config'], { cwd: root, encoding: 'utf8', env: process.env })
if (compose.status !== 0) failures.push(`compose config failed: ${compose.stderr.trim()}`)
else {
  if (/0\.0\.0\.0:13001/u.test(compose.stdout)) failures.push('runtime ingress must bind to loopback')
  if (compose.stdout.includes('/var/run/docker.sock')) failures.push('Docker socket mount is forbidden')
}
const isPublicProfile = profile === 'cloudflare' || profile === 'external-nfs'
const publicOrigin = process.env.RUNLAB_PUBLIC_ORIGIN ?? (isPublicProfile ? '' : 'http://localhost:13001')
const issuer = process.env.OIDC_ISSUER ?? ''
try {
  await access(identityDeploymentEnv, constants.R_OK)
  const identityEnv = await readFile(identityDeploymentEnv, 'utf8')
  if (!/^IDENTITY_DOMAIN=\S+/mu.test(identityEnv)) failures.push(`${identityDeploymentEnv} must define IDENTITY_DOMAIN`)
} catch { failures.push(`Shared Identity deployment environment is missing: ${identityDeploymentEnv}`) }
const identity = spawnSync('docker', ['compose', '--env-file', identityDeploymentEnv, '-f', 'deploy/identity/compose.yaml', 'ps', '--status', 'running', '--services'], { cwd: root, encoding: 'utf8', env: process.env })
const identityServices = new Set(identity.stdout.trim().split('\n').filter(Boolean))
if (identity.status !== 0 || !identityServices.has('zitadel') || !identityServices.has('zitadel-login') || !identityServices.has('caddy')) failures.push('Shared Identity Compose project must be running before Private Cloud deployment')
if (isPublicProfile && !publicOrigin) failures.push('RUNLAB_PUBLIC_ORIGIN is required for public profiles')
if (!issuer) failures.push('OIDC_ISSUER is required')
if (isPublicProfile && !publicOrigin.startsWith('https://')) failures.push('public profile requires HTTPS RUNLAB_PUBLIC_ORIGIN')
try {
  const response = await fetch(`${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) failures.push(`OIDC discovery returned ${response.status}`)
  else if ((await response.json()).issuer !== issuer.replace(/\/$/u, '')) failures.push('OIDC discovery issuer mismatch')
} catch (error) { failures.push(`OIDC discovery failed: ${error.message}`) }
const providerPath = resolve(root, process.env.RUNLAB_PROVIDER_CATALOG_FILE ?? 'deploy/private-cloud/local/runtime-provider-catalog.json')
try { JSON.parse(await readFile(providerPath, 'utf8')) } catch (error) { failures.push(`provider catalog invalid: ${error.message}`) }
const disk = await statfs(root)
const free = disk.bavail * disk.bsize
if (free < 5 * 1024 ** 3) warnings.push(`less than 5 GiB free at ${root}`)
if (profile.includes('nfs') && !process.env.RUNLAB_EXTERNAL_NFS_ADDRESS && profile === 'external-nfs') failures.push('RUNLAB_EXTERNAL_NFS_ADDRESS is required')
for (const warning of warnings) console.warn(`WARN ${warning}`)
for (const failure of failures) console.error(`FAIL ${failure}`)
if (failures.length) process.exit(1)
console.log(`PASS preflight profile=${profile} publicOrigin=${publicOrigin} callback=${publicOrigin}/auth/callback`)

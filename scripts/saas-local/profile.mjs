import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '../..')
const deploymentEnv = resolve(root, 'deploy/saas/.secrets/deployment.env')
if (existsSync(deploymentEnv)) {
  for (const line of readFileSync(deploymentEnv, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
  }
}
const profiles = {
  local: ['deploy/saas/compose.yaml', 'deploy/saas/compose.storage-nfs.yaml', 'deploy/saas/compose.local.yaml'],
  cloudflare: ['deploy/saas/compose.yaml', 'deploy/saas/compose.storage-nfs.yaml', 'deploy/saas/compose.cloudflare.yaml'],
  acceptance: ['deploy/saas/compose.yaml', 'deploy/saas/compose.storage-nfs.yaml', 'deploy/saas/compose.local.yaml', 'deploy/saas/local/compose.acceptance.yaml'],
  'local-volume': ['deploy/saas/compose.yaml', 'deploy/saas/compose.storage-local.yaml', 'deploy/saas/compose.local.yaml'],
  'external-nfs': ['deploy/saas/compose.yaml', 'deploy/saas/compose.storage-external-nfs.yaml', 'deploy/saas/compose.cloudflare.yaml'],
}

export function selectedProfile() { return process.env.RUNLAB_PROFILE ?? 'local' }
export function composeFiles(profile = selectedProfile()) {
  const files = profiles[profile]
  if (!files) throw new Error(`unknown RUNLAB_PROFILE ${profile}; expected ${Object.keys(profiles).join(', ')}`)
  return files.map((file) => resolve(root, file))
}
export function composeArgs(profile = selectedProfile()) {
  return [...(existsSync(deploymentEnv) ? ['--env-file', deploymentEnv] : []), ...composeFiles(profile).flatMap((file) => ['-f', file]), ...(profile === 'acceptance' ? ['--profile', 'acceptance'] : [])]
}
export { root }

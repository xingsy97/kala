import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '../..')
const deploymentEnv = resolve(process.env.RUNLAB_DEPLOYMENT_ENV ?? resolve(root, 'deploy/private-cloud/.secrets/deployment.env'))
const identityDeploymentEnv = resolve(process.env.RUNLAB_IDENTITY_ENV ?? resolve(root, 'deploy/identity/.secrets/deployment.env'))
if (existsSync(deploymentEnv)) {
  for (const line of readFileSync(deploymentEnv, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
  }
}
const profiles = {
  local: ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-nfs.yaml', 'deploy/private-cloud/compose.local.yaml'],
  cloudflare: ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-nfs.yaml', 'deploy/private-cloud/compose.cloudflare.yaml'],
  acceptance: ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-nfs.yaml', 'deploy/private-cloud/compose.local.yaml', 'deploy/private-cloud/local/compose.acceptance.yaml'],
  'local-volume': ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-local.yaml', 'deploy/private-cloud/compose.local.yaml'],
  'external-nfs': ['deploy/private-cloud/compose.yaml', 'deploy/private-cloud/compose.dev.yaml', 'deploy/private-cloud/compose.storage-external-nfs.yaml', 'deploy/private-cloud/compose.cloudflare.yaml'],
}
process.env.RUNLAB_RUNTIME_IMAGE ??= 'agent-runlab-private-cloud-runtime:dev'
process.env.RUNLAB_INGRESS_IMAGE ??= 'agent-runlab-private-cloud-ingress:dev'
process.env.RUNLAB_DASHBOARD_IMAGE ??= 'agent-runlab-private-cloud-dashboard:dev'

export function selectedProfile() { return process.env.RUNLAB_PROFILE ?? 'local' }
export function composeFiles(profile = selectedProfile()) {
  const files = profiles[profile]
  if (!files) throw new Error(`unknown RUNLAB_PROFILE ${profile}; expected ${Object.keys(profiles).join(', ')}`)
  return files.map((file) => resolve(root, file))
}
export function composeArgs(profile = selectedProfile()) {
  return [...(existsSync(deploymentEnv) ? ['--env-file', deploymentEnv] : []), ...composeFiles(profile).flatMap((file) => ['-f', file]), ...(profile === 'acceptance' ? ['--profile', 'acceptance'] : [])]
}
export { root, deploymentEnv, identityDeploymentEnv }

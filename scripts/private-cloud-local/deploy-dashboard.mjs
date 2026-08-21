#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { composeArgs, root, selectedProfile } from './profile.mjs'

const profile = selectedProfile()
run('node', ['scripts/private-cloud-local/preflight.mjs'])
run('node', ['scripts/private-cloud-local/backup-compose-stack.mjs'])
const before = inspect()
run('docker', ['compose', ...composeArgs(profile), 'build', 'dashboard'])
run('docker', ['compose', ...composeArgs(profile), 'up', '-d', '--no-deps', '--wait', 'dashboard'])
const after = inspect()
if (!after.containerId || !after.imageId || after.containerId === before.containerId) throw new Error('Dashboard container was not independently replaced')
process.stdout.write(`${JSON.stringify({ ok: true, profile, dashboard: after, runtimeUnchanged: before.runtimeContainerId === after.runtimeContainerId, ingressUnchanged: before.ingressContainerId === after.ingressContainerId }, null, 2)}\n`)
if (before.runtimeContainerId !== after.runtimeContainerId || before.ingressContainerId !== after.ingressContainerId) throw new Error('Dashboard-only deployment changed Runtime or Ingress container identity')

function inspect() {
  const services = ['dashboard', 'runtime-host', 'runtime-ingress']
  const ids = Object.fromEntries(services.map((service) => [service, output('docker', ['compose', ...composeArgs(profile), 'ps', '-q', service]).trim()]))
  const dashboardId = ids.dashboard
  return { containerId: dashboardId, imageId: dashboardId ? output('docker', ['inspect', '--format', '{{.Image}}', dashboardId]).trim() : '', runtimeContainerId: ids['runtime-host'], ingressContainerId: ids['runtime-ingress'] }
}
function output(command, args) { const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env, RUNLAB_PROFILE: profile } }); if (result.status !== 0) throw new Error(result.stderr || `${command} failed`); return result.stdout }
function run(command, args) { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, RUNLAB_PROFILE: profile } }); if (result.status !== 0) process.exit(result.status ?? 1) }

import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const digest = (character) => `sha256:${character.repeat(64)}`
const image = (name, character) => `ghcr.io/example/${name}@${digest(character)}`

test('builds an exact digest-pinned source-free Private Cloud bundle', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-bundle-'))
  const bundle = join(scratch, 'bundle')
  build(bundle, { runtime: image('runtime', 'a'), ingress: image('ingress', 'b'), dashboard: image('dashboard', 'c') })
  const verified = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', bundle])
  assert.equal(JSON.parse(verified.stdout).ok, true)
  const compose = readFileSync(join(bundle, 'compose.yaml'), 'utf8')
  assert.doesNotMatch(compose, /^\s+build:/mu)
  assert.equal(readFileSync(join(bundle, 'image-lock.json'), 'utf8').includes(image('dashboard', 'c')), true)
  assert.equal(run(process.execPath, [join(bundle, 'kala-private-cloud.mjs'), '--help']).stdout.includes('upgrade-dashboard'), true)

  writeFileSync(join(bundle, 'compose.yaml'), `${compose}\n# tampered\n`)
  const rejected = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', bundle], { allowFailure: true })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /integrity failed/u)
})

test('installs, upgrades Dashboard independently, and rolls back from persisted predecessor', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-operator-'))
  const first = join(scratch, 'first'); const second = join(scratch, 'second')
  const shared = { runtime: image('runtime', 'a'), ingress: image('ingress', 'b') }
  build(first, { ...shared, dashboard: image('dashboard', 'c') }, '1'.repeat(40))
  build(second, { ...shared, dashboard: image('dashboard', 'd') }, '2'.repeat(40))
  const config = join(scratch, 'config'); mkdirSync(join(config, 'secrets'), { recursive: true })
  copyFileSync(join(root, 'deploy/private-cloud/local/runtime-provider-catalog.json'), join(config, 'runtime-provider-catalog.json'))
  writeFileSync(join(config, 'deployment.env'), 'RUNLAB_PROFILE=local\nRUNLAB_STORAGE=local-volume\nCOMPOSE_PROJECT_NAME=runlab-test\n')
  const bin = join(scratch, 'bin'); mkdirSync(bin); const docker = join(bin, 'docker')
  writeFileSync(docker, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.includes('ps')&&args.includes('--format')){
 const suffix=(process.env.RUNLAB_DASHBOARD_IMAGE||'').slice(-8);
 for(const row of [
  {Service:'runtime-host',ID:'runtime-fixed',Image:process.env.RUNLAB_RUNTIME_IMAGE,State:'running',Health:'healthy'},
  {Service:'runtime-ingress',ID:'ingress-fixed',Image:process.env.RUNLAB_INGRESS_IMAGE,State:'running',Health:'healthy'},
  {Service:'dashboard',ID:'dashboard-'+suffix,Image:process.env.RUNLAB_DASHBOARD_IMAGE,State:'running',Health:'healthy'}
 ]) console.log(JSON.stringify(row));
}
`)
  chmodSync(docker, 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNLAB_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator') }
  const cli = join(first, 'kala-private-cloud.mjs')
  const installed = JSON.parse(run(process.execPath, [cli, 'install', '--bundle', first, '--config-dir', config], { env }).stdout)
  assert.equal(installed.receipt.phase, 'completed')
  const upgraded = JSON.parse(run(process.execPath, [cli, 'upgrade-dashboard', '--bundle', second], { env }).stdout)
  assert.equal(upgraded.receipt.phase, 'completed')
  assert.equal(upgraded.services['runtime-host'].containerId, 'runtime-fixed')
  assert.equal(upgraded.services['runtime-ingress'].containerId, 'ingress-fixed')
  assert.notEqual(installed.services.dashboard.containerId, upgraded.services.dashboard.containerId)
  const status = JSON.parse(run(process.execPath, [cli, 'status'], { env }).stdout)
  assert.equal(status.active.images.dashboard, image('dashboard', 'd'))
  assert.equal(status.predecessor.images.dashboard, image('dashboard', 'c'))
  assert.deepEqual(status.recentOperations.map((entry) => entry.phase), ['completed', 'completed'])
  const rolledBack = JSON.parse(run(process.execPath, [cli, 'rollback'], { env }).stdout)
  assert.equal(rolledBack.receipt.phase, 'completed')
  assert.equal(rolledBack.active.images.dashboard, image('dashboard', 'c'))
  assert.equal(rolledBack.predecessor.images.dashboard, image('dashboard', 'd'))
})

function build(output, images, revision = '1'.repeat(40)) {
  run(process.execPath, ['scripts/release/build-private-cloud-bundle.mjs', '--output', output, '--runtime-image', images.runtime, '--ingress-image', images.ingress, '--dashboard-image', images.dashboard, '--revision', revision])
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: options.env ?? process.env })
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} failed: ${result.stderr}`)
  return result
}

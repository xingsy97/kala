import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const updater = fileURLToPath(new URL('./update-dedicated-control-plane.mjs', import.meta.url))
const unitNames = [
  'agent-runlab-dedicated-ingress.service',
  'agent-runlab-dedicated-unit@.service',
  'agent-runlab-dedicated-deploy-supervisor.service',
  'agent-runlab-dedicated-control-updater.service',
  'agent-runlab-dedicated-migration-finalizer.service',
]
const unitAssets = unitNames.map((name) => name.replace('agent-runlab-', 'kala-'))

test('control updater atomically activates target and advances its own executable last', async () => {
  const fixture = await createFixture()
  const result = await runUpdater(fixture)
  const receipt = await fixture.receipt()
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}\n${JSON.stringify(receipt)}`)
  assert.equal(receipt.phase, 'completed')
  assert.equal(receipt.previousIngressPid, 101)
  assert.equal(receipt.ingressPid, 102)
  assert.equal(receipt.previousSupervisorPid, 201)
  assert.equal(receipt.supervisorPid, 202)
  assert.ok(receipt.revision >= 6)
  assert.equal(basename(await readlink(fixture.controlLink)), 'target-release')
  assert.equal(basename(await readlink(fixture.updaterLink)), 'target-release')
  assert.match(await readFile(join(fixture.unitDir, unitNames[0]), 'utf8'), /target-release/u)
})

for (const component of ['ingress', 'supervisor']) {
  test(`control updater restores predecessor after broken target ${component}`, async () => {
    const fixture = await createFixture({ failComponent: component })
    const result = await runUpdater(fixture)
    const receipt = await fixture.receipt()
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}\n${JSON.stringify(receipt)}`)
    assert.equal(receipt.phase, 'rolled_back')
    assert.match(receipt.error, new RegExp(component, 'u'))
    assert.equal(basename(await readlink(fixture.controlLink)), 'predecessor-release')
    assert.equal(basename(await readlink(fixture.updaterLink)), 'predecessor-release')
    assert.match(await readFile(join(fixture.unitDir, unitNames[0]), 'utf8'), /predecessor-release/u)
  })
}

for (const crashAfter of ['ingress', 'supervisor']) {
  test(`control updater resumes after crash following ${crashAfter} restart`, async () => {
    const fixture = await createFixture({ crashAfter })
    const first = await runUpdater(fixture)
    assert.equal(first.signal, 'SIGKILL')
    const interrupted = await fixture.receipt()
    assert.equal(interrupted.phase, crashAfter === 'ingress' ? 'ingress_restarting' : 'supervisor_restarting')
    assert.equal(basename(await readlink(fixture.updaterLink)), 'predecessor-release')

    const second = await runUpdater(fixture)
    assert.equal(second.code, 0, second.stderr)
    const completed = await fixture.receipt()
    assert.equal(completed.phase, 'completed')
    assert.ok(completed.revision > interrupted.revision)
    assert.equal(basename(await readlink(fixture.updaterLink)), 'target-release')
  })
}

test('control updater rejects a target release digest mismatch and retains predecessor', async () => {
  const fixture = await createFixture({ targetDigest: '0'.repeat(64) })
  const result = await runUpdater(fixture)
  const receipt = await fixture.receipt()
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}\n${JSON.stringify(receipt)}`)
  assert.equal(receipt.phase, 'rolled_back')
  assert.match(receipt.error, /digest mismatch/u)
  assert.equal(basename(await readlink(fixture.controlLink)), 'predecessor-release')
  assert.equal(basename(await readlink(fixture.updaterLink)), 'predecessor-release')
})

test('control updater refuses a mutable target release before changing control links', async () => {
  const fixture = await createFixture({ mutableTarget: true })
  const result = await runUpdater(fixture)
  const receipt = await fixture.receipt()
  assert.equal(result.code, 0, `${result.stderr}${result.stdout}\n${JSON.stringify(receipt)}`)
  assert.equal(receipt.phase, 'rolled_back')
  assert.match(receipt.error, /not immutable/u)
  assert.equal(basename(await readlink(fixture.controlLink)), 'predecessor-release')
  assert.equal(basename(await readlink(fixture.updaterLink)), 'predecessor-release')
})

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runlab-control-updater-'))
  const deployRoot = join(root, 'deploy')
  const releases = join(deployRoot, 'releases')
  const updateRoot = join(deployRoot, 'control-updates')
  const unitDir = join(root, 'systemd')
  const configDir = join(root, 'etc')
  const statePath = join(root, 'systemctl-state.json')
  const ingressReadiness = join(root, 'ingress-readiness.json')
  const operatorStatus = join(deployRoot, 'operator-status.json')
  const crashMarker = join(root, 'crash-injected')
  await Promise.all([mkdir(releases, { recursive: true }), mkdir(join(updateRoot, 'requests'), { recursive: true }), mkdir(join(updateRoot, 'receipts'), { recursive: true }), mkdir(unitDir), mkdir(configDir)])
  const predecessor = await createRelease(releases, 'predecessor-release')
  const target = await createRelease(releases, 'target-release')
  if (options.mutableTarget) await chmod(target.path, 0o755)
  const controlLink = join(deployRoot, 'control-current')
  const updaterLink = join(deployRoot, 'control-updater-current')
  await symlink(predecessor.path, controlLink)
  await symlink(predecessor.path, updaterLink)
  await writeJson(statePath, { ingress: 101, supervisor: 201 })
  await writeJson(ingressReadiness, { schemaVersion: 1, pid: 101, readyAt: new Date().toISOString() })
  await writeJson(operatorStatus, { schemaVersion: 1, generatedAt: new Date().toISOString(), services: { supervisor: { pid: 201 } } })
  const request = {
    schemaVersion: 1, updateId: 'control-deployment-01', deploymentId: 'deployment-01', direction: 'forward',
    targetReleaseId: 'target-release', targetReleaseDigest: options.targetDigest ?? target.digest,
    predecessorReleaseId: 'predecessor-release', predecessorReleaseDigest: predecessor.digest,
    requestedAt: new Date().toISOString(),
  }
  await writeJson(join(updateRoot, 'requests', `${request.updateId}.json`), request)
  const fakeSystemctl = join(root, 'systemctl.mjs')
  await writeFile(fakeSystemctl, `#!/usr/bin/env node
import { readFile, readlink, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
const args = process.argv.slice(2)
const statePath = process.env.TEST_SYSTEMCTL_STATE
const state = JSON.parse(await readFile(statePath, 'utf8'))
const service = args.at(-1)
const kind = service?.includes('ingress') ? 'ingress' : service?.includes('supervisor') ? 'supervisor' : undefined
if (args[0] === 'show' && kind) process.stdout.write(String(state[kind]) + '\\n')
else if (args[0] === 'is-active' && kind) process.stdout.write('active\\n')
else if (args[0] === 'daemon-reload') {}
else if (args[0] === 'restart' && kind) {
  const activeRelease = basename(await readlink(process.env.AGENT_RUNLAB_CONTROL_CURRENT))
  if (activeRelease === 'target-release' && process.env.TEST_FAIL_COMPONENT === kind) {
    process.stderr.write('broken target ' + kind + '\\n')
    process.exitCode = 1
  } else {
    state[kind] += 1
    await writeFile(statePath, JSON.stringify(state))
    const now = new Date().toISOString()
    if (kind === 'ingress') await writeFile(process.env.AGENT_RUNLAB_INGRESS_READINESS, JSON.stringify({ schemaVersion: 1, pid: state.ingress, readyAt: now }))
    else await writeFile(process.env.AGENT_RUNLAB_OPERATOR_STATUS, JSON.stringify({ schemaVersion: 1, generatedAt: now, services: { supervisor: { pid: state.supervisor } } }))
    if (activeRelease === 'target-release' && process.env.TEST_CRASH_AFTER === kind) {
      try { await readFile(process.env.TEST_CRASH_MARKER) }
      catch { await writeFile(process.env.TEST_CRASH_MARKER, kind); process.kill(process.ppid, 'SIGKILL') }
    }
  }
} else { process.stderr.write('unsupported fake systemctl call: ' + args.join(' ') + '\\n'); process.exitCode = 2 }
`)
  await chmod(fakeSystemctl, 0o755)
  return {
    root, deployRoot, updateRoot, unitDir, controlLink, updaterLink,
    env: {
      AGENT_RUNLAB_DEPLOY_ROOT: deployRoot, AGENT_RUNLAB_CONTROL_CURRENT: controlLink,
      AGENT_RUNLAB_CONTROL_UPDATER_CURRENT: updaterLink, AGENT_RUNLAB_CONTROL_UPDATE_ROOT: updateRoot,
      AGENT_RUNLAB_SYSTEMD_DIR: unitDir, AGENT_RUNLAB_DEPLOYMENT_CONFIG: join(configDir, 'deployment.json'),
      AGENT_RUNLAB_SYSTEMCTL: fakeSystemctl, AGENT_RUNLAB_INGRESS_READINESS: ingressReadiness,
      AGENT_RUNLAB_OPERATOR_STATUS: operatorStatus, TEST_SYSTEMCTL_STATE: statePath, TEST_CRASH_MARKER: crashMarker,
      AGENT_RUNLAB_CHOWN: '/usr/bin/true',
      ...(options.failComponent ? { TEST_FAIL_COMPONENT: options.failComponent } : {}),
      ...(options.crashAfter ? { TEST_CRASH_AFTER: options.crashAfter } : {}),
    },
    receipt: async () => JSON.parse(await readFile(join(updateRoot, 'receipts', `${request.updateId}.json`), 'utf8')),
  }
}

async function createRelease(releases, releaseId) {
  const path = join(releases, releaseId)
  await mkdir(path)
  const assets = [...unitAssets, 'deployment.json', 'update-dedicated-control-plane.mjs', 'kala-dashboard-dist.tar.gz', 'dashboard-release.json']
  for (const name of unitAssets) await writeFile(join(path, name), `${releaseId} ${name}\n`)
  await writeFile(join(path, 'deployment.json'), `${JSON.stringify({ schemaVersion: 1, releaseId })}\n`)
  await writeFile(join(path, 'update-dedicated-control-plane.mjs'), `// ${releaseId}\n`)
  const dashboardSource = join(path, '.dashboard-source')
  const dashboardBytes = Buffer.from(`<!doctype html><title>${releaseId}</title>`)
  await mkdir(dashboardSource)
  await writeFile(join(dashboardSource, 'index.html'), dashboardBytes)
  await run('tar', ['-czf', join(path, 'kala-dashboard-dist.tar.gz'), '-C', dashboardSource, 'index.html'])
  await writeFile(join(path, 'dashboard-release.json'), `${JSON.stringify({ schemaVersion: 1, product: 'kala-dashboard', version: '0.0.0-test', builtAt: new Date().toISOString(), source: { revision: '0'.repeat(40), snapshotSha256: '0'.repeat(64), dirty: false }, protocol: { min: '1.0.0', max: '1.0.0' }, assetDigest: sha256(dashboardBytes), files: [{ path: 'index.html', bytes: dashboardBytes.length, sha256: sha256(dashboardBytes) }] }, null, 2)}\n`)
  await import('node:fs/promises').then(({ rm }) => rm(dashboardSource, { recursive: true, force: true }))
  await writeFile(join(path, 'manifest.json'), `${JSON.stringify({ assets }, null, 2)}\n`)
  await writeFile(join(path, 'RELEASE_NOTES.md'), `${releaseId}\n`)
  const sums = []
  for (const name of [...assets, 'manifest.json', 'RELEASE_NOTES.md'].sort()) sums.push(`${sha256(await readFile(join(path, name)))}  ${name}`)
  await writeFile(join(path, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  for (const name of [...assets, 'manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS']) await chmod(join(path, name), 0o444)
  await chmod(path, 0o555)
  const sumsBytes = await readFile(join(path, 'SHA256SUMS'))
  return { path: resolve(path), digest: sha256(sumsBytes) }
}

async function run(command, args) {
  await new Promise((resolveRun, reject) => { const child = spawn(command, args, { stdio: 'ignore' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${String(code)}`))) })
}

async function runUpdater(fixture) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [updater], { env: { ...process.env, ...fixture.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
  })
}

async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`) }
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

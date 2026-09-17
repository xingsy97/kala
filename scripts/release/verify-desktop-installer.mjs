#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  desktopDownloadBase,
  desktopInstallCommands,
  desktopLocalInstallCommands,
  validateDesktopOrigin,
  validateDesktopRelease,
} from '../../packages/dashboard/public/downloads/desktop/release-data.js'

const { values } = parseArgs({
  options: {
    lxd: { type: 'string' },
    origin: { type: 'string' },
    'copied-script': { type: 'string' },
    'evidence-dir': { type: 'string' },
    fresh: { type: 'boolean', default: false },
    'local-download': { type: 'boolean', default: false },
  },
})
assert(values.lxd && /^runlab-desktop-[a-z0-9-]+$/.test(values.lxd), 'Use a task-owned runlab-desktop-* test container, never the deployed Host')
assert(values['copied-script'], 'Provide the exact Bash block captured by the browser Copy button')
assert(values['evidence-dir'], 'Provide a private evidence directory')
const origin = validateDesktopOrigin(values.origin)
const evidence = resolve(values['evidence-dir'])
await mkdir(evidence, { recursive: true, mode: 0o700 })
const response = await fetch(`${origin}${desktopDownloadBase}release.json`, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
assert(response.ok, `Published release metadata returned HTTP ${response.status}`)
const release = validateDesktopRelease(await response.json())
const command = await readFile(resolve(values['copied-script']), 'utf8')
assert.equal(command, values['local-download'] ? desktopLocalInstallCommands(release) : desktopInstallCommands(release, origin), 'Browser clipboard differs from the current published release installer')

const run = (args, options = {}) => execFileSync('lxc', ['exec', values.lxd, ...args], {
  encoding: 'utf8',
  timeout: 180_000,
  maxBuffer: 8 * 1024 * 1024,
  ...options,
})
const directories = () => new Set(run(['--', 'find', '/tmp', '-maxdepth', '1', '-type', 'd', '-name', 'agent-runlab-install.*', '-print']).trim().split('\n').filter(Boolean))
const uid = run(['--', 'id', '-u', 'ubuntu']).trim()
const gid = run(['--', 'id', '-g', 'ubuntu']).trim()
assert(/^\d+$/.test(uid) && uid !== '0', 'Acceptance must run as an ordinary user')
assert(/^\d+$/.test(gid))
const before = directories()
const localDirectory = values['local-download'] ? `/home/ubuntu/.agent-runlab-installer-${randomUUID()}` : null
const localPackage = localDirectory ? `${localDirectory}/Downloads/${release.artifact.file}` : null
const homeMode = run(['--', 'stat', '-c', '%a', '/home/ubuntu']).trim()
let localPrepared = false
const result = {
  origin, instance: values.lxd, version: release.version, artifactSha256: release.artifact.sha256,
  ordinaryUser: 'ubuntu', fresh: values.fresh, ok: false,
  localDownload: values['local-download'],
}
try {
  if (localPackage) {
    const artifact = resolve('packages/dashboard/public/downloads/desktop', release.artifact.file)
    const bytes = await readFile(artifact)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), release.artifact.sha256)
    run(['--', 'install', '-d', '-m', '0700', '-o', uid, '-g', gid, localDirectory, `${localDirectory}/Downloads`])
    localPrepared = true
    execFileSync('lxc', ['file', 'push', artifact, `${values.lxd}${localPackage}`])
    run(['--', 'chown', `${uid}:${gid}`, localPackage])
    run(['--', 'chmod', '0600', localPackage])
    const permission = spawnSync('lxc', ['exec', values.lxd, '--', 'runuser', '-u', '_apt', '--', 'test', '-r', localPackage])
    assert.equal(permission.status, 1, 'The original private download must be inaccessible to _apt')
  }
  if (values.fresh) {
    // Remove only this task's application, never dependencies or another service.
    const output = run(['--', 'apt-get', 'remove', '-y', 'agent-runlab-desktop'])
    await writeFile(resolve(evidence, 'fresh-install-setup.log'), output, { mode: 0o600 })
  }
  const execution = spawnSync('lxc', [
    'exec', values.lxd, '--user', uid, '--group', gid,
    '--env', 'HOME=/home/ubuntu', '--env', 'LC_ALL=C',
    ...(localPackage ? ['--env', `RUNLAB_DESKTOP_PACKAGE=${localPackage}`] : []),
    '--', 'bash',
  ], { input: command, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = `${execution.stdout ?? ''}\n${execution.stderr ?? ''}`
  await writeFile(resolve(evidence, 'install.log'), output, { mode: 0o600 })
  if (execution.error) throw execution.error
  assert.equal(execution.status, 0, `Copied installer failed: ${output}`)
  assert(!/unsandboxed as root|couldn't be accessed by user '_apt'/i.test(output), 'APT fell back to unsandboxed root acquisition')
  if (values.fresh) assert(output.includes('Setting up agent-runlab-desktop'), 'A fresh real installation must configure the package')
  const installed = run(['--', 'dpkg-query', '-W', '-f=${Version} ${db:Status-Status}', 'agent-runlab-desktop']).trim()
  assert.equal(installed, `${release.version} installed`)
  run(['--', 'test', '-x', '/usr/bin/agent-runlab-desktop'])
  const leftovers = [...directories()].filter((directory) => !before.has(directory))
  assert.deepEqual(leftovers, [], 'Installer left temporary downloads behind')
  assert.equal(run(['--', 'stat', '-c', '%a', '/home/ubuntu']).trim(), homeMode)
  if (localPackage) {
    assert.equal(run(['--', 'stat', '-c', '%a', localDirectory]).trim(), '700')
    assert.equal(run(['--', 'stat', '-c', '%a', localPackage]).trim(), '600')
    assert.equal(run(['--', 'sha256sum', localPackage]).trim().split(/\s+/)[0], release.artifact.sha256)
  }
  result.ok = true
  console.log(JSON.stringify({ ...result, sandboxWarning: false, temporaryDirectoriesRemaining: 0 }))
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error)
  throw error
} finally {
  if (localPrepared) {
    run(['--', 'rm', '-f', '--', localPackage])
    run(['--', 'rmdir', '--', `${localDirectory}/Downloads`, localDirectory])
  }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
}

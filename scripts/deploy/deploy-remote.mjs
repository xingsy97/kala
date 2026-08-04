#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildDeployPlan, RETIRED_RELEASE_ASSETS, rsyncUploadArgs, sh } from './deploy-plan.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const rawArgs = process.argv.slice(2)
const dryRun = rawArgs.includes('--dry-run')
const effectiveArgs = rawArgs.filter((arg) => arg !== '--dry-run')
const lxdContainer = optionValueLocal(effectiveArgs, '--lxd') ?? process.env.AK_DEPLOY_LXD
if (lxdContainer) {
  const lxdPlan = {
    mode: 'lxd',
    container: lxdContainer,
    remoteBin: optionValueLocal(effectiveArgs, '--remote-bin') ?? process.env.AK_DEPLOY_REMOTE_BIN ?? '/home/ubuntu/.bin',
    service: optionValueLocal(effectiveArgs, '--service') ?? process.env.AK_DEPLOY_SERVICE ?? 'agent-runlab-host',
    skipBuild: effectiveArgs.includes('--skip-build'),
    retiredAssets: RETIRED_RELEASE_ASSETS,
  }
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...lxdPlan }, null, 2))
    console.log('dry run complete: no build, LXD transfer, install, restart, or cleanup was executed')
    process.exit(0)
  }
  deployLxd(lxdPlan)
  process.exit(0)
}
// --async / --no-wait / AK_DEPLOY_ASYNC=1 all mean "fire the restart and exit,
// don't sit waiting for /runtime/restart/status to reach completed". This is
// required whenever the deploy tool call itself runs inside a host session:
// waiting synchronously deadlocks the graceful restart, because the checkpoint
// drain will never see this session's tool bucket empty until the deploy
// script returns, and the deploy script is the one blocking on the restart.
const asyncFlagIndex = effectiveArgs.findIndex((arg) => arg === '--async' || arg === '--no-wait')
const asyncMode = asyncFlagIndex !== -1 || /^(?:1|true|yes|on)$/i.test(process.env.AK_DEPLOY_ASYNC ?? '')
const cleanedArgs = asyncFlagIndex !== -1
  ? [...effectiveArgs.slice(0, asyncFlagIndex), ...effectiveArgs.slice(asyncFlagIndex + 1)]
  : effectiveArgs
const plan = buildDeployPlan({ args: cleanedArgs, env: process.env, root })

const {
  releaseDir,
  sshTarget,
  hostUrl,
  remoteBin,
  restartMode,
  restartTimeoutMs,
  statusTimeoutMs,
  pollMs,
  files,
  uploadDir,
  seedCommand,
  installCommand,
  rollbackCommand,
  service,
  sudo,
} = plan

console.log(`deploy target: ${sshTarget}`)
console.log(`remote bin: ${remoteBin}`)
console.log(`host url: ${hostUrl}`)
console.log(`upload dir: ${uploadDir}`)
if (service) console.log(`remote service: ${service}${sudo ? ' (sudo -n)' : ''}`)
if (asyncMode) console.log('async mode: restart is fire-and-forget (no wait for completed)')
if (dryRun) {
  console.log(`restart mode: ${restartMode}`)
  console.log(`release files: ${files.join(', ')}`)
  console.log(`retired remote files: ${RETIRED_RELEASE_ASSETS.join(', ')}`)
  console.log('dry run complete: no build, SSH command, upload, install, restart, or rollback was executed')
  process.exit(0)
}

if (service && sudo) stage('verify remote service privilege', () => remote(`sudo -n systemctl is-active ${sh(service)} >/dev/null`))
if (!effectiveArgs.includes('--skip-build')) stage('build release assets', () => run('node', ['scripts/release/build-release-assets.mjs', '--no-native', '--repo', process.env.GITHUB_REPOSITORY ?? 'local/agent-runlab']))
stage('verify release assets', () => run('node', ['scripts/release/verify-release-assets.mjs']))
stage('prepare incremental upload', () => remote(seedCommand))
stage('transfer release assets', transferReleaseAssets)
try {
  stage('install release assets', () => remote(installCommand))
} catch (error) {
  rollbackRemote('remote install failed', error)
}

let before
let restart
try {
  before = restartStatus()
  restart = requestRestart({ mode: restartMode, reason: 'deploy', timeoutMs: restartTimeoutMs })
} catch (error) {
  rollbackRemote('graceful restart request failed', error)
}
const beforePid = Number(before?.pid ?? 0)
console.log(`current host pid: ${beforePid || 'unknown'}`)
console.log(`restart attempt: ${restart?.attemptId ?? 'unknown'} phase=${restart?.phase ?? 'unknown'} mode=${restart?.mode ?? restartMode}`)

if (asyncMode) {
  console.log('deploy dispatched: restart running in background, exiting now to unblock any originating tool call.')
  console.log(`poll ${hostUrl}/runtime/restart/status to observe progress.`)
  process.exit(0)
}

const deadline = Date.now() + statusTimeoutMs
let lastPhase = restart?.phase ?? 'unknown'
while (Date.now() < deadline) {
  sleep(pollMs)
  const status = tryRestartStatus()
  if (!status) continue
  const phase = status?.current?.phase ?? status?.last?.phase ?? 'unknown'
  if (phase !== lastPhase) {
    console.log(`restart phase: ${phase}`)
    lastPhase = phase
  }
  const pid = Number(status?.pid ?? 0)
  const last = status?.last
  if (pid > 0 && beforePid > 0 && pid !== beforePid && last?.phase === 'completed') {
    try {
      if (service) remote(`${sudo ? 'sudo -n ' : ''}systemctl is-active --quiet ${sh(service)}`)
      remote(`cd ${sh(remoteBin)} && sha256sum -c SHA256SUMS --ignore-missing`)
    } catch (error) {
      rollbackRemote('post-restart verification failed', error)
    }
    console.log(`deploy complete: host restarted pid ${beforePid} -> ${pid}`)
    process.exit(0)
  }
  if (last?.phase === 'failed' || last?.phase === 'aborted') {
    rollbackRemote(`restart ${last.phase}`, new Error(`restart ${last.phase}: ${last.error ?? 'no error detail'}`))
  }
}

rollbackRemote('graceful restart timed out', new Error(`timed out waiting for graceful restart after ${statusTimeoutMs}ms`))

function restartStatus() {
  return remoteJson(`curl -fsS ${sh(`${hostUrl}/runtime/restart/status`)}`)
}

function tryRestartStatus() {
  try {
    return restartStatus()
  } catch {
    return null
  }
}

function requestRestart(payload) {
  return remoteJson([
    'curl -fsS',
    '-H Content-Type:application/json',
    '-X POST',
    `--data ${sh(JSON.stringify(payload))}`,
    sh(`${hostUrl}/runtime/restart`),
  ].join(' '))
}

function remoteJson(command) {
  const result = run('ssh', [sshTarget, command], { capture: true })
  try {
    return JSON.parse(result.stdout)
  } catch (err) {
    throw new Error(`remote command did not return JSON: ${err instanceof Error ? err.message : String(err)}\n${result.stdout}`)
  }
}

function remote(command) {
  run('ssh', [sshTarget, command])
}

function rollbackRemote(reason, error) {
  console.error(`${reason}; rolling back remote release`)
  try {
    remote(rollbackCommand)
  } catch (rollbackError) {
    console.error(`rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
  }
  throw error
}

function transferReleaseAssets() {
  const args = rsyncUploadArgs({ releaseDir, files, sshTarget, uploadDir })
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      run('rsync', args)
      return
    } catch (error) {
      if (attempt === maxAttempts) throw error
      console.warn(`transfer attempt ${attempt}/${maxAttempts} failed; retrying the partial upload in 2s`)
      sleep(2000)
    }
  }
}

function stage(label, action) {
  const startedAt = Date.now()
  console.log(`${label}...`)
  action()
  console.log(`${label}: completed in ${formatDuration(Date.now() - startedAt)}`)
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.status !== 0) {
    const stderr = options.capture ? `\n${result.stderr}` : ''
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${stderr}`)
  }
  return result
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function deployLxd({ container, remoteBin, service, skipBuild }) {
  const releaseDir = join(root, 'release')
  if (!skipBuild) stage('build release assets', () => run('node', ['scripts/release/build-release-assets.mjs', '--no-native', '--repo', process.env.GITHUB_REPOSITORY ?? 'local/agent-runlab']))
  stage('verify release assets', () => run('node', ['scripts/release/verify-release-assets.mjs']))
  const sums = readFileSync(join(releaseDir, 'SHA256SUMS'), 'utf8')
  const files = ['bundle-dashboard-with-runtime.cjs', 'agent-kernel-executor.cjs', 'SHA256SUMS']
  for (const file of files) if (!existsSync(join(releaseDir, file))) throw new Error(`missing release asset: ${file}`)
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const upload = `${remoteBin}/.agent-kernel-upload-${stamp}`
  const backup = `${remoteBin}/.agent-kernel-backup-${stamp}`
  const managed = [...files, ...RETIRED_RELEASE_ASSETS]
  stage('prepare LXD upload', () => lxcExec(container, `mkdir -p ${sh(upload)} ${sh(backup)}`))
  stage('transfer LXD release assets', () => { for (const file of files) run('lxc', ['file', 'push', join(releaseDir, file), `${container}${upload}/${file}`]) })
  stage('verify staged checksums', () => lxcExec(container, `cd ${sh(upload)} && sha256sum -c SHA256SUMS --ignore-missing`))
  const install = ['set -euo pipefail', `BIN=${sh(remoteBin)}`, `UPLOAD=${sh(upload)}`, `BACKUP=${sh(backup)}`, `for f in ${managed.map(sh).join(' ')}; do [ ! -e "$BIN/$f" ] || cp -p "$BIN/$f" "$BACKUP/$f"; done`, `rm -f ${RETIRED_RELEASE_ASSETS.map((file) => `"$BIN/${file}"`).join(' ')}`, `for f in ${files.map(sh).join(' ')}; do mv "$UPLOAD/$f" "$BIN/$f"; done`, 'chmod 755 "$BIN/bundle-dashboard-with-runtime.cjs" "$BIN/agent-kernel-executor.cjs"', `systemctl restart ${sh(service)}`].join('\n')
  try {
    stage('install and restart LXD service', () => lxcExec(container, install))
    stage('verify LXD service health', () => { lxcExec(container, `systemctl is-active --quiet ${sh(service)}`); lxcExec(container, `pid=$(systemctl show -p MainPID --value ${sh(service)}); [ "$pid" -gt 1 ] && kill -0 "$pid"`) })
    const localHash = sums.match(/^([a-f0-9]{64})\s+bundle-dashboard-with-runtime\.cjs$/m)?.[1]
    const remoteHash = run('lxc', ['exec', container, '--', 'sha256sum', `${remoteBin}/bundle-dashboard-with-runtime.cjs`], { capture: true }).stdout.trim().split(/\s+/u)[0]
    if (!localHash || localHash !== remoteHash) throw new Error(`deployed bundle hash mismatch: local=${localHash ?? 'missing'} remote=${remoteHash}`)
    lxcExec(container, `rm -rf ${sh(upload)} ${sh(backup)}`)
    console.log(`deploy complete: LXD ${container} service=${service} sha256=${remoteHash}`)
  } catch (error) {
    console.error(`deploy failed; rolling back LXD ${container}`)
    lxcExec(container, `set -eu; BIN=${sh(remoteBin)}; BACKUP=${sh(backup)}; for f in ${managed.map(sh).join(' ')}; do rm -f "$BIN/$f"; [ ! -e "$BACKUP/$f" ] || cp -p "$BACKUP/$f" "$BIN/$f"; done; systemctl restart ${sh(service)}`)
    throw error
  }
}

function lxcExec(container, command) { run('lxc', ['exec', container, '--', 'sh', '-lc', command]) }
function optionValueLocal(args, name) { for (let i = 0; i < args.length; i++) { if (args[i] === name) return args[i + 1]; if (args[i]?.startsWith(`${name}=`)) return args[i].slice(name.length + 1) } return undefined }

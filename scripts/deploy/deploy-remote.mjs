#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDeployPlan, sh } from './deploy-plan.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const rawArgs = process.argv.slice(2)
// --async / --no-wait / AK_DEPLOY_ASYNC=1 all mean "fire the restart and exit,
// don't sit waiting for /runtime/restart/status to reach completed". This is
// required whenever the deploy tool call itself runs inside a host session:
// waiting synchronously deadlocks the graceful restart, because the checkpoint
// drain will never see this session's tool bucket empty until the deploy
// script returns, and the deploy script is the one blocking on the restart.
const asyncFlagIndex = rawArgs.findIndex((arg) => arg === '--async' || arg === '--no-wait')
const asyncMode = asyncFlagIndex !== -1 || /^(?:1|true|yes|on)$/i.test(process.env.AK_DEPLOY_ASYNC ?? '')
const cleanedArgs = asyncFlagIndex !== -1
  ? [...rawArgs.slice(0, asyncFlagIndex), ...rawArgs.slice(asyncFlagIndex + 1)]
  : rawArgs
const plan = buildDeployPlan({ args: cleanedArgs, env: process.env, root })

const {
  releaseDir,
  sshTarget,
  hostUrl,
  remoteBin,
  remoteBinShell,
  restartMode,
  restartTimeoutMs,
  statusTimeoutMs,
  pollMs,
  files,
  uploadDir,
  uploadDirShell,
  installCommand,
} = plan

console.log(`deploy target: ${sshTarget}`)
console.log(`remote bin: ${remoteBin}`)
console.log(`host url: ${hostUrl}`)
console.log(`upload dir: ${uploadDir}`)
if (asyncMode) console.log('async mode: restart is fire-and-forget (no wait for completed)')

remote(`mkdir -p ${remoteBinShell} ${uploadDirShell}`)
run('scp', ['-q', ...files.map((file) => join(releaseDir, file)), `${sshTarget}:${uploadDir}/`])
remote(installCommand)

const before = restartStatus()
const beforePid = Number(before?.pid ?? 0)
console.log(`current host pid: ${beforePid || 'unknown'}`)

const restart = requestRestart({ mode: restartMode, reason: 'deploy', timeoutMs: restartTimeoutMs })
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
    console.log(`deploy complete: host restarted pid ${beforePid} -> ${pid}`)
    process.exit(0)
  }
  if (last?.phase === 'failed' || last?.phase === 'aborted') {
    throw new Error(`restart ${last.phase}: ${last.error ?? 'no error detail'}`)
  }
}

throw new Error(`timed out waiting for graceful restart after ${statusTimeoutMs}ms`)

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

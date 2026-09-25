#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCommand, startProcess, waitFor, waitForHttp } from './harness.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const bundle = join(root, 'release', 'kala-dashboard-with-runtime.cjs')
const port = Number(process.env.PRODUCT_E2E_POWERSHELL_INSTALLER_PORT ?? 3215)
const origin = `http://127.0.0.1:${port}`
const image = process.env.PRODUCT_E2E_POWERSHELL_IMAGE ?? 'mcr.microsoft.com/powershell:lts-ubuntu-22.04'
const container = `runlab-pwsh-e2e-${Date.now()}-${process.pid}`
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-e2e-powershell-host-'))
const hostLogs = []
const executorLogs = []
let host
let executor

try {
  host = startProcess(bundle, [], { cwd: root, env: {
    ...process.env,
    HOST_LISTEN_HOST: '0.0.0.0', HOST_PORT: String(port),
    AGENT_KERNEL_STATE_DIR: join(stateRoot, 'state'), SESSIONS_DIR: join(stateRoot, 'sessions'),
    AGENT_KERNEL_ARTIFACTS_DIR: join(stateRoot, 'artifacts'), ANTHROPIC_API_KEY: 'unused',
  } })
  host.stdout?.on('data', (chunk) => hostLogs.push(chunk.toString()))
  host.stderr?.on('data', (chunk) => hostLogs.push(chunk.toString()))
  await waitForHttp(`${origin}/install.ps1`)

  const createdResponse = await fetch(`${origin}/api/executor-installs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'windows', mode: 'temporary', workspaceRoot: '__RUNLAB_CURRENT_DIRECTORY__', label: 'powershell-e2e' }),
  })
  if (!createdResponse.ok) throw new Error(`create installation failed: ${createdResponse.status}`)
  const created = await createdResponse.json()
  const command = `$env:RUNLAB_SETUP_CODE='${created.setupCode}'; $env:RUNLAB_INSTALL_MODE='temporary'; irm '${origin}/install.ps1' | iex`
  executor = startProcess('sg', ['docker', '-c', `docker run --rm --name ${container} --network host -e RUNLAB_SETUP_CODE='${created.setupCode}' -e RUNLAB_INSTALL_MODE=temporary -w /tmp ${image} pwsh -NoLogo -NoProfile -Command \"irm '${origin}/install.ps1' | iex\"`], { cwd: root })
  executor.stdout?.on('data', (chunk) => executorLogs.push(chunk.toString()))
  executor.stderr?.on('data', (chunk) => executorLogs.push(chunk.toString()))

  const snapshot = await waitFor(async () => {
    const response = await fetch(`${origin}/api/executor-installs/${encodeURIComponent(created.id)}`)
    if (!response.ok) return false
    const value = await response.json()
    return value.status === 'completed' ? value : false
  }, { timeoutMs: 120_000, name: 'PowerShell temporary installation completion' })
  const events = await fetch(`${origin}/api/executor-installs/${encodeURIComponent(created.id)}/events`).then((response) => response.json())
  const statuses = events.events.map((event) => event.status)
  for (const expected of ['asset_verified', 'paired', 'starting', 'online', 'completed']) {
    if (!statuses.includes(expected)) throw new Error(`PowerShell installation omitted ${expected}: ${JSON.stringify(statuses)}`)
  }
  const output = executorLogs.join('')
  for (const expected of ['[1/4] Downloading verified installer', '[2/4] Validating setup code', '[3/4] Starting Executor', 'EXECUTOR CONNECTED - FOREGROUND MODE', 'awaiting tool calls']) {
    if (!output.includes(expected)) throw new Error(`PowerShell output omitted ${expected}:\n${output}`)
  }
  if (/null-valued expression|No such file or directory/u.test(output)) throw new Error(`PowerShell output contains known failure:\n${output}`)
  console.log(`PASS add-workspace-powershell-temporary system E2E installation=${snapshot.id}`)
  console.log(`Command shape: ${command.replace(created.setupCode, '[REDACTED]')}`)
} catch (error) {
  console.error(error)
  console.error(`--- PowerShell/Executor output ---\n${executorLogs.join('')}`)
  console.error(`--- Host output ---\n${hostLogs.join('')}`)
  process.exitCode = 1
} finally {
  executor?.kill('SIGTERM')
  host?.kill('SIGTERM')
  await runCommand('sg', ['docker', '-c', `docker rm --force ${container}`], { allowFailure: true, timeoutMs: 30_000 })
  rmSync(stateRoot, { recursive: true, force: true })
}

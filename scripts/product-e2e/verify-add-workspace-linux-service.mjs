#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ProductE2EHarness,
  clickByTestId,
  runCommand,
  sha256File,
  startProcess,
  waitFor,
  waitForHttp,
} from './harness.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const release = join(root, 'release')
const bundle = join(release, 'bundle-dashboard-with-runtime.cjs')
const port = Number(process.env.PRODUCT_E2E_INSTALLER_PORT ?? 3194)
const hostOrigin = process.env.PRODUCT_E2E_INSTALLER_ORIGIN ?? `http://192.0.2.3:${port}`
const localProbe = `http://127.0.0.1:${port}`
const image = process.env.PRODUCT_E2E_LXD_IMAGE ?? 'ubuntu:24.04'
const runId = `${Date.now()}-${process.pid}`
const container = `runlab-e2e-install-${runId}`
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-e2e-install-host-'))
const sessionsDir = join(stateRoot, 'sessions')
const artifactsDir = join(stateRoot, 'artifacts')
const workspace = '/tmp/runlab-e2e-workspace'
const harness = new ProductE2EHarness({ name: 'add-workspace-linux-service' })
const hostLogs = []
let actor
let installationId
let redactedCommand
let result
let thrown

try {
  if (!existsSync(bundle)) throw new Error('release bundle is missing; run pnpm run build:release-assets first')
  await harness.start()
  harness.registerResource('state-root', stateRoot, async () => rmSync(stateRoot, { recursive: true, force: true }))

  await harness.step('start production Host bundle', async () => {
    const child = startProcess(bundle, [], {
      cwd: root,
      env: {
        ...process.env,
        HOST_LISTEN_HOST: '0.0.0.0',
        HOST_PORT: String(port),
        SESSIONS_DIR: sessionsDir,
        AGENT_KERNEL_ARTIFACTS_DIR: artifactsDir,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'e2e-unused',
      },
    })
    harness.registerProcess('production-host', child, hostLogs)
    await waitForHttp(`${localProbe}/install`, { timeoutMs: 30_000 })
    return { pid: child.pid, bundleSha256: sha256File(bundle), origin: hostOrigin }
  })

  actor = await harness.newActor('operator')
  await harness.step('open production Dashboard Add Workspace dialog', async () => {
    await actor.page.goto(hostOrigin, { waitUntil: 'networkidle2' })
    await clickByTestId(actor.page, 'connect-workspace-button').catch(async () => clickByTestId(actor.page, 'no-session-connect-workspace'))
    await actor.page.waitForSelector('[data-testid="connect-workspace-dialog"]')
    await actor.page.waitForFunction(() => {
      const text = document.querySelector('[data-testid="executor-terminal-command"]')?.textContent ?? ''
      return text.includes('RUNLAB_SETUP_CODE=') && text.includes('/install')
    })
    const command = await actor.page.$eval('[data-testid="executor-terminal-command"] pre', (element) => element.textContent ?? '')
    redactedCommand = command.replace(/RUNLAB_SETUP_CODE='[^']+'/u, "RUNLAB_SETUP_CODE='[REDACTED]'")
    return command
  }, (command) => ({ command: redactedCommand, physicalLines: command.split(/\r?\n/u).length }))

  await harness.step('create clean systemd LXD environment', async () => {
    await runCommand('lxc', ['init', image, container], { cwd: root, timeoutMs: 120_000 })
    harness.registerResource('lxd-instance', container, async () => {
      await runCommand('lxc', ['delete', '--force', container], { cwd: root, timeoutMs: 60_000, allowFailure: true })
      const listed = await runCommand('lxc', ['list', container, '--format', 'csv', '-c', 'n'], { cwd: root })
      if (listed.stdout.trim()) throw new Error(`LXD instance remains after cleanup: ${container}`)
    })
    await runCommand('lxc', ['start', container], { cwd: root })
    await waitFor(async () => {
      const state = await runCommand('lxc', ['exec', container, '--', 'systemctl', 'is-system-running'], { allowFailure: true })
      return /running|degraded/u.test(state.stdout) && true
    }, { timeoutMs: 90_000, name: 'LXD systemd' })
    await runCommand('lxc', ['exec', container, '--', 'mkdir', '-p', workspace])
    return { container, image, workspace }
  })

  await harness.step('execute the exact Dashboard command as root in LXD', async () => {
    const command = await actor.page.$eval('[data-testid="executor-terminal-command"] pre', (element) => element.textContent ?? '')
    const execution = await runCommand('lxc', ['exec', container, '--cwd', workspace, '--', 'sh', '-lc', command], { cwd: root, timeoutMs: 180_000 })
    installationId = await waitFor(async () => {
      const records = JSON.parse(await (await import('node:fs/promises')).readFile(join(stateRoot, 'executor-installations.json'), 'utf8'))
      return records.installations.find((item) => item.status === 'completed')?.id
    }, { timeoutMs: 60_000, name: 'completed installation record' })
    return execution
  }, (execution) => ({ exitCode: execution.code, stdout: execution.stdout.slice(-1_000), stderr: execution.stderr.slice(-1_000), installationId }))

  await harness.step('verify service, files, authoritative state, and visible Workspace', async () => {
    const service = await runCommand('lxc', ['exec', container, '--', 'sh', '-lc', [
      'systemctl is-active runlab-executor.service',
      'systemctl is-enabled runlab-executor.service',
      'stat -c "%a %n" /etc/runlab-executor/executor.json /etc/runlab-executor/credential /etc/systemd/system/runlab-executor.service',
    ].join('; ')])
    const snapshot = await fetch(`${localProbe}/api/executor-installs/${encodeURIComponent(installationId)}`).then((response) => response.json())
    await actor.page.waitForSelector('[data-testid="workspace-row"][data-online="true"]', { timeout: 30_000 })
    await actor.page.waitForFunction(() => /connected|已连接/iu.test(document.querySelector('[data-testid="installation-status"]')?.textContent ?? ''), { timeout: 30_000 })
    const visibleStatus = await actor.page.$eval('[data-testid="installation-status"]', (element) => element.textContent?.trim() ?? '')
    await harness.screenshot(actor, 'installed-workspace')
    return { service: service.stdout.trim(), snapshot, visibleStatus }
  }, ({ service, snapshot }) => {
    if (snapshot.status !== 'completed') throw new Error(`installation is ${snapshot.status}`)
    if (!/^active\nenabled\n600 /u.test(service)) throw new Error(`unexpected service proof: ${service}`)
    return { service, status: snapshot.status }
  })

  await harness.step('restart installed service and observe reconnect', async () => {
    await runCommand('lxc', ['exec', container, '--', 'systemctl', 'restart', 'runlab-executor.service'])
    await waitFor(async () => {
      const value = await runCommand('lxc', ['exec', container, '--', 'systemctl', 'is-active', 'runlab-executor.service'], { allowFailure: true })
      return value.stdout.trim() === 'active'
    }, { timeoutMs: 30_000, name: 'restarted service' })
    await actor.page.waitForSelector('[data-testid="workspace-row"][data-online="true"]', { timeout: 30_000 })
    return { active: true, visibleOnline: true }
  })

  await harness.step('reject setup-code replay', async () => {
    const command = await actor.page.$eval('[data-testid="executor-terminal-command"] pre', (element) => element.textContent ?? '')
    const replay = await runCommand('lxc', ['exec', container, '--cwd', workspace, '--', 'sh', '-lc', command], { cwd: root, timeoutMs: 60_000, allowFailure: true })
    if (replay.code === 0 || !/invalid, expired, or already used|401/u.test(`${replay.stdout}\n${replay.stderr}`)) {
      throw new Error(`replay was not rejected: ${JSON.stringify(replay)}`)
    }
    return { exitCode: replay.code, diagnostic: `${replay.stdout}\n${replay.stderr}`.slice(-600) }
  })
} catch (error) {
  thrown = error
} finally {
  result = await harness.finalize({
    revision: (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true })).stdout.trim(),
    artifact: { path: 'release/bundle-dashboard-with-runtime.cjs', sha256: existsSync(bundle) ? sha256File(bundle) : null },
    controlledBoundaries: ['public DNS/domain routing omitted; local LXD bridge origin used'],
    untestedExternalCapabilities: ['public reverse proxy', 'macOS launchd', 'Windows service manager'],
    installationId,
    generatedCommand: redactedCommand,
    hostLogTail: hostLogs.slice(-80),
  })
}

if (!thrown) {
  try { harness.assertClean(result.report) } catch (error) { thrown = error }
}
if (thrown) {
  console.error(thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown))
  console.error(`Evidence: ${result?.evidenceRoot ?? '<unavailable>'}`)
  process.exit(1)
}
console.log(`PASS add-workspace-linux-service system E2E\nEvidence: ${result.evidenceRoot}`)

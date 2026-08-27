#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProductE2EHarness, clickByTestId, hoverAncestorAndClickFirst, runCommand, sha256File, startProcess, waitFor, waitForHttp } from './harness.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const bundle = join(root, 'release', 'bundle-dashboard-with-runtime.cjs')
const port = Number(process.env.PRODUCT_E2E_TEMP_INSTALLER_PORT ?? 3205)
const hostOrigin = process.env.PRODUCT_E2E_TEMP_INSTALLER_ORIGIN ?? `http://192.0.2.3:${port}`
const localProbe = `http://127.0.0.1:${port}`
const image = process.env.PRODUCT_E2E_LXD_IMAGE ?? 'ubuntu:24.04'
const container = `runlab-e2e-temp-${Date.now()}-${process.pid}`
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-e2e-temp-host-'))
const sessionsDir = join(stateRoot, 'sessions')
const workspace = '/tmp/runlab-e2e-temporary-workspace'
const harness = new ProductE2EHarness({ name: 'add-workspace-linux-temporary' })
const hostLogs = []
const temporaryLogs = []
let actor
let installationId
let redactedCommand
let result
let thrown

try {
  if (!existsSync(bundle)) throw new Error('release bundle is missing')
  await harness.start()
  harness.registerResource('state-root', stateRoot, async () => rmSync(stateRoot, { recursive: true, force: true }))
  await harness.step('start production Host bundle', async () => {
    const child = startProcess(bundle, [], { cwd: root, env: {
      ...process.env, HOST_LISTEN_HOST: '0.0.0.0', HOST_PORT: String(port), SESSIONS_DIR: sessionsDir,
      AGENT_KERNEL_ARTIFACTS_DIR: join(stateRoot, 'artifacts'), ANTHROPIC_API_KEY: 'unused',
    } })
    harness.registerProcess('production-host', child, hostLogs)
    await waitForHttp(`${localProbe}/install`)
    return { pid: child.pid, bundleSha256: sha256File(bundle) }
  })

  actor = await harness.newActor('operator')
  await harness.step('select temporary mode and read exact Dashboard command', async () => {
    await actor.page.goto(hostOrigin, { waitUntil: 'networkidle2' })
    await clickByTestId(actor.page, 'connect-workspace-button').catch(async () => clickByTestId(actor.page, 'no-session-connect-workspace'))
    await actor.page.waitForSelector('[data-testid="connect-workspace-dialog"]')
    await actor.page.waitForFunction(() => (document.querySelector('[data-testid="executor-terminal-command"]')?.textContent ?? '').includes("RUNLAB_INSTALL_MODE='service'"))
    await clickByTestId(actor.page, 'connect-workspace-temporary')
    await actor.page.waitForFunction(() => (document.querySelector('[data-testid="executor-terminal-command"]')?.textContent ?? '').includes("RUNLAB_INSTALL_MODE='temporary'"))
    const command = await actor.page.$eval('[data-testid="executor-terminal-command"] pre', (element) => element.textContent ?? '')
    redactedCommand = command.replace(/RUNLAB_SETUP_CODE='[^']+'/u, "RUNLAB_SETUP_CODE='[REDACTED]'")
    return { command, redactedCommand }
  }, () => ({ command: redactedCommand }))

  await harness.step('create clean LXD and launch temporary command', async () => {
    await runCommand('lxc', ['init', image, container], { timeoutMs: 120_000 })
    harness.registerResource('lxd-instance', container, async () => {
      await runCommand('lxc', ['delete', '--force', container], { allowFailure: true, timeoutMs: 60_000 })
      const remaining = await runCommand('lxc', ['list', container, '--format', 'csv', '-c', 'n'])
      if (remaining.stdout.trim()) throw new Error(`LXD instance remains: ${container}`)
    })
    await runCommand('lxc', ['start', container])
    await waitFor(async () => /running|degraded/u.test((await runCommand('lxc', ['exec', container, '--', 'systemctl', 'is-system-running'], { allowFailure: true })).stdout), { timeoutMs: 90_000, name: 'LXD systemd' })
    await runCommand('lxc', ['exec', container, '--', 'mkdir', '-p', workspace])
    const command = await actor.page.$eval('[data-testid="executor-terminal-command"] pre', (element) => element.textContent ?? '')
    const temporary = startProcess('lxc', ['exec', container, '--cwd', workspace, '--', 'sh', '-lc', command], { cwd: root })
    harness.registerProcess('temporary-executor-command', temporary, temporaryLogs)
    installationId = await waitFor(async () => {
      const response = await fetch(`${localProbe}/api/executor-installs`).then((value) => value.json()).catch(() => null)
      return response?.installations?.find?.((item) => item.status === 'completed')?.id
        ?? JSON.parse(await (await import('node:fs/promises')).readFile(join(stateRoot, 'executor-installations.json'), 'utf8')).installations.find((item) => item.status === 'completed')?.id
    }, { timeoutMs: 90_000, name: 'temporary installation completed' })
    return { container, installationId }
  })

  await harness.step('verify temporary Workspace online without service installation', async () => {
    await actor.page.waitForSelector('[data-testid="workspace-row"][data-online="true"]', { timeout: 30_000 })
    const service = await runCommand('lxc', ['exec', container, '--', 'systemctl', 'is-enabled', 'runlab-executor.service'], { allowFailure: true })
    if (service.code === 0) throw new Error('temporary mode unexpectedly installed a service')
    const snapshot = await fetch(`${localProbe}/api/executor-installs/${encodeURIComponent(installationId)}`).then((response) => response.json())
    if (snapshot.status !== 'completed' || snapshot.mode !== 'temporary') throw new Error(`unexpected installation snapshot: ${JSON.stringify(snapshot)}`)
    await waitFor(() => temporaryLogs.some((line) => line.includes('EXECUTOR CONNECTED - FOREGROUND MODE')) && temporaryLogs.some((line) => line.includes('Stop    Press Ctrl+C')) && temporaryLogs.some((line) => line.includes('Logs    This terminal is the live log stream')), { timeoutMs: 30_000, name: 'temporary lifecycle instructions' })
    if (temporaryLogs.some((line) => /% Total|Xferd|Average Speed/u.test(line))) throw new Error(`temporary installer output contains curl progress noise: ${temporaryLogs.join('')}`)
    await harness.screenshot(actor, 'temporary-workspace-online')
    return { status: snapshot.status, mode: snapshot.mode, serviceInstalled: false }
  })

  await harness.step('browse temporary Workspace directory and create a Session', async () => {
    const previous = new URL(actor.page.url()).searchParams.get('sessionId')
    await hoverAncestorAndClickFirst(actor.page, '[data-testid^="workspace-new-session-"]', '[data-testid="workspace-row"]', { description: 'New Session for temporary Workspace' })
    await actor.page.waitForSelector('[data-testid="new-session-dialog"]')
    await actor.page.waitForSelector('[data-testid="finder-column"]', { timeout: 15_000 })
    const dialogText = await actor.page.$eval('[data-testid="new-session-dialog"]', (element) => element.textContent ?? '')
    if (dialogText.includes('Directory request timed out')) throw new Error(dialogText)
    await actor.page.waitForFunction(() => !document.querySelector('[data-testid="new-session-create"]')?.hasAttribute('disabled'))
    await clickByTestId(actor.page, 'new-session-create')
    await actor.page.waitForFunction((oldId) => {
      const next = new URL(location.href).searchParams.get('sessionId')
      return Boolean(next && next !== oldId)
    }, {}, previous)
    return { sessionId: new URL(actor.page.url()).searchParams.get('sessionId'), directoryListed: true }
  })

  await harness.step('terminate foreground command and observe Workspace offline', async () => {
    await runCommand('lxc', ['exec', container, '--', 'sh', '-lc', "for pid in $(pgrep -x runlab-executor || true); do kill -TERM \"$pid\"; done"])
    await waitFor(async () => {
      const probe = await runCommand('lxc', ['exec', container, '--', 'pgrep', '-x', 'runlab-executor'], { allowFailure: true })
      return probe.code !== 0
    }, { timeoutMs: 30_000, name: 'temporary Executor exit' })
    const resource = harness.resources.find((item) => item.kind === 'process' && item.id === 'temporary-executor-command')
    await resource.cleanup()
    resource.cleaned = true
    await actor.page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="workspace-row"]')]
      return rows.length === 0 || rows.every((row) => row.getAttribute('data-online') !== 'true')
    }, { timeout: 30_000 })
    return { terminated: true, offlineVisible: true }
  })
} catch (error) { thrown = error } finally {
  result = await harness.finalize({ revision: (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true })).stdout.trim(),
    controlledBoundaries: ['public DNS/domain routing omitted; local LXD bridge origin used'], untestedExternalCapabilities: [], installationId,
    generatedCommand: redactedCommand, hostLogTail: hostLogs.slice(-80), temporaryLogTail: temporaryLogs.slice(-80) })
}
if (!thrown) { try { harness.assertClean(result.report) } catch (error) { thrown = error } }
if (thrown) { console.error(thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown)); console.error(`Evidence: ${result?.evidenceRoot ?? '<unavailable>'}`); process.exit(1) }
console.log(`PASS add-workspace-linux-temporary system E2E\nEvidence: ${result.evidenceRoot}`)

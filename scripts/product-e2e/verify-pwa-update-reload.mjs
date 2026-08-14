#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProductE2EHarness, clickByTestId, runCommand, sha256File, startProcess, waitFor, waitForHttp } from './harness.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const dist = join(root, 'packages', 'dashboard', 'dist')
const bundle = join(root, 'release', 'bundle-dashboard-with-runtime.cjs')
const executorAsset = join(root, 'release', 'runlab-executor-linux-x64')
const port = Number(process.env.PRODUCT_E2E_PWA_PORT ?? 3199)
const origin = `http://127.0.0.1:${port}`
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-e2e-pwa-state-'))
const home = join(stateRoot, 'home')
const sessionsDir = join(stateRoot, 'sessions')
const workspace = join(stateRoot, 'workspace')
const served = join(stateRoot, 'served-dashboard')
const v1 = join(stateRoot, 'dashboard-v1')
const v2 = join(stateRoot, 'dashboard-v2')
const token = `pwa-e2e-${process.pid}-${Date.now()}`
const harness = new ProductE2EHarness({ name: 'pwa-update-reload' })
const hostLogs = []
const executorLogs = []
let actor
let sessionId
let result
let thrown

for (const path of [home, sessionsDir, workspace]) mkdirSync(path, { recursive: true })

function prepareVersion(target, version) {
  cpSync(dist, target, { recursive: true })
  const indexPath = join(target, 'index.html')
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('</head>', `<meta name="runlab-e2e-build" content="${version}" /></head>`))
  writeFileSync(join(target, 'sw.js'), `${readFileSync(join(target, 'sw.js'), 'utf8')}\n/* runlab-e2e-build:${version} */\n`)
}
function activateVersion(source) {
  const next = `${served}.next`
  const previous = `${served}.previous`
  rmSync(next, { recursive: true, force: true })
  cpSync(source, next, { recursive: true })
  rmSync(previous, { recursive: true, force: true })
  if (existsSync(served)) renameSync(served, previous)
  renameSync(next, served)
  rmSync(previous, { recursive: true, force: true })
}

try {
  if (!existsSync(join(dist, 'sw.js')) || !existsSync(bundle) || !existsSync(executorAsset)) throw new Error('built production Dashboard/Host/Executor artifacts are required')
  prepareVersion(v1, 'v1')
  prepareVersion(v2, 'v2')
  activateVersion(v1)
  await harness.start()
  harness.registerResource('state-root', stateRoot, async () => rmSync(stateRoot, { recursive: true, force: true }))

  await harness.step('start production Host and Executor with v1 Dashboard', async () => {
    const host = startProcess(bundle, [], { cwd: root, env: {
      ...process.env, HOME: home, HOST_LISTEN_HOST: '127.0.0.1', HOST_PORT: String(port), SESSIONS_DIR: sessionsDir,
      DASHBOARD_DIR: served, AGENT_KERNEL_ARTIFACTS_DIR: join(stateRoot, 'artifacts'), EXECUTOR_TOKENS: JSON.stringify([{ token }]), ANTHROPIC_API_KEY: 'unused',
    } })
    harness.registerProcess('production-host', host, hostLogs)
    await waitForHttp(`${origin}/`)
    const executor = startProcess(executorAsset, ['--host', origin, '--sandbox-root', workspace], { cwd: workspace, env: {
      ...process.env, HOME: home, HOST_URL: origin, EXECUTOR_TOKEN: token, WORKSPACE_NAME: 'pwa-e2e-workspace', AGENT_KERNEL_WORKSPACE_ID_FILE: join(stateRoot, 'workspace-id'),
    } })
    harness.registerProcess('production-executor', executor, executorLogs)
    await waitFor(() => executorLogs.some((line) => line.includes('executor announced')), { timeoutMs: 30_000, name: 'Executor announce' })
    return { v1Sw: sha256File(join(v1, 'sw.js')), v2Sw: sha256File(join(v2, 'sw.js')) }
  })

  actor = await harness.newActor('pwa-operator')
  await harness.step('install v1 service worker and create durable Session', async () => {
    await actor.page.goto(origin, { waitUntil: 'networkidle2' })
    await actor.page.waitForFunction(() => document.querySelector('meta[name="runlab-e2e-build"]')?.content === 'v1')
    await waitFor(async () => await actor.page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active)), { timeoutMs: 30_000, name: 'v1 active service worker' })
    if (!await actor.page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
      await actor.page.reload({ waitUntil: 'networkidle2' })
    }
    await actor.page.evaluate(() => [...document.querySelectorAll('[data-testid^="workspace-new-session-"]')].find((item) => !item.hasAttribute('disabled'))?.click())
    await actor.page.waitForSelector('[data-testid="new-session-dialog"]')
    await clickByTestId(actor.page, 'new-session-create')
    await actor.page.waitForFunction(() => new URL(location.href).searchParams.has('sessionId'))
    sessionId = new URL(actor.page.url()).searchParams.get('sessionId')
    await actor.page.waitForSelector('[data-testid="new-session-dialog"]', { hidden: true })
    return { sessionId, controlled: await actor.page.evaluate(() => Boolean(navigator.serviceWorker.controller)), version: 'v1' }
  })

  await harness.step('switch server to v2 and observe real update banner', async () => {
    activateVersion(v2)
    await actor.page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      await registration?.update()
    })
    await actor.page.waitForSelector('[data-testid="pwa-update-global-banner"]', { timeout: 30_000 })
    return { waiting: await actor.page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)), banner: true }
  })

  await harness.step('click Reload and bound controllerchange plus navigation', async () => {
    await actor.page.evaluate(() => { sessionStorage.setItem('pwa-e2e-reload-start', String(performance.now())) })
    const started = Date.now()
    await clickByTestId(actor.page, 'pwa-update-reload')
    await actor.page.waitForFunction((expectedSession) => {
      return document.querySelector('meta[name="runlab-e2e-build"]')?.content === 'v2'
        && new URL(location.href).searchParams.get('sessionId') === expectedSession
        && Boolean(document.querySelector('[data-testid="composer-input"]'))
    }, { timeout: 15_000 }, sessionId)
    const reloadMs = Date.now() - started
    if (reloadMs > 10_000) throw new Error(`PWA reload took ${reloadMs}ms`)
    await harness.screenshot(actor, 'v2-reloaded-session')
    return { reloadMs, version: 'v2', sessionId, controlled: await actor.page.evaluate(() => Boolean(navigator.serviceWorker.controller)) }
  })

  await harness.step('serve cached shell while browser is offline and recover online', async () => {
    const expectedErrorStart = actor.consoleErrors.length
    await actor.page.setOfflineMode(true)
    await actor.page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await actor.page.waitForSelector('[data-testid="offline-banner"]', { timeout: 15_000 })
    await actor.page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
    await actor.page.waitForFunction(() => document.querySelector('meta[name="runlab-e2e-build"]')?.content === 'v2')
    await actor.page.setOfflineMode(false)
    await actor.page.evaluate(() => window.dispatchEvent(new Event('online')))
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForFunction((expected) => new URL(location.href).searchParams.get('sessionId') === expected, {}, sessionId)
    const offlineErrors = actor.consoleErrors.slice(expectedErrorStart)
    if (offlineErrors.some((message) => !message.includes('ERR_INTERNET_DISCONNECTED'))) throw new Error(`unexpected offline console error: ${offlineErrors.join(' | ')}`)
    actor.consoleErrors.splice(expectedErrorStart)
    return { offlineShell: true, offlineBanner: true, recovered: true, sessionId, expectedOfflineErrors: offlineErrors.length }
  })
} catch (error) { thrown = error } finally {
  if (actor) await actor.page.setOfflineMode(false).catch(() => {})
  result = await harness.finalize({
    revision: (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true })).stdout.trim(),
    controlledBoundaries: ['v1/v2 use the same production build with distinct SW/version markers to deterministically trigger update'],
    untestedExternalCapabilities: ['physical iOS standalone PWA'], sessionId,
    hostLogTail: hostLogs.slice(-80), executorLogTail: executorLogs.slice(-80),
  })
}
if (!thrown) { try { harness.assertClean(result.report) } catch (error) { thrown = error } }
if (thrown) { console.error(thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown)); console.error(`Evidence: ${result?.evidenceRoot ?? '<unavailable>'}`); process.exit(1) }
console.log(`PASS pwa-update-reload system E2E\nEvidence: ${result.evidenceRoot}`)

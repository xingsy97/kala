#!/usr/bin/env node
// Real isolated Host/Socket.IO + production Dashboard. Native bridge is a v1 fixture,
// NOT an OS-notification/tray substitute; genuine native verification is separate.
// pnpm --dir packages/host exec tsx ../../scripts/dashboard/verify-dashboard-native-bridge.mjs
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { startHostServer } from '../../packages/host/src/server.ts'
import { createConfig } from '../../packages/kernel/src/index.ts'

const root = resolve(import.meta.dirname, '../..')
const evidence = resolve(root, '.artifacts', process.env.NATIVE_BRIDGE_EVIDENCE ?? `desktop-bridge-browser-${Date.now()}`)
await mkdir(evidence, { recursive: true })
const release = JSON.parse(await readFile(resolve(root, 'packages/dashboard/public/downloads/desktop/release.json'), 'utf8'))
const steps = [], errors = [], nativeErrors = [], requests = []
const id = (value) => `[data-testid="${value}"]`
let browser, host, page, calls = 0, seq = 100, metadataMode = 'real'
const result = {}
try {
  await rm(resolve(evidence, 'host-state'), { recursive: true, force: true })
  const http = createServer()
  await new Promise((done) => http.listen(0, '127.0.0.1', done))
  const config = createConfig({ systemPrompt: 'Isolated native Dashboard integration fixture.', tools: [] })
  host = await startHostServer({
    httpServer: http, port: http.address().port, sessionsDir: resolve(evidence, 'host-state'), artifactRootDir: false,
    staticDir: resolve(root, 'packages/dashboard/dist'), copilot: { enabled: false }, defaultConfig: config,
    settings: {
      providers: [], defaultModel: '', hooks: [],
      paths: { claudeSettings: 'fixture', codexConfig: 'fixture', manualModels: 'fixture', hooksConfig: 'fixture', sessionsDir: 'fixture' },
      mcp: { supported: false, note: 'Read-only native bridge fixture' },
    },
    llm: { name: 'no-model-calls', async call() { calls++; throw new Error('This verifier must never send a prompt') } },
  })
  const origin = `http://127.0.0.1:${host.port}`
  result.origin = origin
  const records = []
  for (const [sessionId, label, extra] of [
    ['native-first', 'Private first', {}], ['native-second', 'Private second', {}],
    ['native-fork', 'Private fork', { parentSessionId: 'native-first' }],
    ['native-child', 'Private child', { parentSessionId: 'native-first', parentCallId: 'fixture-agent-call', subAgentStartedAt: '2026-09-15T00:00:00Z' }],
  ]) {
    records.push(await host.store.create({ sessionId, config, ...extra }))
    await host.store.rename(sessionId, label)
  }
  const queues = new Map()
  const change = async (sessionId, status, queued = 0) => {
    const record = records.find((item) => item.sessionId === sessionId)
    record.state = { ...record.state, status, cursor: ++seq }
    queues.set(sessionId, queued)
    host.io.of('/dashboard').to(`session:${sessionId}`).emit('state:changed', { sessionId, state: record.state, cursor: record.state.cursor })
    host.io.of('/dashboard').emit('server:sessions', {
      sessions: records.map((item) => ({
        sessionId: item.sessionId, agentRuntime: 'kernel', createdAt: '2026-09-15T00:00:00Z',
        status: item.state.status, eventCount: seq, label: item.label,
        ...(item.parentSessionId ? { parentSessionId: item.parentSessionId } : {}),
        queuedCount: queues.get(item.sessionId) ?? 0,
      })),
    })
    await sleep(100)
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, userDataDir: resolve(evidence, 'chrome-profile'), args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const makePage = async ({ native = true, bridge = true, version = '0.1.0', earlySession = '' } = {}) => {
    const current = await browser.newPage()
    current.setDefaultTimeout(20_000)
    await current.setViewport({ width: 1440, height: 1000 })
    await current.setBypassServiceWorker(true)
    await current.setRequestInterception(true)
    current.on('request', (request) => {
      requests.push({ method: request.method(), path: new URL(request.url()).pathname })
      if (request.url() === `${origin}/downloads/desktop/release.json` && metadataMode !== 'real') {
        return request.respond({ status: metadataMode === 'missing' ? 404 : 200, contentType: 'application/json', body: metadataMode === 'malformed' ? '{"schemaVersion":2}' : '' })
      }
      return request.continue()
    })
    current.on('pageerror', (error) => errors.push(String(error)))
    current.on('console', (message) => { if (message.type() === 'error' && message.text().includes('Native desktop integration failed:')) nativeErrors.push(message.text()) })
    await current.evaluateOnNewDocument(({ native, bridge, version, earlySession }) => {
      localStorage.setItem('ak-dashboard-language', 'en')
      localStorage.setItem('ak-desktop-notifications-enabled', 'true')
      localStorage.setItem('ak-desktop-notification-details', 'false')
      window.__documentToken = Math.random()
      window.__browserNotificationCount = 0
      window.Notification = class {
        static permission = 'granted'
        static async requestPermission() { return 'granted' }
        constructor() { window.__browserNotificationCount++ }
      }
      if (!native) return
      window.__RUNLAB_DESKTOP__ = true
      if (!bridge) return
      const listeners = new Set()
      window.__nativeFixture = {
        info: { version, focused: true, visible: true, notificationsAvailable: true, trayAvailable: true },
        notifications: [], activities: [], subscriptions: 0, rejectNotifications: false,
        emit(event) {
          if (event.type === 'window-state') Object.assign(this.info, { focused: event.focused, visible: event.visible })
          for (const listener of listeners) listener(event)
        },
      }
      window.__RUNLAB_DESKTOP_BRIDGE__ = Object.freeze({
        version: 1,
        getInfo: async () => ({ ...window.__nativeFixture.info }),
        setActivity: async (activity) => window.__nativeFixture.activities.push({ ...activity }),
        notify: async (notification) => {
          if (window.__nativeFixture.rejectNotifications) throw new Error('Controlled native delivery failure')
          window.__nativeFixture.notifications.push({ ...notification })
        },
        subscribe(listener) {
          window.__nativeFixture.subscriptions++
          listeners.add(listener)
          if (earlySession) { listener({ type: 'open-session', sessionId: earlySession }); earlySession = '' }
          return () => listeners.delete(listener)
        },
      })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedCommand = text } } })
    }, { native, bridge, version, earlySession })
    return current
  }
  page = await makePage({ earlySession: 'native-second' })
  await page.goto(`${origin}/?sessionId=native-first`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.querySelector('[data-testid="session-label"]')?.textContent === 'Private second')
  await page.waitForSelector(id('composer-input'), { visible: true })
  await page.type(id('composer-input'), 'Unsent second draft')
  const documentToken = await page.evaluate(() => window.__documentToken)
  const step = async (name, fn) => {
    await fn(); steps.push(name); console.log(`PASS ${name}`)
    await page.screenshot({ path: resolve(evidence, `${steps.length}.png`) })
  }
  const notificationCount = async () => page.evaluate(() => window.__nativeFixture.notifications.length)
  const waitNotifications = async (count) => page.waitForFunction((expected) => window.__nativeFixture.notifications.length === expected, {}, count)
  const emit = async (event) => page.evaluate((value) => window.__nativeFixture.emit(value), event)
  const closeDialog = async () => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid="dialog-overlay"]'))
  }
  await step('cold-start link survives first subscriber/snapshot and metadata-only update check', async () => {
    assert.equal(await notificationCount(), 0)
    assert.equal(await page.evaluate(() => window.__nativeFixture.subscriptions), 1)
    assert.equal(await page.$(id('app-shell-download-desktop')), null)
    await page.waitForSelector(id('desktop-update-available'))
    assert.equal(requests.filter((request) => request.path.endsWith('.deb')).length, 0)
    assert.equal(requests.filter((request) => request.path.startsWith('/push/')).length, 0)
  })
  await step('real Host status aggregates sessions and user forks, not verified tool subagents', async () => {
    for (const record of records) await change(record.sessionId, 'thinking')
    await page.waitForFunction(() => window.__nativeFixture.activities.at(-1)?.running === 3)
    assert.equal(await notificationCount(), 0)
  })
  await step('background completion notifies generically; focused selected completion is suppressed', async () => {
    await change('native-first', 'done')
    await waitNotifications(1)
    await change('native-second', 'done')
    await sleep(1800)
    assert.equal(await notificationCount(), 1)
    const notification = await page.evaluate(() => window.__nativeFixture.notifications[0])
    assert.equal(notification.sessionId, 'native-first')
    assert(!notification.body.includes('Private'))
    assert.equal(await page.evaluate(() => window.__browserNotificationCount), 0)
  })
  await step('hidden selected session notifies, queued turns wait, genuine child stays silent', async () => {
    await emit({ type: 'window-state', focused: false, visible: false })
    await change('native-second', 'thinking')
    await change('native-second', 'done')
    await waitNotifications(2)
    await change('native-fork', 'done', 1)
    await change('native-child', 'done')
    await sleep(1800)
    assert.equal(await notificationCount(), 2)
    await change('native-fork', 'done', 0)
    await waitNotifications(3)
    assert.deepEqual(await page.evaluate(() => window.__nativeFixture.notifications.map((item) => item.sessionId)), ['native-first', 'native-second', 'native-fork'])
  })
  await step('native session callbacks restore existing per-session drafts without document reload', async () => {
    await emit({ type: 'window-state', focused: true, visible: true })
    await emit({ type: 'open-session', sessionId: 'native-first' })
    await page.waitForFunction(() => document.querySelector('[data-testid="session-label"]')?.textContent === 'Private first')
    await page.type(id('composer-input'), 'Unsent first draft')
    await emit({ type: 'open-session', sessionId: 'native-second' })
    await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value === 'Unsent second draft')
    await emit({ type: 'open-session', sessionId: 'native-first' })
    await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value === 'Unsent first draft')
    assert.equal(await page.evaluate(() => window.__documentToken), documentToken)
  })
  await step('Docs is not viewing selected chat; completion and approval notify until opened', async () => {
    await page.click(id('app-shell-nav-docs'))
    await change('native-first', 'thinking')
    await change('native-first', 'awaiting_approval')
    await waitNotifications(4)
    await change('native-first', 'thinking')
    await change('native-first', 'done')
    await waitNotifications(5)
    assert(page.url().endsWith('#/docs'))
    await emit({ type: 'open-session', sessionId: 'native-first' })
    await page.waitForSelector(id('composer-input'), { visible: true })
    assert.equal(await page.$eval(id('composer-input'), (element) => element.value), 'Unsent first draft')
  })
  await step('native settings reuse preferences, privacy opt-in and visible delivery failure', async () => {
    await page.click(id('app-shell-nav-settings-icon'))
    await page.waitForSelector(id('settings-tab-notifications'))
    await page.click(id('settings-tab-notifications'))
    await page.waitForSelector(id('settings-native-notifications'))
    assert.equal(await page.$(id('settings-push-section')), null)
    await page.click(id('settings-native-notification-details'))
    await page.click(id('settings-dialog-close'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="dialog-overlay"]'))
    await emit({ type: 'window-state', focused: false, visible: false })
    await change('native-first', 'thinking')
    await change('native-first', 'awaiting_approval')
    await waitNotifications(6)
    assert((await page.evaluate(() => window.__nativeFixture.notifications.at(-1).body)).includes('Private first'))
    await page.evaluate(() => { window.__nativeFixture.rejectNotifications = true })
    await change('native-first', 'thinking')
    await change('native-first', 'error')
    await page.waitForFunction(() => document.body.textContent.includes('Controlled native delivery failure'))
    assert.equal(nativeErrors.length, 1)
    await page.evaluate(() => { window.__nativeFixture.rejectNotifications = false })
  })
  await step('update affordance opens existing safe modal and manual check does not download packages', async () => {
    await page.click(id('desktop-update-available'))
    await page.waitForSelector(id('copy-desktop-command'))
    assert((await page.$eval(id('desktop-update-restart'), (element) => element.textContent)).includes('choose Quit from the tray menu'))
    await page.click(id('copy-desktop-command'))
    const command = await page.evaluate(() => window.__copiedCommand)
    assert(command.includes(release.artifact.sha256))
    assert(command.includes('curl --proto'))
    assert(command.includes('apt install -y'))
    assert(!command.includes('apt remove'))
    assert((await page.$eval('[role="note"]', (element) => element.textContent)).includes('Unsigned'))
    await closeDialog()
    await page.click(id('app-shell-nav-settings-icon'))
    await page.waitForSelector(id('settings-tab-connection'))
    await page.click(id('settings-tab-connection'))
    await page.waitForSelector(id('desktop-update-settings'))
    assert((await page.$eval(id('desktop-update-settings'), (element) => element.textContent)).includes('Installed version: 0.1.0'))
    await page.click(id('desktop-check-update'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-check-update"]')?.disabled)
    assert.equal(requests.filter((request) => request.path.endsWith('.deb') && request.method === 'GET').length, 0)
    await page.click(id('settings-dialog-close'))
  })
  await step('same/newer native versions, missing metadata, ordinary browsers and legacy clients stay safe', async () => {
    for (const version of [release.version.replace('~', '-'), '99.0.0']) {
      const same = await makePage({ version })
      await same.goto(origin, { waitUntil: 'networkidle2' })
      assert.equal(await same.$(id('desktop-update-available')), null)
      await same.close()
    }
    for (metadataMode of ['malformed', 'missing']) {
      const invalid = await makePage()
      await invalid.goto(origin, { waitUntil: 'networkidle2' })
      assert.equal(await invalid.$(id('desktop-update-available')), null)
      await invalid.close()
    }
    metadataMode = 'real'
    const ordinary = await makePage({ native: false })
    await ordinary.goto(origin, { waitUntil: 'networkidle2' })
    await ordinary.waitForSelector(id('app-shell-download-desktop'))
    assert.equal(await ordinary.$(id('desktop-update-available')), null)
    await ordinary.close()
    const old = await makePage({ bridge: false })
    await old.goto(origin, { waitUntil: 'networkidle2' })
    await old.waitForSelector(id('composer-input'))
    assert.equal(await old.$(id('app-shell-download-desktop')), null)
    assert.equal(await old.$(id('desktop-update-available')), null)
    await old.close()
  })
  assert.equal(calls, 0)
  assert.deepEqual(errors, [])
  result.ok = true
  result.notifications = await page.evaluate(() => window.__nativeFixture.notifications)
  result.lastActivity = await page.evaluate(() => window.__nativeFixture.activities.at(-1))
} catch (error) {
  result.error = String(error.stack ?? error)
  console.error(result.error)
  await page?.screenshot({ path: resolve(evidence, 'failure.png') })
  process.exitCode = 1
} finally {
  await browser?.close()
  await host?.close()
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ ...result, nativeBridge: 'v1 fixture, not actual OS integration', steps, errors, nativeErrors, modelCalls: calls }, null, 2))
  await rm(resolve(evidence, 'chrome-profile'), { recursive: true, force: true })
  await rm(resolve(evidence, 'push-vapid.json'), { force: true })
  if (result.ok) await rm(resolve(evidence, 'failure.png'), { force: true })
}

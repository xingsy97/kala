#!/usr/bin/env node
// pnpm --dir packages/host exec tsx ../../scripts/dashboard/verify-dashboard-contextual-help.mjs
// Production App + real Host; no model calls or user-data/settings mutations.
// HELP_ORIGIN switches to read-only smoke verification of a deployed Dashboard.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { io } from 'socket.io-client'
import { startHostServer } from '../../packages/host/src/server.ts'
import { createConfig, createInitialState } from '../../packages/kernel/src/index.ts'
import { PROTOCOL_VERSION } from '../../packages/shared/src/index.ts'

const root = resolve(import.meta.dirname, '../..')
const evidence = resolve(root, '.artifacts', process.env.HELP_EVIDENCE_NAME ?? `contextual-help-${Date.now()}`)
await mkdir(evidence, { recursive: true })
const steps = [], errors = [], mutations = []
const id = (value) => `[data-testid="${value}"]`
let host, executor, browser
let failConnectionTest = false
let origin = process.env.HELP_ORIGIN
try {
  if (!origin) {
    const http = createServer()
    await new Promise((done) => http.listen(0, '127.0.0.1', done))
    const config = createConfig({ systemPrompt: 'Read-only contextual help fixture.', tools: [] })
    host = await startHostServer({
      httpServer: http, port: http.address().port, sessionsDir: resolve(evidence, 'host-state'), artifactRootDir: false,
      staticDir: resolve(root, 'packages/dashboard/dist'), copilot: { enabled: false }, defaultConfig: config,
      settings: { providers: [], defaultModel: '', hooks: [], paths: { claudeSettings: 'fixture', codexConfig: 'fixture', manualModels: 'fixture', hooksConfig: 'fixture', sessionsDir: 'fixture' }, mcp: { supported: false, note: 'Fixture does not support MCP.' } },
      llm: { name: 'no-calls', async call() { throw new Error('Help navigation must never call a model') } },
    })
    origin = `http://127.0.0.1:${host.port}`
    await host.store.create({ sessionId: 'help-session', config, workspaceId: 'help-workspace', workspaceName: 'Help fixture', initialState: createInitialState({ sessionId: 'help-session' }) })
    executor = io(`${origin}/executor`, { transports: ['websocket'], auth: { role: 'executor', clientVersion: PROTOCOL_VERSION }, reconnection: false })
    executor.on('executor:health_ping', (_sentAt, ack) => ack(Date.now()))
    executor.on('tool:call', (payload, ack) => {
      const result = payload.name === '__fs_list_dirs'
        ? { requestId: payload.input.requestId, workspaceId: payload.input.workspaceId, path: root, roots: [root], entries: [] }
        : { requestId: payload.input.requestId, tasks: [], files: [], stdout: '', stderr: '', exitCode: 0, durationMs: 0 }
      ack({ callId: payload.callId, ok: true, content: JSON.stringify(result) })
    })
    await new Promise((done) => executor.once('connect', done))
    executor.emit('executor:announce', { executorId: 'help-executor', workspaceId: 'help-workspace', workspaceName: 'Help fixture', tools: [], sandboxRoots: [root], runtime: 'node', runtimeVersion: '22' })
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, userDataDir: resolve(evidence, 'chrome-profile'), args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  await page.setBypassServiceWorker(true)
  await page.setRequestInterception(true)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('request', async (request) => {
    if (failConnectionTest && request.url() === `${origin}/models`) {
      failConnectionTest = false
      await request.respond({ status: 503, contentType: 'application/json', body: '{"error":"Controlled read-only probe failure"}' })
      return
    }
    if (request.url().startsWith(origin) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !request.url().includes('/socket.io/')) {
      const path = new URL(request.url()).pathname
      // Navigation normally syncs tab preferences/presence; keep these local in
      // the verifier so live read-only checks cannot alter a user's saved tabs.
      if (['/user/session-tabs', '/push/activity'].includes(path)) {
        await request.respond({ status: 204 })
        return
      }
      mutations.push(`${request.method()} ${path}`)
      await request.abort()
      return
    }
    await request.continue()
  })
  await page.evaluateOnNewDocument(() => { localStorage.setItem('i18nextLng', 'en'); localStorage.setItem('ak-explorer-open', 'true') })
  const visibleHelp = async (label, within = '') => {
    const handles = await page.$$(`${within} button[aria-label=${JSON.stringify(`About ${label}`)}]`)
    for (const handle of handles) if (await handle.isVisible()) return handle
    throw new Error(`No visible help: ${label}`)
  }
  const noHelp = async () => assert.equal(await page.$('[role="tooltip"]'), null)
  const verifyPopup = async (text) => {
    await page.waitForSelector('[role="tooltip"]', { visible: true })
    const result = await page.$eval('[role="tooltip"]', (element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return { text: element.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, topLayer: element.matches(':popover-open'), overflow: style.overflowY, hit: element.contains(document.elementFromPoint(rect.left + 8, rect.top + 8)), count: document.querySelectorAll('[role="tooltip"]').length }
    })
    assert(result.text.includes(text), `Missing help ${text}: ${result.text}`)
    assert.equal(result.count, 1)
    assert.equal(result.topLayer, true)
    assert.equal(result.hit, true, 'popup not obscured by dialog clipping')
    assert(result.left >= 11 && result.right <= result.width - 11, JSON.stringify(result))
    assert(result.top >= 11 && result.bottom <= result.height - 11, JSON.stringify(result))
    assert.equal(result.overflow, 'auto')
  }
  const dismiss = async () => { await page.keyboard.press('Escape'); await noHelp() }
  const step = async (name, fn) => { await fn(); steps.push(name); console.log(`PASS ${name}`) }
  const settings = async () => {
    await page.click(id('app-shell-nav-settings-icon'))
    await page.waitForSelector(id('settings-dialog'), { visible: true })
    await page.waitForSelector(id('settings-connection-endpoint'), { visible: true })
    await sleep(400)
    await noHelp()
  }
  const section = async (key, width) => {
    if (width < 768) await page.select(id('settings-mobile-section-select'), key)
    else await page.click(id(`settings-tab-${key}`))
    await sleep(200)
    await noHelp()
  }
  let healthSession = host ? 'help-session' : null
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000, isMobile: width === 390, hasTouch: width === 390 })
    await page.goto(origin, { waitUntil: 'networkidle2' })
    await page.waitForSelector(id('simple-chat-draft'), { visible: true })
    await step(`${width}px draft hides help and supports pin/outside/Escape`, async () => {
      await noHelp()
      const trigger = await page.$(`${id('simple-chat-draft')} h1 button`)
      assert.equal(Math.round((await trigger.boundingBox()).width), width < 768 ? 32 : 24)
      assert.equal(await trigger.$eval('svg', (element) => element.getBoundingClientRect().width), 14)
      if (width < 768) await trigger.tap()
      else await trigger.click()
      await verifyPopup('Your chat is saved only')
      await page.mouse.move(5, 5)
      await sleep(250)
      await verifyPopup('Your chat is saved only')
      await dismiss()
      if (width < 768) {
        await trigger.tap()
        await verifyPopup('Your chat is saved only')
        await trigger.tap()
        await noHelp()
      }
      await trigger.click()
      await page.click(id('composer-input'))
      await noHelp()
    })
    healthSession ??= await page.$$eval('[data-testid="session-row"]', (rows) => rows[0]?.getAttribute('data-session-id') ?? null)
    if (healthSession) await step(`${width}px compact connection health uses shared help without another transport row`, async () => {
      await page.goto(`${origin}/?sessionId=${encodeURIComponent(healthSession)}`, { waitUntil: 'networkidle2' })
      await page.waitForSelector(id('connection-status'), { visible: true })
      await page.click(id('connection-status'))
      await page.waitForSelector(id('connection-status-popover'), { visible: true })
      assert.equal((await page.$$(id('connection-transport-row'))).length, 1)
      await page.click(id('connection-health-help'))
      await verifyPopup('Reachability and round-trip latency')
      await dismiss()
      assert(await page.$(id('connection-status-popover')))
      await page.click(id('connection-status'))
      await page.goto(origin, { waitUntil: 'networkidle2' })
    })
    await settings()
    await step(`${width}px connection help retains priority and nested Escape does not close Settings`, async () => {
      const trigger = await visibleHelp(width < 768 ? 'Connection' : 'Service endpoint', id('settings-dialog'))
      await trigger.click()
      await verifyPopup('Priority:')
      await dismiss()
      assert(await page.$(id('settings-dialog')))
      await (await visibleHelp('Override host endpoint')).click()
      await verifyPopup('AGENT_KERNEL_ALLOWED_ORIGINS')
      await dismiss()
      assert.equal(await page.$eval(id('settings-connection-endpoint'), (element) => element.value), '')
    })
    await step(`${width}px cross-origin requirements and failed probe remain visible`, async () => {
      await page.type(id('settings-connection-endpoint'), 'https://help.invalid')
      assert(await page.$eval('[data-description-kind="notice"]', (element) => element.innerText.includes('AGENT_KERNEL_ALLOWED_ORIGINS')))
      await page.click(id('settings-connection-endpoint'))
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace')
      assert.equal(await page.$('[data-description-kind="notice"]'), null)
      failConnectionTest = true
      await page.click(id('settings-connection-test'))
      await page.waitForSelector(`${id('settings-connection-result')}[role="alert"]`, { visible: true })
      assert(await page.$eval(id('settings-connection-result'), (element) => element.innerText.includes('HTTP 503')))
    })
    if (width === 1440) {
      await step('desktop delayed hover, popup crossing, leave and keyboard focus', async () => {
        const trigger = await visibleHelp('Service endpoint', id('settings-dialog'))
        await trigger.hover()
        await sleep(150)
        await noHelp()
        await sleep(210)
        await verifyPopup('Priority:')
        const box = await (await page.$('[role="tooltip"]')).boundingBox()
        await page.mouse.move(box.x + 10, box.y + 10)
        await sleep(250)
        await verifyPopup('Priority:')
        await page.mouse.move(5, 5)
        await sleep(200)
        await noHelp()
        await page.$eval(id('settings-connection-endpoint'), (element) => element.focus())
        await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift')
        await verifyPopup('AGENT_KERNEL_ALLOWED_ORIGINS')
        await page.keyboard.press('Enter')
        await page.mouse.move(5, 5)
        await verifyPopup('AGENT_KERNEL_ALLOWED_ORIGINS')
        await dismiss()
        await page.keyboard.press('Space')
        await verifyPopup('AGENT_KERNEL_ALLOWED_ORIGINS')
        await dismiss()
      })
    }
    await section('interface', width)
    if (width === 1440) {
      await step('keyboard tab scrolls an offscreen help trigger into view without dismissing its explanation', async () => {
        const prepared = await page.$eval(id('settings-dialog'), (dialog) => {
          const trigger = dialog.querySelector('button[aria-label="About Tool activity icon size"]')
          assertElement(trigger)
          const viewport = trigger.closest('[data-radix-scroll-area-viewport]')
          assertElement(viewport)
          viewport.scrollTop = 0
          const focusable = [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')]
            .filter((element) => element.checkVisibility() && !element.disabled)
          const before = focusable[focusable.indexOf(trigger) - 1]
          assertElement(before)
          before.focus({ preventScroll: true })
          return { belowViewport: trigger.getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom }
          function assertElement(element) { if (!element) throw new Error('Missing keyboard scroll fixture element') }
        })
        assert(prepared.belowViewport)
        await page.keyboard.press('Tab')
        await verifyPopup('Default: 150%')
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'About Tool activity icon size')
        await dismiss()
        await page.$eval(id('settings-responsive-content'), (element) => { element.closest('[data-radix-scroll-area-viewport]').scrollTop = 0 })
        await sleep(100)
      })
    }
    await step(`${width}px Interface explanations remain reachable without nested controls or overflow`, async () => {
      await (await visibleHelp('Language')).click()
      await verifyPopup('language')
      if (width < 768) await dismiss()
      await (await visibleHelp('Theme')).click()
      await verifyPopup('color scheme')
      await dismiss()
      await (await visibleHelp('VS Code theme')).click()
      await verifyPopup('Open VSX')
      await dismiss()
      await page.screenshot({ path: resolve(evidence, `interface-${width}.png`) })
      const geometry = await page.$eval(id('settings-responsive-content'), (element) => ({ width: element.clientWidth, scroll: element.scrollWidth }))
      assert(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry))
      assert.equal(await page.$('button button, label button'), null)
      await (await visibleHelp('Language')).click()
      await section('notifications', width)
      await noHelp()
    })
    await step(`${width}px Notifications grouped help and visible permissions`, async () => {
      await (await visibleHelp('Notify me about')).click()
      await verifyPopup('A tool call is waiting for approve/reject.')
      await verifyPopup('The active session needs an Executor')
      await dismiss()
      assert(await page.$(id('desktop-notification-permission')))
      await (await visibleHelp('System notifications')).click()
      await verifyPopup('background or closed')
      await dismiss()
    })
    if (width < 768) {
      await step('mobile long help scrolls in the top layer; resize and anchor scroll close safely', async () => {
        await page.setViewport({ width, height: 360, isMobile: true, hasTouch: true })
        await (await visibleHelp('Notify me about')).click()
        await verifyPopup('Workspace offline')
        const popup = await page.$('[role="tooltip"]')
        const box = await popup.boundingBox()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel({ deltaY: 400 })
        await sleep(250)
        assert(await page.$eval('[role="tooltip"]', (element) => element.scrollTop > 0))
        await verifyPopup('Workspace offline')
        await page.screenshot({ path: resolve(evidence, 'mobile-scrollable-help.png') })
        await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true })
        await page.waitForSelector('[role="tooltip"]', { hidden: true })
        await noHelp()
        await section('interface', width)
        await (await visibleHelp('Language')).click()
        await page.$eval(id('settings-responsive-content'), (element) => element.closest('[data-radix-scroll-area-viewport]').scrollTop += 80)
        await sleep(200)
        await noHelp()
      })
    }
    await section('approvals', width)
    await step(`${width}px dangerous approvals stay visible`, async () => {
      assert(await page.evaluate(() => [...document.querySelectorAll('[data-description-kind="notice"]')].some((node) => node.checkVisibility() && node.textContent.includes('global'))))
      assert(await page.evaluate(() => document.body.innerText.includes('AK_ALLOW_ALL_OK=1')))
    })
    await section('deployment', width)
    await step(`${width}px deployment keeps live data while hiding explanatory paragraphs`, async () => {
      await (await visibleHelp('Deployment', id('settings-dialog'))).click()
      await verifyPopup('independently deployed Dashboard')
      await dismiss()
      await (await visibleHelp('Connected workspaces and executors')).click()
      await verifyPopup('currently attached for a workspace')
      await dismiss()
      if (!host) {
        await page.waitForSelector(id('settings-dedicated-deployment'), { visible: true })
        await (await page.$(`${id('settings-dedicated-deployment')} h4 button`)).click()
        await verifyPopup('Runtime cutover')
        await dismiss()
      }
      assert(await page.$(id('settings-deployment-overview')))
    })
    await page.click(id('settings-dialog-close'))
    await page.waitForSelector(id('settings-dialog'), { hidden: true })
    await sleep(250)
    if (host) {
      await step(`${width}px workspace and session info dialogs preserve hidden descriptions`, async () => {
        const newButton = id('workspace-new-session-help-workspace')
        if (!await (await page.$(newButton))?.isVisible()) await page.click(id('explorer-toggle'))
        await page.waitForSelector(newButton, { visible: true })
        await sleep(350)
        if (width < 768) {
          await (await page.$(`${id('explorer-drawer')} h2 button`)).tap()
          await verifyPopup('Workspace and session')
          await dismiss()
        }
        await page.click(newButton)
        await page.waitForSelector(id('new-session-dialog'), { visible: true })
        await sleep(350)
        await noHelp()
        await (await page.$(`${id('new-session-dialog')} h2 button`)).click()
        await verifyPopup('workspace')
        await dismiss()
        await (await page.$('#new-session-runtime-label button')).click()
        await verifyPopup('Agent Kernel')
        await dismiss()
        assert(await page.$eval(id('new-session-runtime-copilot'), (element) => element.disabled && element.innerText.trim().split('\n').length > 1))
        await page.click(id('new-session-close'))
        await page.waitForSelector(id('new-session-dialog'), { hidden: true })
        await sleep(250)
        if (!await (await page.$(id('workspace-info-help-workspace')))?.isVisible()) await page.click(id('explorer-toggle'))
        await page.waitForSelector(id('workspace-info-help-workspace'), { visible: true })
        await sleep(250)
        await page.click(id('workspace-info-help-workspace'))
        await page.waitForSelector(id('workspace-metadata-dialog'), { visible: true })
        await (await page.$(`${id('workspace-metadata-dialog')} h2 button`)).click()
        await verifyPopup('Workspace identity')
        await dismiss()
        await page.keyboard.press('Escape')
        await page.waitForSelector(id('workspace-metadata-dialog'), { hidden: true })
        await page.goto(`${origin}/?sessionId=help-session`, { waitUntil: 'networkidle2' })
        await page.click(id('session-title'))
        await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control')
        await page.waitForSelector(id('command-palette-search'), { visible: true })
        await page.type(id('command-palette-search'), 'Session info')
        await page.click(id('command-palette-item-session.info'))
        await page.waitForSelector(id('session-metadata-dialog'), { visible: true })
        await (await page.$(`${id('session-metadata-dialog')} h2 button`)).click()
        await verifyPopup('Save')
        await dismiss()
        await page.keyboard.press('Escape')
        await page.waitForSelector(id('session-metadata-dialog'), { hidden: true })
        await sleep(350)
        if (width < 768) {
          await page.click(id('sidebar-toggle'))
          await page.waitForSelector(id('inspector-drawer-mobile'), { visible: true })
          await sleep(350)
          await (await page.$(`${id('inspector-drawer-mobile')} button[aria-label^="About "]`)).tap()
          await verifyPopup('Session state')
          await dismiss()
          await page.keyboard.press('Escape')
        }
      })
    }
    await step(`${width}px Docs title help preserves page content and closes on route change`, async () => {
      await page.goto(`${origin}/#/docs`, { waitUntil: 'networkidle2' })
      await page.waitForSelector(id('docs-page-title'), { visible: true })
      await (await page.$(`${id('docs-page-title')} button`)).click()
      await verifyPopup('repository docs')
      await page.goto(origin, { waitUntil: 'networkidle2' })
      await noHelp()
    })
    await page.screenshot({ path: resolve(evidence, `${width}.png`) })
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(mutations, [])
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify({ origin, steps, errors, mutations }, null, 2))
  console.log(`PASS ${steps.length} read-only browser steps; evidence ${evidence}`)
} catch (error) {
  const failedPage = (await browser?.pages())?.at(-1)
  if (failedPage) {
    await failedPage.screenshot({ path: resolve(evidence, 'failure.png') })
    await writeFile(resolve(evidence, 'failure-body.txt'), await failedPage.evaluate(() => document.body.innerText))
  }
  await writeFile(resolve(evidence, 'failure.json'), JSON.stringify({ steps, errors, mutations, failure: String(error) }, null, 2))
  throw error
} finally {
  await browser?.close()
  executor?.disconnect()
  await host?.close()
}

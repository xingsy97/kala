#!/usr/bin/env node
// pnpm --dir packages/host exec tsx ../../scripts/dashboard/verify-dashboard-hover-preview.mjs
// Production Explorer, real Socket.IO previews and Chromium mouse events;
// all sessions belong to this disposable, loopback-only Host.
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { startHostServer } from '../../packages/host/src/server.ts'
import { createConfig, createInitialState } from '../../packages/kernel/src/index.ts'

const root = resolve(import.meta.dirname, '../..')
const evidence = resolve(root, '.artifacts', process.env.HOVER_EVIDENCE_NAME ?? 'hover-preview-browser')
await mkdir(evidence, { recursive: true })
const stateRoot = resolve(evidence, 'host-state')
await mkdir(stateRoot, { recursive: true })
const steps = [], errors = []
let host, browser, page
try {
  const http = createServer()
  await new Promise((done) => http.listen(0, '127.0.0.1', done))
  const config = createConfig({ systemPrompt: 'Hover fixture.', tools: [] })
  host = await startHostServer({
    httpServer: http, port: http.address().port, sessionsDir: stateRoot, artifactRootDir: false,
    staticDir: process.env.HOVER_DASHBOARD_DIST ?? resolve(root, 'packages/dashboard/dist'),
    defaultConfig: config,
    llm: { name: 'unused-hover-fixture', async call() { throw new Error('Hover must not invoke a model') } },
  })
  for (const sessionId of [...Array.from({ length: 45 }, (_, i) => `hover-filler-${i}`), 'hover-selected', 'hover-alpha', 'hover-beta']) {
    await host.store.create({ sessionId, config, initialState: { ...createInitialState({ sessionId }), status: 'done', messages: [
      { role: 'user', content: [{ type: 'text', text: `Request ${sessionId}` }] },
      { role: 'assistant', content: [{ type: 'text', text: `Answer ${sessionId}` }] },
    ] } })
  }
  const origin = `http://127.0.0.1:${host.port}`
  host.io.of('/dashboard').on('connection', (socket) => {
    console.log('CONNECTED', socket.id)
    socket.onAny((name, payload) => console.log('WIRE', name, JSON.stringify(payload)))
  })
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true,
    userDataDir: resolve(evidence, 'chrome-profile'),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'],
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') console.log('BROWSER', message.text()) })
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('i18nextLng', 'en')
    window.hoverEvidence = []
    for (const name of ['pointerover', 'pointerout']) document.addEventListener(name, (event) => {
      const row = event.target.closest?.('[data-testid="session-row"]')
      const preview = event.target.closest?.('[data-testid="session-hover-preview"]')
      if (row || preview) window.hoverEvidence.push({ name, row: row?.dataset.sessionId, preview: !!preview })
    }, true)
  })
  await page.goto(`${origin}/?sessionId=hover-selected`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="composer-input"]')
  console.log('POINTER', await page.evaluate(() => ({ fine: matchMedia('(hover: hover) and (pointer: fine)').matches, url: location.href })))
  const selector = (id) => `[data-testid="session-row"][data-session-id="${id}"]`
  // Populate the normal full-session cache before testing a previously loaded
  // session's hover-to-click transition.
  await page.click(selector('hover-alpha'))
  await page.waitForFunction(() => [...document.querySelectorAll('.ak-chat-container')].some((element) => element.textContent.includes('Answer hover-alpha')))
  await page.click(selector('hover-selected'))
  await page.waitForFunction(() => [...document.querySelectorAll('.ak-chat-container')].some((element) => element.textContent.includes('Answer hover-selected')))
  await page.mouse.move(1300, 850)
  const hover = async (id = 'hover-alpha') => {
    const row = await page.waitForSelector(selector(id))
    const box = await row.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForSelector('[data-testid="session-hover-preview"]')
  }
  const leave = () => page.mouse.move(1300, 850)
  const hidden = () => page.waitForSelector('[data-testid="session-hover-preview"]', { hidden: true })
  const noPreviewRooms = async (selected = 'hover-selected') => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rooms = [...host.io.of('/dashboard').sockets.values()].flatMap((socket) => [...socket.rooms])
        .filter((room) => room.startsWith('session:') && room !== `session:${selected}`)
      if (!rooms.length) return
      await sleep(20)
    }
    assert.fail('Preview session subscription leaked after dismissal')
  }
  const step = async (name, run) => {
    try {
      await run()
      await noPreviewRooms(name.startsWith('single click') ? 'hover-alpha' : 'hover-selected')
      steps.push({ name, pass: true })
      console.log(`PASS ${name}`)
    } catch (error) {
      if (!process.env.HOVER_BASELINE) throw error
      steps.push({ name, pass: false, error: String(error) })
      console.log(`BASELINE FAILURE ${name}: ${error}`)
      await page.screenshot({ path: resolve(evidence, `failure-${steps.length}.png`) })
      await writeFile(resolve(evidence, `failure-${steps.length}-pointer-events.json`), JSON.stringify(await page.evaluate(() => ({
        events: window.hoverEvidence,
        originalRowConnected: window.hoverOriginalRow?.isConnected,
        previewVisible: !!document.querySelector('[data-testid="session-hover-preview"]'),
      })), null, 2))
      await page.goto(`${origin}/?sessionId=hover-selected`, { waitUntil: 'networkidle2' })
    }
  }
  await step('row leave dismisses even when opening replaced the hovered row', async () => {
    await page.evaluate((sel) => { window.hoverOriginalRow = document.querySelector(sel) }, selector('hover-alpha'))
    await hover()
    const replaced = await page.evaluate(() => !window.hoverOriginalRow.isConnected)
    console.log(`Opening preview replaced original row: ${replaced}`)
    steps.push({ name: 'original row disconnected on opening', observed: replaced })
    await page.screenshot({ path: resolve(evidence, 'opened.png') })
    await leave()
    await hidden()
  })
  await step('row to interactive preview crossing and preview leave', async () => {
    await hover()
    const box = await (await page.$('[data-testid="session-hover-preview"]')).boundingBox()
    await page.mouse.move(box.x + 30, box.y + 40, { steps: 3 })
    await sleep(200)
    assert(await page.$('[data-testid="session-hover-preview"]'))
    await page.mouse.click(box.x + 40, box.y + 45)
    assert(await page.$('[data-testid="session-hover-preview"]'))
    const session = host.store.get('hover-alpha')
    session.state = { ...session.state, messages: [...session.state.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'Live hover update.' }] },
    ] }
    host.io.of('/dashboard').to('session:hover-alpha').emit('state:changed', { sessionId: session.sessionId, state: session.state, cursor: session.state.cursor })
    await page.waitForFunction(() => document.querySelector('[data-testid="session-hover-preview"]')?.textContent.includes('Live hover update.'))
    await leave()
    await hidden()
  })
  await step('quick reentry cancels close and switching rows does not latch', async () => {
    await hover()
    await leave()
    await hover()
    await sleep(160)
    assert(await page.$('[data-testid="session-hover-preview"]'))
    await hover('hover-beta')
    await page.waitForFunction(() => document.querySelector('[data-testid="session-hover-preview"]')?.textContent.includes('Answer hover-beta'))
    await leave()
    await hidden()
  })
  await step('window blur dismisses the interactive portal', async () => {
    await hover()
    const box = await (await page.$('[data-testid="session-hover-preview"]')).boundingBox()
    await page.mouse.move(box.x + 30, box.y + 40)
    const otherTab = await browser.newPage()
    try {
      await otherTab.bringToFront()
      await hidden()
    } finally {
      await otherTab.close()
      await page.bringToFront()
    }
    await leave()
  })
  await step('filtering out the hovered row dismisses without a native leave', async () => {
    await hover()
    await page.evaluate((sel) => {
      window.hoverOriginalRow = document.querySelector(sel)
      window.hoverEvidence = []
    }, selector('hover-alpha'))
    await page.focus('[data-testid="explorer-search"]')
    await page.keyboard.type('no-such-hover-session')
    await hidden()
    await page.keyboard.down('Control')
    await page.keyboard.press('A')
    await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await leave()
  })
  await step('real tree wheel scroll dismisses and virtualized removal does not latch', async () => {
    await hover()
    await page.mouse.wheel({ deltaY: 1800 })
    await hidden()
    await sleep(150)
    assert.equal(await page.$(selector('hover-alpha')), null)
    await page.mouse.wheel({ deltaY: -3000 })
    await sleep(200)
    await leave()
  })
  await step('single click switches a previously previewed session', async () => {
    await hover()
    await page.click(selector('hover-alpha'))
    await page.waitForSelector(`${selector('hover-alpha')}[data-selected="true"]`)
    await hidden()
    await page.waitForFunction(() => [...document.querySelectorAll('.ak-chat-container')].some((element) => element.textContent.includes('Answer hover-alpha')))
  })
  assert.deepEqual(errors, [])
} catch (error) {
  steps.push({ name: 'failure', pass: false, error: error.stack ?? String(error) })
  process.exitCode = 1
  console.error(error)
} finally {
  if (page && !page.isClosed()) {
    await writeFile(resolve(evidence, 'pointer-events.json'), JSON.stringify(await page.evaluate(() => window.hoverEvidence), null, 2))
    await page.screenshot({ path: resolve(evidence, 'final.png') })
    await writeFile(resolve(evidence, 'final-dom.txt'), await page.evaluate(() => document.body.innerText))
  }
  await browser?.close()
  await host?.close()
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify({ steps, errors, generatedAt: new Date().toISOString() }, null, 2))
  await rm(stateRoot, { recursive: true, force: true })
  await rm(resolve(evidence, 'chrome-profile'), { recursive: true, force: true })
}

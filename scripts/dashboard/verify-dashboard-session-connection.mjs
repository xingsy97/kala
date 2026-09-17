#!/usr/bin/env node
// pnpm --dir packages/host exec tsx ../../scripts/dashboard/verify-dashboard-session-connection.mjs
// Isolated sessions only. Native bridge profiling exercises Dashboard behavior,
// not GTK/WebKit CPU usage. CONNECTION_BASELINE=1 records the pre-fix failure.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { startHostServer } from '../../packages/host/src/server.ts'
import { createConfig, createInitialState } from '../../packages/kernel/src/index.ts'

const root = resolve(import.meta.dirname, '../..')
const evidence = resolve(root, '.artifacts', process.env.CONNECTION_EVIDENCE ?? `session-connection-${Date.now()}`)
await mkdir(evidence, { recursive: true })
const wire = [], samples = [], errors = []
let host, browser
const profileMs = Number(process.env.CONNECTION_PROFILE_MS ?? 8000)
assert(Number.isFinite(profileMs) && profileMs > 0, 'CONNECTION_PROFILE_MS must be a positive number')
const processTicks = async (pid) => {
  const results = new Map()
  const visit = async (id) => {
    try {
      const text = await readFile(`/proc/${id}/stat`, 'utf8')
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
      results.set(id, Number(fields[11]) + Number(fields[12]))
      const children = await readFile(`/proc/${id}/task/${id}/children`, 'utf8')
      await Promise.all(children.trim().split(/\s+/).filter(Boolean).map(visit))
    } catch (error) {
      // Browser subprocesses can exit between samples; other failures invalidate the measurement.
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error
    }
  }
  await visit(String(pid))
  return results
}
try {
  const http = createServer()
  await new Promise(r => http.listen(0, '127.0.0.1', r))
  const config = createConfig({ systemPrompt: 'Connection-only fixture', tools: [] })
  host = await startHostServer({
    httpServer: http, port: http.address().port, sessionsDir: resolve(evidence, 'host-state'),
    artifactRootDir: false, staticDir: process.env.CONNECTION_DASHBOARD_DIST ?? resolve(root, 'packages/dashboard/dist'),
    copilot: { enabled: false }, defaultConfig: config,
    llm: { name: 'unused-connection-fixture', async call() { throw new Error('Must not invoke a model') } },
  })
  for (const agentRuntime of ['kernel', 'copilot']) {
    for (const suffix of ['a', 'b']) {
      const sessionId = `connection-${agentRuntime}-${suffix}`
      await host.store.create({ sessionId, config, agentRuntime, initialState: {
        ...createInitialState({ sessionId }), status: 'done',
        messages: [{ role: 'user', content: [{ type: 'text', text: sessionId }] },
          { role: 'assistant', content: [{ type: 'text', text: `Answer ${sessionId}` }] }],
      } })
    }
  }
  host.io.of('/dashboard').on('connection', socket => {
    socket.onAny((name, payload) => {
      if (name.includes('subscribe') || name.includes('history') || name.includes('ping')) wire.push({ direction: 'client', name, payload })
    })
    socket.onAnyOutgoing((name, payload) => {
      if (name === 'session:ready') wire.push({ direction: 'server', name, sessionId: payload.sessionId })
    })
  })
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true,
    userDataDir: resolve(evidence, 'chrome-profile'),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport({ width: 1920, height: 1100 })
  page.on('pageerror', error => errors.push(String(error)))
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('i18nextLng', 'en')
    window.__RUNLAB_DESKTOP__ = true
    const listeners = new Set()
    window.__nativeFixture = {
      info: { version: '0.0.0', focused: true, visible: true, notificationsAvailable: true, trayAvailable: true },
      activities: 0, confirmations: 0,
      emit(event) { Object.assign(this.info, event); for (const listener of listeners) listener(event) },
    }
    window.__RUNLAB_DESKTOP_BRIDGE__ = {
      version: 1, getInfo: async () => ({ ...window.__nativeFixture.info }),
      confirmConnection: async () => { window.__nativeFixture.confirmations++ },
      setActivity: async () => { window.__nativeFixture.activities++ }, notify: async () => {},
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    }
    window.__mutationCount = 0
    new MutationObserver(records => { window.__mutationCount += records.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  const cdp = await page.createCDPSession()
  await cdp.send('Performance.enable')
  await cdp.send('Profiler.enable')
  const status = () => page.$eval('[data-testid=connection-status]', e => ({ text: e.textContent, status: e.getAttribute('data-status') }))
  const sample = async (label) => {
    await sleep(300)
    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    const ticks = await processTicks(browser.process().pid)
    const mutations = await page.evaluate(() => window.__mutationCount)
    const wireStart = wire.length
    await cdp.send('Profiler.start')
    await sleep(profileMs)
    const { profile } = await cdp.send('Profiler.stop')
    const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    const afterTicks = await processTicks(browser.process().pid)
    const nodes = new Map(profile.nodes.map(node => [node.id, node]))
    const times = new Map()
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const name = nodes.get(profile.samples[i])?.callFrame.functionName ?? '(anonymous)'
      times.set(name, (times.get(name) ?? 0) + (profile.timeDeltas?.[i] ?? 0))
    }
    const result = {
      label, connection: await status(), visibility: await page.evaluate(() => document.visibilityState),
      profileMs, taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
      layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
      styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
      browserTreeCpuTicks: [...ticks].reduce((sum, [pid, start]) => sum + Math.max(0, (afterTicks.get(pid) ?? start) - start), 0),
      mutations: await page.evaluate(() => window.__mutationCount) - mutations,
      native: await page.evaluate(() => ({ activities: window.__nativeFixture.activities, confirmations: window.__nativeFixture.confirmations })),
      animations: await page.evaluate(() => document.getAnimations().map(animation => ({ name: animation.animationName, target: animation.effect?.target?.className })).slice(0, 20)),
      wireEvents: wire.slice(wireStart).map(event => event.name),
      topSampleMs: [...times].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, us]) => ({ name, ms: us / 1000 })),
    }
    samples.push(result)
    console.log(JSON.stringify(result))
    await writeFile(resolve(evidence, `${label}.cpuprofile`), JSON.stringify(profile))
  }
  for (const runtime of ['kernel', 'copilot']) {
    await page.goto(`http://127.0.0.1:${host.port}/?sessionId=connection-${runtime}-a`)
    await page.waitForSelector('[data-testid=connection-status][data-status=ready]')
    await page.mouse.move(1850, 1000)
    await sample(`${runtime}-ready`)
    const row = `[data-testid=session-row][data-session-id=connection-${runtime}-b]`
    if (!await page.$(row)) await page.click('[data-testid=explorer-toggle]')
    await page.hover(row)
    await page.waitForSelector('[data-testid=session-hover-preview]')
    await sleep(400)
    const beforeClick = wire.length
    await page.click(row)
    await page.mouse.move(1850, 1000)
    if (!process.env.CONNECTION_BASELINE) await page.waitForSelector('[data-testid=connection-status][data-status=ready]')
    await sample(`${runtime}-hover-selected`)
    if (process.env.CONNECTION_BASELINE) {
      await page.evaluate(() => { for (const animation of document.getAnimations()) animation.pause() })
      await sample(`${runtime}-connecting-paused-animations`)
      await page.evaluate(() => { for (const animation of document.getAnimations()) animation.play() })
    }
    if (!process.env.CONNECTION_BASELINE) {
      assert(wire.slice(beforeClick).some(event => event.name === 'session:ready' && event.sessionId === `connection-${runtime}-b`), 'Selection must obtain a new baseline after preview')
      assert.equal((await status()).status, 'ready')
    }
    const other = await browser.newPage()
    await other.bringToFront()
    await page.evaluate(() => window.__nativeFixture.emit({ type: 'window-state', focused: false, visible: false }))
    await sample(`${runtime}-hidden`)
    await other.close()
    await page.bringToFront()
    await page.reload()
    await page.waitForSelector('[data-testid=connection-status][data-status=ready]')
    if (!process.env.CONNECTION_BASELINE) {
      const beforeResync = wire.length
      await page.click('[data-testid=connection-status]')
      await page.evaluate(() => [...document.querySelectorAll('[data-testid=connection-status-popover] button')].find(button => button.textContent === 'Resync')?.click())
      await page.waitForFunction(() => document.querySelector('[data-testid=connection-status]')?.getAttribute('data-status') === 'ready')
      await sleep(100)
      assert(wire.slice(beforeResync).some(event => event.name === 'session:ready'), 'Resync must request a baseline, not only history')
      const beforeReconnect = wire.length
      for (const socket of host.io.of('/dashboard').sockets.values()) socket.conn.close()
      await page.waitForSelector('[data-testid=connection-status][data-status=disconnected]')
      await page.waitForSelector('[data-testid=connection-status][data-status=ready]')
      assert(wire.slice(beforeReconnect).some(event => event.name === 'session:ready'), 'Reconnect must restore the current selection')
    }
  }
  assert.deepEqual(errors, [])
} finally {
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ samples, wire, errors }, null, 2))
  await browser?.close()
  await host?.close()
  await rm(resolve(evidence, 'chrome-profile'), { recursive: true, force: true })
  await rm(resolve(evidence, 'host-state'), { recursive: true, force: true })
  await rm(resolve(evidence, 'push-vapid.json'), { force: true })
}

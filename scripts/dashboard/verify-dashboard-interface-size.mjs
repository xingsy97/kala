#!/usr/bin/env node
// Read-only live Host with optional locally built Dashboard assets.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const origin = process.env.SIZE_ORIGIN ?? 'http://127.0.0.1:13000'
const root = resolve(import.meta.dirname, '../..')
const dist = process.env.SIZE_LOCAL_DIST ? resolve(root, 'packages/dashboard/dist') : null
const evidence = resolve(root, '.artifacts', process.env.SIZE_EVIDENCE ?? `interface-size-${Date.now()}`)
await mkdir(evidence, { recursive: true })
const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
const errors = [], mutations = [], results = []
const id = (value) => `[data-testid="${value}"]`
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  await page.setBypassServiceWorker(true)
  await page.setRequestInterception(true)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('request', async (request) => {
    const url = new URL(request.url())
    if (url.origin !== origin) return request.continue()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !url.pathname.startsWith('/socket.io/')) {
      if (['/user/session-tabs', '/push/activity'].includes(url.pathname)) return request.respond({ status: 204 })
      mutations.push(`${request.method()} ${url.pathname}`)
      return request.abort()
    }
    if (dist && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      const path = resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`)
      assert(path.startsWith(`${dist}/`))
      try {
        const bytes = await readFile(path)
        return request.respond({ status: 200, contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] ?? 'application/octet-stream', body: bytes })
      } catch { return request.respond({ status: 404, body: '' }) }
    }
    return request.continue()
  })
  const change = async (selector, value) => {
    await page.$eval(selector, (input, next) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(next))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
    await sleep(120)
  }
  const openSettings = async () => {
    await page.click(id('app-shell-nav-settings-icon'))
    await page.waitForSelector(id('settings-dialog'), { visible: true })
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-responsive-content"]')?.textContent.includes('Service endpoint'))
    const desktop = await page.$eval(id('settings-tab-interface'), (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    if (desktop) await page.click(id('settings-tab-interface'))
    else await page.select(id('settings-mobile-section-select'), 'interface')
    await page.waitForSelector(id('settings-interface-scale'), { visible: true })
  }
  await page.setViewport({ width: 1600, height: 1000 })
  await page.goto(origin, { waitUntil: 'networkidle2' })
  await page.waitForSelector(id('composer-input'), { visible: true })
  await page.waitForSelector(id('session-row'))
  const sessionId = await page.$eval(id('session-row'), (row) => row.getAttribute('data-session-id'))
  assert(sessionId)
  await page.goto(`${origin}/?sessionId=${encodeURIComponent(sessionId)}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.ak-chat-item .ak-chat-text')
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '20px')
  const measure = () => page.$eval(id('app-shell-nav-settings-icon'), (button) => ({
    root: parseFloat(getComputedStyle(document.documentElement).fontSize),
    button: button.getBoundingClientRect().height,
    icon: button.querySelector('svg').getBoundingClientRect().height,
    composer: parseFloat(getComputedStyle(document.querySelector('[data-testid="composer-input"]')).fontSize),
  }))
  const enlarged = await measure()
  await openSettings()
  await change(id('settings-interface-scale'), 100)
  const baseline = await measure()
  for (const key of ['root', 'button', 'icon', 'composer']) assert(Math.abs(enlarged[key] / baseline[key] - 1.25) < 0.03, `${key}: ${JSON.stringify({ enlarged, baseline })}`)
  for (const kind of ['chat', 'file-view', 'session-explorer', 'file-explorer']) {
    await change(id(`settings-${kind}-font-size`), 48)
    assert.equal(await page.$eval(id(`settings-${kind}-font-size`), (input) => input.value), '48')
  }
  assert.equal(await page.$eval('.ak-chat-item .ak-chat-text', (text) => parseFloat(getComputedStyle(text).fontSize)), 48)
  const explorer = await page.$$eval('[data-testid="session-row"] [style*="font-size"]', (labels) => labels.map((label) => ({
    font: parseFloat(getComputedStyle(label).fontSize),
    line: parseFloat(getComputedStyle(label).lineHeight),
    height: label.getBoundingClientRect().height,
  })))
  assert(explorer.length > 0, 'Actual session labels are required for maximum-font layout coverage')
  for (const label of explorer) assert(label.font === 48 && label.line >= 48 && label.height >= 48, JSON.stringify(label))
  await change(id('settings-tool-activity-icon-scale'), 300)
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector(id('composer-input'), { visible: true })
  await openSettings()
  for (const kind of ['chat', 'file-view', 'session-explorer', 'file-explorer']) {
    assert.equal(await page.$eval(id(`settings-${kind}-font-size`), (input) => input.value), '48')
    await page.click(id(`settings-${kind}-font-size-reset`))
  }
  for (const scale of [75, 125, 200]) {
    await change(id('settings-interface-scale'), scale)
    for (const [width, height] of [[1600, 1000], [1024, 700], [640, 360], [390, 844], [320, 480]]) {
      await page.setViewport({ width, height })
      await sleep(180)
      await page.$eval(id('settings-interface-scale'), (element) => element.scrollIntoView({ block: 'center' }))
      const layout = await page.$eval(id('settings-dialog'), (dialog) => {
        const rect = dialog.getBoundingClientRect()
        const input = document.querySelector('[data-testid="settings-interface-scale"]').getBoundingClientRect()
        const reset = document.querySelector('[data-testid="settings-interface-scale-reset"]').getBoundingClientRect()
        const overflowing = [...dialog.querySelectorAll('*')].flatMap((element) => {
          const r = element.getBoundingClientRect()
          return r.width > 1 && (r.left < -1 || r.right > innerWidth + 1)
            ? [{ tag: element.tagName, className: element.getAttribute('class'), left: r.left, right: r.right }] : []
        }).slice(0, 8)
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewport: [innerWidth, innerHeight], input: input.toJSON(), reset: reset.toJSON(), overflowing, overflow: dialog.scrollWidth > dialog.clientWidth, rootOverflow: document.documentElement.scrollWidth > innerWidth }
      })
      assert(layout.left >= -1 && layout.right <= width + 1 && layout.top >= -1 && layout.bottom <= height + 1, JSON.stringify(layout))
      assert(!layout.overflow && !layout.rootOverflow, JSON.stringify(layout))
      assert(layout.input.left >= 0 && layout.input.right <= width && layout.reset.right <= width, JSON.stringify(layout))
      await page.click(id('settings-interface-scale-reset'))
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '20px')
      await change(id('settings-interface-scale'), scale)
      results.push({ scale, width, height, layout })
      await page.screenshot({ path: resolve(evidence, `${scale}-${width}-${height}.png`) })
    }
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(mutations, [])
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ ok: true, enlarged, baseline, results }, null, 2))
  console.log(`PASS default whole-interface 125%, persisted 48px fonts, and ${results.length} responsive scale/window combinations`)
} catch (error) {
  await writeFile(resolve(evidence, 'failure.json'), JSON.stringify({ error: String(error), errors, mutations, results }, null, 2))
  throw error
} finally {
  await browser.close()
}

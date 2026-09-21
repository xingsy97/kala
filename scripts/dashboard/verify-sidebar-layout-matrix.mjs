#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = resolve(import.meta.dirname, '../..')
const dashboard = resolve(root, 'packages/dashboard')
const output = resolve(root, '.artifacts/sidebar-layout-matrix')
const port = 5299
const numberList = (name, fallback) => process.env[name]?.split(',').map(Number) ?? fallback
const widths = numberList('SIDEBAR_MATRIX_WIDTHS', [240, 256, 280, 320, 400, 544])
const scales = numberList('SIDEBAR_MATRIX_SCALES', [0.8, 1, 1.25, 1.5])
const viewports = numberList('SIDEBAR_MATRIX_VIEWPORTS', [1280, 1440, 1920])
const themes = process.env.SIDEBAR_MATRIX_THEMES?.split(',') ?? ['dark', 'light']

await mkdir(output, { recursive: true })
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: dashboard,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', (chunk) => { logs += chunk })
server.stderr.on('data', (chunk) => { logs += chunk })

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sidebar-layout-fixture.html`)
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Vite did not start\n${logs}`)
}

const failures = []
let browser
try {
  await waitForServer()
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  for (const viewport of viewports) {
    await page.setViewport({ width: viewport, height: 900, deviceScaleFactor: 1 })
    for (const theme of themes) {
      for (const scale of scales) {
        for (const sidebar of widths) {
          const id = `v${viewport}-s${sidebar}-z${String(scale).replace('.', '_')}-${theme}`
          await page.goto(`http://127.0.0.1:${port}/sidebar-layout-fixture.html?sidebar=${sidebar}&scale=${scale}&theme=${theme}`, { waitUntil: 'networkidle0' })
          await page.waitForSelector('body[data-fixture-ready="true"]')
          const result = await page.evaluate(() => {
            const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`)
            const rect = (element) => {
              const value = element.getBoundingClientRect()
              return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }
            }
            const sidebar = byTestId('matrix-sidebar')
            const actions = byTestId('explorer-header-actions')
            const group = byTestId('explorer-primary-action-group')
            const leading = byTestId('explorer-header-leading')
            const newChat = byTestId('explorer-new-chat')
            const selector = byTestId('product-switcher-trigger')
            const search = byTestId('explorer-search-button')
            const connect = byTestId('connect-workspace-button')
            const label = document.querySelector('.ak-new-chat-label')
            const brand = document.querySelector('.ak-sidebar-brand')
            const wordmark = document.querySelector('.ak-sidebar-wordmark')
            const collapse = byTestId('matrix-collapse')
            const values = { sidebar: rect(sidebar), actions: rect(actions), group: rect(group), leading: rect(leading), newChat: rect(newChat), selector: rect(selector), search: rect(search), connect: rect(connect), brand: rect(brand), wordmark: rect(wordmark), collapse: rect(collapse) }
            const visible = (element) => getComputedStyle(element).display !== 'none'
            const errors = []
            if (group.parentElement !== actions) errors.push('primary action group is not a direct child of the action row')
            if (!group.contains(leading) || !group.contains(newChat) || !leading.contains(selector)) errors.push('selector and New Chat are not in one group')
            const centers = [values.selector, values.newChat, values.search, values.connect].map((value) => (value.top + value.bottom) / 2)
            if (Math.max(...centers) - Math.min(...centers) > 1) errors.push(`controls are not on one row: ${centers.join(',')}`)
            if (actions.scrollWidth > actions.clientWidth + 1) errors.push(`action row overflows: ${actions.scrollWidth}/${actions.clientWidth}`)
            if (values.actions.left < values.sidebar.left || values.actions.right > values.sidebar.right + 1) errors.push('action row escapes sidebar')
            if (values.group.right > values.search.left - 4) errors.push('primary group overlaps search')
            if (visible(label) && label.scrollWidth > label.clientWidth + 1) errors.push(`New Chat text is clipped: ${label.scrollWidth}/${label.clientWidth}`)
            if (!visible(label) && values.newChat.width > 37) errors.push(`icon-only New Chat retained empty width: ${values.newChat.width}`)
            const interfaceScale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ak-interface-scale')) || 1
            if (!visible(wordmark) || values.wordmark.width < 1 || values.wordmark.height < 1) errors.push('Kala wordmark is hidden despite supported sidebar width')
            if (values.wordmark.width < 39 * interfaceScale || values.wordmark.width > 65 * interfaceScale) errors.push(`wordmark width out of bounds: ${values.wordmark.width} at ${interfaceScale}`)
            if (values.brand.right > values.collapse.left - 4) errors.push(`brand overlaps collapse control: ${values.brand.right}/${values.collapse.left}`)
            if (values.brand.left < values.sidebar.left || values.collapse.right > values.sidebar.right) errors.push('brand row escapes sidebar')
            return { errors, values, labelVisible: visible(label), wordmarkVisible: visible(wordmark) }
          })
          await page.click('[data-testid="product-switcher-trigger"]')
          await page.waitForSelector('[data-testid="product-switcher-menu"]', { timeout: 2_000 })
          const menu = await page.$('[data-testid="product-switcher-menu"]')
          if (!menu) result.errors.push('product menu did not open')
          else {
            const menuResult = await page.evaluate((element) => {
              const r = element.getBoundingClientRect()
              const side = document.querySelector('[data-testid="matrix-sidebar"]').getBoundingClientRect()
              const point = document.elementFromPoint(Math.min(r.right - 12, innerWidth - 12), r.top + Math.min(32, r.height / 2))
              return { left: r.left, right: r.right, sidebarLeft: side.left, sidebarRight: side.right, hit: Boolean(point && element.contains(point)) }
            }, menu)
            if (menuResult.left < menuResult.sidebarLeft - 1 || menuResult.right > menuResult.sidebarRight + 1 || !menuResult.hit) result.errors.push(`product menu is clipped: ${JSON.stringify(menuResult)}`)
          }
          if (result.errors.length) failures.push({ id, ...result })
          await page.screenshot({ path: resolve(output, `${id}.png`) })
        }
      }
    }
  }
} finally {
  if (browser) await browser.close()
  server.kill('SIGTERM')
}

if (failures.length) {
  console.error(JSON.stringify({ cases: widths.length * scales.length * viewports.length * themes.length, failures }, null, 2))
  process.exit(1)
}
console.log(`Sidebar layout matrix passed: ${widths.length * scales.length * viewports.length * themes.length} cases; screenshots: ${output}`)

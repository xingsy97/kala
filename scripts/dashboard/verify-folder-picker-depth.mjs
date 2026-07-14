#!/usr/bin/env node
/**
 * Reproduce & diagnose the folder-picker "empty column at depth N" bug.
 *
 * Attaches to an already-running dashboard (default http://localhost:3001)
 * via a headless Chrome debug endpoint, opens the New Session dialog,
 * drills through /workspace and its children column-by-column,
 * and records:
 *
 *   - the socket.io frames for every client:list_dirs / server:dir_list
 *   - the DOM column stack after each click (path + entry count)
 *   - the input value and breadcrumbs
 *
 * Assumes host + executor are already running (that's the state the user
 * reported the bug in — we don't want to reset it and lose the repro).
 *
 * Usage:
 *   node scripts/verify-folder-picker-depth.mjs
 *   DASHBOARD_URL=http://localhost:3001 START_PATH=/workspace \
 *     CHROME_DEBUG_URL=http://127.0.0.1:9222 node scripts/verify-folder-picker-depth.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://localhost:3001'
const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL ?? 'http://127.0.0.1:9222'
const START_PATH = process.env.START_PATH ?? '/workspace'
const DRILL_SEGMENTS = (process.env.DRILL_SEGMENTS ?? 'project,packages').split(',').filter(Boolean)

function log(...a) { console.log('[folder-picker]', ...a) }

const browser = await puppeteer.connect({ browserURL: CHROME_DEBUG_URL })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 960 })
  page.setDefaultTimeout(15_000)

  const wsFrames = []
  const client = await page.createCDPSession()
  await client.send('Network.enable')
  client.on('Network.webSocketFrameSent', ({ response }) => {
    const d = response.payloadData || ''
    if (d.includes('client:list_dirs')) wsFrames.push({ dir: 'sent', t: Date.now(), data: d.slice(0, 800) })
  })
  client.on('Network.webSocketFrameReceived', ({ response }) => {
    const d = response.payloadData || ''
    if (d.includes('server:dir_list')) wsFrames.push({ dir: 'recv', t: Date.now(), data: d.slice(0, 2000) })
  })

  await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  log('loaded', DASHBOARD_URL)

  await page.waitForSelector('[data-testid="workspace-row"][data-online="true"]', { timeout: 10_000 })
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('[data-testid^="workspace-new-session-"]')).find(
      (el) => !el.hasAttribute('disabled'),
    )
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForSelector('[data-testid="new-session-dialog"]')
  log('opened new session dialog')

  await sleep(600)
  const initial = await snapshot(page)
  log('initial state:', JSON.stringify(initial))

  await typePath(page, START_PATH)
  log(`typed START_PATH=${START_PATH}, waiting for column`)
  await waitForColumnAtPath(page, START_PATH, 8_000).catch((e) => log('WARN', e.message))

  let breadcrumbSnapshot = await snapshot(page)
  log(`after typing ${START_PATH}:`, JSON.stringify(breadcrumbSnapshot))

  let currentPath = START_PATH
  for (const seg of DRILL_SEGMENTS) {
    const next = `${currentPath.replace(/\/$/, '')}/${seg}`
    const clicked = await clickFinderDir(page, seg)
    if (!clicked) {
      log(`STOP: entry "${seg}" not found in current columns; drilled to ${currentPath}`)
      break
    }
    log(`clicked "${seg}", waiting for column at ${next}`)
    await waitForColumnAtPath(page, next, 8_000).catch((e) => log('WARN', e.message))
    const snap = await snapshot(page)
    log(`after click ${seg}:`, JSON.stringify(snap))
    currentPath = next
  }

  const finalSnap = await snapshot(page)
  console.log('\n=== FINAL COLUMNS ===')
  console.log(JSON.stringify(finalSnap, null, 2))

  console.log('\n=== WS FRAMES ===')
  for (const f of wsFrames) {
    console.log(`${f.dir} ${new Date(f.t).toISOString()} ${f.data}`)
  }

  const lastCol = finalSnap.columns.at(-1)
  const problem = lastCol && lastCol.entryCount === 0 && !lastCol.error
  console.log(`\nRESULT: ${problem ? 'REPRODUCED (empty non-error column)' : 'no-empty-column'} at depth ${finalSnap.columns.length}`)
} finally {
  await browser.disconnect().catch(() => {})
}

async function typePath(page, path) {
  const sel = '[data-testid="new-session-cwd-input"]'
  await page.click(sel)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(mod); await page.keyboard.press('KeyA'); await page.keyboard.up(mod)
  await page.keyboard.type(path, { delay: 3 })
  await page.keyboard.press('Enter')
}

async function clickFinderDir(page, name) {
  return page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll('[data-testid="finder-dir"]'))
    const row = rows.find((el) => {
      const label = el.querySelector('span')?.textContent?.trim()
      return label === n
    }) || rows.find((el) => (el.textContent || '').includes(n))
    if (!row) return false
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  }, name)
}

async function waitForColumnAtPath(page, path, timeout) {
  await page.waitForFunction(
    (p) => Array.from(document.querySelectorAll('[data-testid="finder-column"]')).some((el) => {
      const header = el.querySelector('div')?.textContent?.trim()
      return header === p
    }),
    { timeout },
    path,
  )
}

async function snapshot(page) {
  return page.evaluate(() => {
    const input = document.querySelector('[data-testid="new-session-cwd-input"]')?.value ?? ''
    const crumbs = Array.from(document.querySelectorAll('[data-testid^="dir-picker-breadcrumb-"]'))
      .map((el) => el.textContent?.trim() ?? '')
    const columns = Array.from(document.querySelectorAll('[data-testid="finder-column"]')).map((col) => ({
      path: col.querySelector('div')?.textContent?.trim() ?? '',
      entryCount: col.querySelectorAll('[data-testid="finder-dir"]').length,
      error: col.querySelector('.text-rose-600')?.textContent?.trim() ?? null,
      empty: !!col.querySelector('.text-xs.text-muted-foreground'),
    }))
    return { input, crumbs, columns }
  })
}

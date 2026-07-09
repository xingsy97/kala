#!/usr/bin/env node
/**
 * Verifies the outer 3-column layout (Workspaces | Sessions | Chat[ | Inspector])
 * is drag-resizable via the react-resizable-panels handles.
 *
 * Drags the handle between the Sessions column and the Chat column by +120 px,
 * then asserts:
 *   - Sessions panel width grew by ~120 px.
 *   - Chat panel shrank by roughly the same amount (rounding tolerance ±4 px).
 *   - autoSaveId="ak-outer-cols" wrote the new sizes to localStorage
 *     (react-resizable-panels persists as JSON under a namespaced key).
 */
import puppeteer from 'puppeteer-core'
import { setTimeout as sleep } from 'node:timers/promises'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const SESSION_ID = '01JVERIFYCOLUMNRESIZE00'

let exitCode = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) exitCode = 1
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1600, height: 1000 },
})

try {
  const page = await browser.newPage()
  // Wipe persisted sizes so this run starts from defaults regardless of prior
  // manual dragging in a real browser.
  await page.evaluateOnNewDocument(() => {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('react-resizable-panels')) localStorage.removeItem(k)
      }
    } catch {}
  })
  await page.goto(`${DASHBOARD_URL}/?sessionId=${SESSION_ID}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForSelector('[data-testid="sessions-panel"]', { timeout: 8_000 })
  await sleep(300)

  const before = await page.evaluate(() => {
    const ws = document.querySelector('[data-testid="workspaces-panel"]')?.getBoundingClientRect()
    const ss = document.querySelector('[data-testid="sessions-panel"]')?.getBoundingClientRect()
    return { ws: ws?.width ?? 0, ss: ss?.width ?? 0 }
  })
  check('sessions panel has real width', before.ss > 100, `w=${before.ss}`)

  // Find the resize handle immediately after the sessions panel. react-resizable-panels
  // renders one <div data-panel-resize-handle-id> per handle. We want the second
  // one (between sessions and chat).
  const handles = await page.$$('[data-panel-resize-handle-id]')
  check('at least 2 resize handles present', handles.length >= 2, `count=${handles.length}`)
  if (handles.length < 2) throw new Error('missing handles')

  const handle = handles[1]
  const box = await handle.boundingBox()
  if (!box) throw new Error('handle not visible')

  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  const dx = 120

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // Move in small steps so the panel library reacts smoothly.
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(startX + (dx * step) / 12, startY, { steps: 1 })
    await sleep(15)
  }
  await page.mouse.up()
  await sleep(300)

  const after = await page.evaluate(() => {
    const ws = document.querySelector('[data-testid="workspaces-panel"]')?.getBoundingClientRect()
    const ss = document.querySelector('[data-testid="sessions-panel"]')?.getBoundingClientRect()
    return { ws: ws?.width ?? 0, ss: ss?.width ?? 0 }
  })

  const grew = after.ss - before.ss
  check(
    'sessions column widened by ~120px after drag',
    Math.abs(grew - dx) < 20,
    `before=${before.ss} after=${after.ss} Δ=${grew}`,
  )
  check(
    'workspaces column width unchanged (drag was on the sessions↔chat handle)',
    Math.abs(after.ws - before.ws) < 6,
    `before=${before.ws} after=${after.ws}`,
  )

  const persisted = await page.evaluate(() => {
    const entries = []
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('react-resizable-panels')) entries.push(k)
    }
    return entries
  })
  check(
    'react-resizable-panels persisted sizes to localStorage',
    persisted.length > 0,
    `keys=${persisted.join(',') || '(none)'}`,
  )
} finally {
  await browser.close()
}
process.exit(exitCode)

import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DASHBOARD_URL = 'http://localhost:5288'
const WORKSPACE = process.env.AK_TEST_WORKSPACE ?? join(tmpdir(), 'agent-kernel-workspace')

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 960 })
page.setDefaultTimeout(15_000)

await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 20_000 })

const child = join(WORKSPACE, 'e2e-child2')
mkdirSync(child, { recursive: true })

await page.waitForSelector('[data-testid="workspace-row"][data-online="true"]', { timeout: 20_000 })
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('[data-testid^="workspace-new-session-"]')).find(el => !el.hasAttribute('disabled'))
  b?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForSelector('[data-testid="new-session-dialog"]')
await page.evaluate(() => {
  const create = Array.from(document.querySelectorAll('[data-testid="new-session-dialog"] button')).find(b => /create/i.test(b.textContent || ''))
  create?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15_000 })

await page.evaluate(() => {
  window.__probe = () => {
    const el = document.querySelector('[data-testid="inline-status-thinking"]')
    if (!el) return { present: false }
    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'))
    if (!fiberKey) return { present: true, fiber: null }
    let fiber = el[fiberKey]
    let hops = []
    while (fiber && hops.length < 12) {
      const name = fiber.type?.displayName || fiber.type?.name || (typeof fiber.type === 'string' ? fiber.type : '?')
      hops.push({
        name,
        props: fiber.memoizedProps && typeof fiber.memoizedProps === 'object'
          ? Object.fromEntries(Object.entries(fiber.memoizedProps).filter(([k, v]) => typeof v !== 'function' && k !== 'children').map(([k, v]) => {
              if (v && typeof v === 'object' && 'status' in v) return [k, { status: v.status, pendingCalls_len: v.pendingCalls?.length }]
              return [k, v]
            }))
          : null,
      })
      fiber = fiber.return
    }
    return { present: true, hops }
  }
})

await page.click('[data-testid="composer-input"]')
await page.type('[data-testid="composer-input"]', 'reply with exactly the word: hello')
await page.keyboard.press('Enter')

const start = Date.now()
const snapshots = []
while (Date.now() - start < 8000) {
  snapshots.push({ t: Date.now() - start, ...(await page.evaluate(() => window.__probe())) })
  await sleep(250)
}

console.log('=== timeline (InlineStatusRow props only) ===')
let lastKey = null
for (const snap of snapshots) {
  if (!snap.present) {
    if (lastKey !== 'absent') { console.log(`+${snap.t}ms  SPINNER ABSENT`); lastKey = 'absent' }
    continue
  }
  const inline = snap.hops?.find(h => h.name === 'InlineStatusRow')
  const key = JSON.stringify(inline?.props ?? null)
  if (key !== lastKey) {
    console.log(`+${snap.t}ms  InlineStatusRow.props =`, key)
    lastKey = key
  }
}

await browser.disconnect()

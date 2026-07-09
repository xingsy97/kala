import puppeteer from 'puppeteer-core'
import { setTimeout as sleep } from 'node:timers/promises'

const DASHBOARD_URL = 'http://localhost:5288'

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })
// Close any previous pages so we get a fresh state
for (const p of await browser.pages()) { try { await p.close() } catch {} }
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 960 })
page.setDefaultTimeout(20_000)
page.on('pageerror', (err) => console.log('[pageerror]', err.message))
page.on('console', (m) => {
  const t = m.type()
  if (t === 'error') console.log('[console error]', m.text())
})

await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 20_000 })

// Always create a NEW session — this is the code path that reproduces the bug.
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

// Reset log
await page.evaluate(() => { window.__akLog = [] })

await page.click('[data-testid="composer-input"]')
await page.type('[data-testid="composer-input"]', 'reply with exactly the word: hello')
await page.keyboard.press('Enter')

await sleep(12000)

const log = await page.evaluate(() => window.__akLog)
const spinnerVisible = await page.evaluate(() => !!document.querySelector('[data-testid="inline-status-thinking"]'))
const finalProbe = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="inline-status-thinking"]')
  if (!el) return { present: false }
  const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'))
  let f = el[fk]
  const hops = []
  while (f && hops.length < 8) {
    const name = f.type?.displayName || f.type?.name || (typeof f.type === 'string' ? f.type : '?')
    hops.push({ name, props: f.memoizedProps && typeof f.memoizedProps === 'object'
      ? Object.fromEntries(Object.entries(f.memoizedProps).filter(([k, v]) => typeof v !== 'function' && k !== 'children').map(([k, v]) => {
          if (v && typeof v === 'object' && 'status' in v) return [k, { status: v.status, pendingCalls_len: v.pendingCalls?.length }]
          return [k, v]
        }))
      : null })
    f = f.return
  }
  return { present: true, hops }
})

console.log('=== ak log ===')
for (const e of log ?? []) {
  console.log(`t=${e.t.toFixed(0)}`, JSON.stringify(e))
}
console.log(`=== spinner visible: ${spinnerVisible} ===`)
console.log('=== final probe ===')
console.log(JSON.stringify(finalProbe, null, 2))

await browser.disconnect()

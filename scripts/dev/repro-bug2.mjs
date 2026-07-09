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
page.setDefaultTimeout(20_000)

page.on('console', (msg) => {
  const t = msg.type()
  if (t === 'log' || t === 'warn' || t === 'error') {
    console.log(`[browser ${t}]`, msg.text())
  }
})

await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 20_000 })

const child = join(WORKSPACE, 'e2e-child3')
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

// Install socket + probe instrumentation
await page.evaluate(() => {
  window.__wsLog = []
  window.__renderLog = []
  window.__probeAll = () => {
    // Find *any* fiber root by walking from body
    const results = { spinner: null, hookStates: [] }
    const el = document.querySelector('[data-testid="inline-status-thinking"]')
    if (el) {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'))
      if (fk) {
        let f = el[fk]
        let hops = []
        while (f && hops.length < 20) {
          const name = f.type?.displayName || f.type?.name || (typeof f.type === 'string' ? f.type : '?')
          hops.push({
            name,
            props: f.memoizedProps && typeof f.memoizedProps === 'object'
              ? Object.fromEntries(Object.entries(f.memoizedProps).filter(([k, v]) => typeof v !== 'function' && k !== 'children').map(([k, v]) => {
                  if (v && typeof v === 'object' && 'status' in v) return [k, { status: v.status, pendingCalls_len: v.pendingCalls?.length }]
                  return [k, v]
                }))
              : null,
          })
          f = f.return
        }
        results.spinner = { present: true, hops }
      } else {
        results.spinner = { present: true, fiber: null }
      }
    } else {
      results.spinner = { present: false }
    }
    return results
  }

  // Patch Socket.IO client to log incoming events.
  // The dashboard uses socket.io-client; io() returns a Manager/Socket.
  // Easiest: monkey-patch the prototype `.on` to wrap listeners.
  const wsLogNames = new Set(['event:appended', 'state:changed', 'session:token_delta', 'approval:required', 'session:error'])
  const tryPatch = () => {
    // socket.io-client attaches to window? no. Grab via any live socket instance found on module-scope.
    // We patch EventTarget-style via override of window.WebSocket instead.
    if (window.__wsPatched) return
    const origWs = window.WebSocket
    window.WebSocket = new Proxy(origWs, {
      construct(t, args) {
        const ws = new t(...args)
        const origAdd = ws.addEventListener.bind(ws)
        ws.addEventListener = (type, listener, opts) => {
          if (type === 'message') {
            const wrapped = (ev) => {
              try {
                const data = typeof ev.data === 'string' ? ev.data : ''
                // socket.io v4 engine.io frame: <packetType><socketIoType><json>
                // Message type '4' engine.io, then '2'=event
                if (data.startsWith('42')) {
                  const idx = data.indexOf('[')
                  if (idx >= 0) {
                    const arr = JSON.parse(data.slice(idx))
                    const name = arr[0]
                    if (wsLogNames.has(name)) {
                      const payload = arr[1]
                      const summary = { t: performance.now(), name }
                      if (payload) {
                        if (payload.event) summary.eventKind = payload.event.kind
                        if (payload.state) summary.stateStatus = payload.state.status
                        if (payload.seq !== undefined) summary.seq = payload.seq
                      }
                      window.__wsLog.push(summary)
                    }
                  }
                }
              } catch {}
              listener(ev)
            }
            return origAdd(type, wrapped, opts)
          }
          return origAdd(type, listener, opts)
        }
        return ws
      }
    })
    window.__wsPatched = true
  }
  tryPatch()
})

// Reload so the WebSocket patch applies to a fresh socket connection.
await page.reload({ waitUntil: 'networkidle2' })

// Re-install probes after reload (they were cleared).
await page.evaluate(() => {
  window.__wsLog = []
  window.__probeAll = () => {
    const results = { spinner: null }
    const el = document.querySelector('[data-testid="inline-status-thinking"]')
    if (el) {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'))
      if (fk) {
        let f = el[fk]
        let hops = []
        while (f && hops.length < 20) {
          const name = f.type?.displayName || f.type?.name || (typeof f.type === 'string' ? f.type : '?')
          hops.push({
            name,
            props: f.memoizedProps && typeof f.memoizedProps === 'object'
              ? Object.fromEntries(Object.entries(f.memoizedProps).filter(([k, v]) => typeof v !== 'function' && k !== 'children').map(([k, v]) => {
                  if (v && typeof v === 'object' && 'status' in v) return [k, { status: v.status, pendingCalls_len: v.pendingCalls?.length }]
                  return [k, v]
                }))
              : null,
          })
          f = f.return
        }
        results.spinner = { present: true, hops }
      } else {
        results.spinner = { present: true, fiber: null }
      }
    } else {
      results.spinner = { present: false }
    }
    return results
  }
})

// Wait for socket reconnection.
await page.waitForSelector('[data-testid="workspace-row"][data-online="true"]', { timeout: 20_000 })
// Session should still be around; find its item or create new.
const hasComposer = await page.$('[data-testid="composer-input"]')
if (!hasComposer) {
  // Click first session in list
  const clicked = await page.evaluate(() => {
    const s = document.querySelector('[data-testid^="session-row-"]')
    if (s) { s.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true }
    return false
  })
  if (!clicked) {
    // Create new session
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('[data-testid^="workspace-new-session-"]')).find(el => !el.hasAttribute('disabled'))
      b?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForSelector('[data-testid="new-session-dialog"]')
    await page.evaluate(() => {
      const create = Array.from(document.querySelectorAll('[data-testid="new-session-dialog"] button')).find(b => /create/i.test(b.textContent || ''))
      create?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15_000 })
}

await page.click('[data-testid="composer-input"]')
await page.type('[data-testid="composer-input"]', 'reply with exactly the word: hello')
await page.keyboard.press('Enter')

const start = Date.now()
const snapshots = []
while (Date.now() - start < 20000) {
  snapshots.push({ t: Date.now() - start, ...(await page.evaluate(() => window.__probeAll())) })
  await sleep(100)
}

const wsLog = await page.evaluate(() => window.__wsLog)

console.log('=== WS events ===')
for (const e of wsLog) {
  console.log(`t=${e.t.toFixed(0)} ${e.name} seq=${e.seq ?? '-'} eventKind=${e.eventKind ?? '-'} stateStatus=${e.stateStatus ?? '-'}`)
}

console.log('=== spinner timeline (transitions only) ===')
let lastKey = null
for (const snap of snapshots) {
  const s = snap.spinner
  if (!s.present) {
    if (lastKey !== 'absent') { console.log(`+${snap.t}ms  SPINNER ABSENT`); lastKey = 'absent' }
    continue
  }
  const inline = s.hops?.find(h => h.name === 'InlineStatusRow')
  const key = JSON.stringify(inline?.props ?? null)
  if (key !== lastKey) {
    console.log(`+${snap.t}ms  InlineStatusRow.props =`, key)
    lastKey = key
  }
}

console.log(`=== final spinner present: ${snapshots[snapshots.length-1].spinner.present} ===`)

await browser.disconnect()

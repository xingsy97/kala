#!/usr/bin/env node
/**
 * Verifies the sessions column shows a human-recognizable label per session:
 *   - a session's label matches its first user_message,
 *   - truncated to 40 chars with a trailing "…" when the message is longer.
 *
 * Sends two prompts through the dashboard on fresh session ids:
 *   short  → "quick hi"       → label should be exactly "quick hi"
 *   long   → 60-char sentence → label should be first 40 chars + "…"
 * Then reads the row DOM in the SessionsColumn to confirm.
 */
import puppeteer from 'puppeteer-core'
import { setTimeout as sleep } from 'node:timers/promises'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'

let exitCode = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) exitCode = 1
}

const stamp = Date.now().toString(36).toUpperCase().padStart(11, '0').slice(-11)
const SHORT_ID = `01JVSL${stamp}SHORT`.padEnd(26, 'X').slice(0, 26)
const LONG_ID = `01JVSL${stamp}LONG`.padEnd(26, 'X').slice(0, 26)
const SHORT_TEXT = 'quick hi'
const LONG_TEXT =
  'this is a deliberately long user message meant to exceed forty characters so the label truncates'
// First 40 chars, then unicode ellipsis added by the UI.
const LONG_LABEL_EXPECTED = LONG_TEXT.slice(0, 40) + '…'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1600, height: 1000 },
})

async function sendMessage(page, sessionId, text) {
  await page.goto(`${DASHBOARD_URL}/?sessionId=${sessionId}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-status') ===
      'ready',
    { timeout: 8_000 },
  )
  await page.focus('[data-testid="composer-input"]')
  await page.keyboard.type(text, { delay: 3 })
  await page.click('[data-testid="composer-send"]')
  // The host only broadcasts server:sessions on session CREATION — later
  // updates (including firstUserMessage arriving) don't rebroadcast the list.
  // Give the host a moment to persist the message, then reload the page so
  // the fresh socket triggers a client:list_sessions on connect.
  await sleep(1200)
  await page.reload({ waitUntil: 'networkidle2', timeout: 15_000 })
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`[data-session-id="${id}"]`)
      if (!row) return false
      const label = row.querySelector('button div')?.textContent ?? ''
      return label.length > 0 && !label.startsWith('new session ·')
    },
    { timeout: 15_000 },
    sessionId,
  )
}

try {
  const page = await browser.newPage()
  await sendMessage(page, SHORT_ID, SHORT_TEXT)
  await sendMessage(page, LONG_ID, LONG_TEXT)
  // Let the sessions list update after the second message.
  await sleep(500)

  const rows = await page.$$eval('[data-testid="session-row"]', (nodes) =>
    nodes.map((n) => {
      const label = n.querySelector('button div')?.textContent ?? ''
      return { sessionId: n.getAttribute('data-session-id') ?? '', label }
    }),
  )
  const shortRow = rows.find((r) => r.sessionId === SHORT_ID)
  const longRow = rows.find((r) => r.sessionId === LONG_ID)
  check('short-message session row rendered', !!shortRow, shortRow?.label ?? '(none)')
  check('long-message session row rendered', !!longRow, longRow?.label ?? '(none)')

  check(
    'short message label matches full text (no truncation)',
    shortRow?.label === SHORT_TEXT,
    `got=${shortRow?.label ?? '(none)'} expected=${SHORT_TEXT}`,
  )
  check(
    'long message label = first 40 chars + "…"',
    longRow?.label === LONG_LABEL_EXPECTED,
    `got=${longRow?.label ?? '(none)'} expected=${LONG_LABEL_EXPECTED}`,
  )
  // Belt-and-suspenders: label visually can't be longer than the source string.
  check(
    'long label length is exactly 41 chars (40 + ellipsis)',
    (longRow?.label?.length ?? 0) === 41,
    `len=${longRow?.label?.length ?? 0}`,
  )
} finally {
  await browser.close()
}
process.exit(exitCode)

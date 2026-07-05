#!/usr/bin/env node
/**
 * Verifies a user_message round-trip does NOT produce the Anthropic 401 that
 * plagued earlier boots. Boots a dashboard page, waits for socket ready,
 * sends a short prompt, then reads the resulting session JSONL and asserts
 * no 401 / authentication error appears in any `llm_error` event.
 *
 * Requires:
 *   - host running at HOST_URL
 *   - SESSIONS_DIR pointing at the same dir the host wrote (default
 *     /tmp/agent-kernel-e2e-sessions)
 *   - dashboard reachable at DASHBOARD_URL
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? '/tmp/agent-kernel-e2e-sessions'
const MODEL = process.env.VERIFY_MODEL ?? 'gpt-5.5'
const SESSION_ID = process.env.VERIFY_SESSION_ID ?? '01JVERIFYNOAUTHERRORXXXX'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err}`))

  await page.goto(`${DASHBOARD_URL}/?sessionId=${SESSION_ID}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })

  // Wait until the status pill says "ready" (socket connected).
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-status') ===
      'ready',
    { timeout: 8_000 },
  )

  // Pick the target model — the router uses exact match on the model id.
  await page.click('[data-testid="model-picker"]')
  const optionSel = `[data-testid="model-option-${MODEL}"]`
  await page.waitForSelector(optionSel, { timeout: 4_000 })
  await page.click(optionSel)
  await sleep(200)

  // Send a tiny prompt via the Send button (Enter also works, but clicking
  // is less flaky than keystroke timing).
  const textarea = await page.$('[data-testid="composer-input"]')
  if (!textarea) throw new Error('composer textarea not found')
  await textarea.click()
  await page.keyboard.type('ping', { delay: 5 })
  await page.click('[data-testid="composer-send"]')

  // Give the host a moment to hit the LLM.
  await sleep(8_000)

  const events = readSessionEvents(SESSIONS_DIR, SESSION_ID)
  const errorEvents = events.filter((e) => e.kind === 'llm_error')
  const has401 = errorEvents.some((e) =>
    /HTTP 401|authentication_error|invalid x-api-key/i.test(e.error ?? ''),
  )

  const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!pass) process.exitCode = 1
  }

  check(
    'session log contains user_message',
    events.some((e) => e.kind === 'user_message' && e.text === 'ping'),
    events.find((e) => e.kind === 'user_message')?.text ?? '(none)',
  )
  check(
    'no 401 / auth error in llm_error events',
    !has401,
    errorEvents.find((e) => /401|auth/i.test(e.error ?? ''))?.error ?? '(none)',
  )
  // Fine-grained context: is there ANY llm_error? (Not necessarily a fail,
  // but the operator should see it.)
  if (errorEvents.length > 0 && !has401) {
    console.log(
      `NOTE ${errorEvents.length} llm_error event(s) present but none are auth-related:`,
    )
    for (const e of errorEvents) console.log(`  - ${e.error?.slice(0, 200)}`)
  }
  check(
    'no page errors',
    errors.length === 0,
    errors.slice(0, 3).join(' | ') || '(none)',
  )
} finally {
  await browser.close()
}

function readSessionEvents(dir, sessionId) {
  const files = readdirSync(dir).filter((f) => f.endsWith(`_${sessionId}.jsonl`))
  files.sort() // newest last (ISO timestamp prefix)
  const file = files[files.length - 1]
  if (!file) return []
  const raw = readFileSync(join(dir, file), 'utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const rec = JSON.parse(line)
      if (rec.kind === 'event' && rec.event) events.push(rec.event)
    } catch {}
  }
  return events
}

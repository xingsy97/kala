#!/usr/bin/env node
/**
 * Verifies that opening the dashboard without a `?sessionId=` query string
 * does NOT auto-write one into the URL. A pristine URL should stay pristine
 * until the user explicitly selects/creates a session or sends a message.
 *
 * Runs against the vite dev server (default port 5288). Host must be up too
 * (dashboard proxies /models and /socket.io to the host).
 */
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://localhost:5288'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'

let exitCode = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  -  ${detail}` : ''}`)
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

  // 1. Bare URL  -  no sessionId in URL.
  await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await sleep(500)
  let url = new URL(page.url())
  check(
    'bare URL stays bare (no sessionId auto-inserted)',
    !url.searchParams.has('sessionId'),
    `search=${url.search || '(empty)'}`,
  )

  // 2. Reload again  -  still bare.
  await page.reload({ waitUntil: 'networkidle2' })
  await sleep(500)
  url = new URL(page.url())
  check(
    'reload keeps URL bare',
    !url.searchParams.has('sessionId'),
    `search=${url.search || '(empty)'}`,
  )

  // 3. Click "+ new"  -  URL should now carry a sessionId.
  const hasNewBtn = await page.$('[data-testid="new-session-button"]')
  if (hasNewBtn) {
    await page.click('[data-testid="new-session-button"]')
    await sleep(400)
    url = new URL(page.url())
    check(
      'clicking + new writes sessionId into URL',
      url.searchParams.has('sessionId'),
      `search=${url.search}`,
    )
  } else {
    check('new-session-button visible', false, 'button missing')
  }

  // 4. Direct URL with sessionId  -  preserved.
  await page.goto(`${DASHBOARD_URL}/?sessionId=aaa-bbb-ccc`, {
    waitUntil: 'networkidle2',
  })
  await sleep(500)
  url = new URL(page.url())
  check(
    'explicit sessionId in URL is preserved',
    url.searchParams.get('sessionId') === 'aaa-bbb-ccc',
    `got=${url.searchParams.get('sessionId')}`,
  )
} finally {
  await browser.close()
}
process.exit(exitCode)

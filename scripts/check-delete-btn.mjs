#!/usr/bin/env node
/**
 * Snapshot: is the delete button actually visible on session rows?
 * Reports computed opacity/dimensions before AND after hovering the row,
 * so we know whether the " - " is really constant, or hidden.
 */

import puppeteer from 'puppeteer-core'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1400, height: 900 },
})

try {
  const page = await browser.newPage()
  await page.goto(`${DASHBOARD_URL}/?sessionId=01JVERIFYDELETEBTN000000`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForSelector('[data-testid="session-row"]', { timeout: 5_000 })

  const beforeHover = await page.$$eval(
    '[data-testid="session-delete-button"]',
    (nodes) =>
      nodes.map((n) => {
        const cs = getComputedStyle(n)
        const r = n.getBoundingClientRect()
        return { opacity: cs.opacity, width: r.width, height: r.height }
      }),
  )

  const row = await page.$('[data-testid="session-row"]')
  await row?.hover()
  await new Promise((r) => setTimeout(r, 400))

  const afterHover = await page.$$eval(
    '[data-testid="session-delete-button"]',
    (nodes) =>
      nodes.map((n) => {
        const cs = getComputedStyle(n)
        const r = n.getBoundingClientRect()
        return { opacity: cs.opacity, width: r.width, height: r.height }
      }),
  )

  console.log('delete buttons found:', beforeHover.length)
  console.log('before hover:', JSON.stringify(beforeHover, null, 2))
  console.log('after hover: ', JSON.stringify(afterHover, null, 2))
} finally {
  await browser.close()
}

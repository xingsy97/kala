#!/usr/bin/env node
/**
 * Verifies the session delete button is:
 *  - visible without hovering (opacity  -  0.9)
 *  - large enough to hit reliably ( -  24 - 24 CSS px)
 *  - the icon inside is  -  14px so it's not visually trivial
 *
 * Also confirms hover changes background to a destructive tint (rose-5xx).
 */
import puppeteer from 'puppeteer-core'
import { setTimeout as sleep } from 'node:timers/promises'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
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
  defaultViewport: { width: 1400, height: 900 },
})

try {
  const page = await browser.newPage()
  await page.goto(`${DASHBOARD_URL}/?sessionId=01JVERIFYDELETEBTN000000`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForSelector('[data-testid="session-row"]', { timeout: 8_000 })

  const buttons = await page.$$eval(
    '[data-testid="session-delete-button"]',
    (nodes) =>
      nodes.map((n) => {
        const cs = getComputedStyle(n)
        const r = n.getBoundingClientRect()
        const svg = n.querySelector('svg')
        const svgR = svg?.getBoundingClientRect()
        return {
          opacity: Number(cs.opacity),
          width: r.width,
          height: r.height,
          svgWidth: svgR?.width ?? 0,
          svgHeight: svgR?.height ?? 0,
        }
      }),
  )

  check('at least one delete button rendered', buttons.length > 0, `count=${buttons.length}`)
  const first = buttons[0]
  if (!first) {
    process.exit(1)
  }
  check(
    'delete button is fully visible without hover',
    first.opacity >= 0.9,
    `opacity=${first.opacity}`,
  )
  check(
    'delete button hit area  -  24 - 24 css px',
    first.width >= 24 && first.height >= 24,
    `${first.width} - ${first.height}`,
  )
  check(
    'delete icon  -  14 css px on each side',
    first.svgWidth >= 14 && first.svgHeight >= 14,
    `icon=${first.svgWidth} - ${first.svgHeight}`,
  )

  // Hover the button and confirm background changed to something red-ish.
  const btn = await page.$('[data-testid="session-delete-button"]')
  await btn.hover()
  await sleep(200)
  const afterHover = await page.$eval('[data-testid="session-delete-button"]', (n) => {
    const cs = getComputedStyle(n)
    return { bg: cs.backgroundColor }
  })
  const isRose = /rgba?\(\s*(2[0-4]\d|25[0-5]),\s*[0-6]\d?,\s*[0-9]\d?/.test(afterHover.bg)
  check('hover background trends red (rose-5xx)', isRose, afterHover.bg)
} finally {
  await browser.close()
}
process.exit(exitCode)

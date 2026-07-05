#!/usr/bin/env node
/**
 * Verifies the dashboard's model picker is populated from the host's `/models`
 * endpoint  -  not from a hardcoded list. Fails loudly if `gpt-4o` (the classic
 * hardcoded default) shows up, or if any model outside the local config leaks
 * in.
 *
 * Uses system Chrome via puppeteer-core so we don't ship a bundled browser.
 * Assumes a host is running at HOST_URL (default http://localhost:3000) and
 * either the host serves the built dashboard, or DASHBOARD_URL points at vite.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const SESSION_ID = '01JVERIFYMODELPICKERXXXX'

const expected = (await fetch(`${HOST_URL}/models`).then((r) => r.json())).models
  .map((m) => m.id)
  .sort()

if (expected.length === 0) {
  console.error('FAIL host /models is empty  -  check ~/.claude/settings.json + ~/.codex/config.toml')
  process.exit(1)
}
console.log(`expected models from /models: ${expected.join(', ')}`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err}`))
  page.on('response', (res) => {
    // Console.error entries for network failures don't carry the URL, so
    // filter here where we do have it: benign vite favicon 404s are ignored.
    if (res.status() < 400) return
    if (res.url().endsWith('/favicon.ico')) return
    errors.push(`${res.status()} ${res.request().method()} ${res.url()}`)
  })

  await page.goto(`${DASHBOARD_URL}/?sessionId=${SESSION_ID}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await sleep(1500)

  const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  -  ${detail}` : ''}`)
    if (!pass) process.exitCode = 1
  }

  // The trigger button shows the selected model as its "value" text.
  // Click it to open the Radix popover, which portals items into the body.
  await page.click('[data-testid="model-picker"]')
  // Radix animates the popover open; wait for at least one option.
  await page.waitForSelector('[data-testid^="model-option-"]', { timeout: 4_000 })

  const rendered = await page.$$eval(
    '[data-testid^="model-option-"]',
    (nodes) =>
      nodes.map((n) => (n.getAttribute('data-testid') ?? '').replace(/^model-option-/, '')),
  )
  const sorted = [...rendered].sort()

  check(
    'picker options match /models exactly',
    JSON.stringify(sorted) === JSON.stringify(expected),
    `rendered=[${sorted.join(', ')}] expected=[${expected.join(', ')}]`,
  )
  check(
    'no gpt-4o in picker',
    !rendered.some((id) => id.toLowerCase().includes('gpt-4o')),
    `rendered=${rendered.join(', ')}`,
  )
  check(
    'no page errors',
    errors.length === 0,
    errors.slice(0, 3).join(' | ') || '(none)',
  )
} finally {
  await browser.close()
}

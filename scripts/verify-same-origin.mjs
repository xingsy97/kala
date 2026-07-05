#!/usr/bin/env node
/**
 * Verifies the dashboard connects to Socket.IO on the host's own origin —
 * i.e. no `?host=` query string is required or written back into the URL.
 *
 * Uses system Chrome via puppeteer-core so we don't ship a bundled browser.
 * Assumes a host is running at HOST_URL (default http://localhost:3000) and
 * that it is serving the built dashboard bundle from packages/dashboard/dist.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const CHROME =
  process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const SESSION_ID = '01JVERIFYSAMEORIGINXXXXX'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const page = await browser.newPage()
  const socketUrls = []
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('/socket.io/')) socketUrls.push(u)
  })
  // WebSocket upgrades don't show up as regular requests — hook the CDP.
  const client = await page.target().createCDPSession()
  await client.send('Network.enable')
  client.on('Network.webSocketCreated', ({ url }) => {
    if (url.includes('/socket.io/')) socketUrls.push(url)
  })
  const consoleErrors = []
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  const target = `${HOST_URL}/?sessionId=${SESSION_ID}`
  await page.goto(target, { waitUntil: 'networkidle2', timeout: 15_000 })
  // Give the socket a moment to actually connect.
  await sleep(1500)

  const finalUrl = page.url()
  const status = await page
    .$eval('[data-testid="connection-status"]', (el) => el.textContent?.trim())
    .catch(() => null)

  const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!pass) process.exitCode = 1
  }

  check(
    'final URL has no host param',
    !finalUrl.includes('host='),
    finalUrl,
  )
  check(
    'final URL keeps sessionId',
    finalUrl.includes(`sessionId=${SESSION_ID}`),
    finalUrl,
  )
  check(
    'at least one socket.io connection',
    socketUrls.length > 0,
    `${socketUrls.length} url(s)`,
  )
  check(
    'socket.io connects to the host origin',
    socketUrls.every(
      (u) => u.startsWith(HOST_URL) || u.startsWith(HOST_URL.replace(/^http/, 'ws')),
    ),
    socketUrls.slice(0, 2).join(', ') || '(none)',
  )
  check(
    'connection reaches ready',
    status === 'ready',
    `status=${status ?? '(missing)'}`,
  )
  check(
    'no page errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || '(none)',
  )
} finally {
  await browser.close()
}

#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const port = Number(process.env.HEADLESS_DASHBOARD_PORT ?? 4173)
const debugPort = Number(process.env.HEADLESS_CHROME_PORT ?? 9229)
const origin = `http://127.0.0.1:${port}`
const chrome = process.env.CHROME_BIN ?? '/snap/bin/chromium'
const profile = mkdtempSync(join(tmpdir(), 'ak-headless-'))
const preview = spawn('pnpm', ['--dir', 'packages/dashboard', 'preview', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' })
const chromium = spawn(chrome, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${origin}/`)).ok) break } catch {}
    await sleep(100)
  }
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok) break } catch {}
    await sleep(100)
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const started = performance.now()
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 30_000 })
  const navigationMs = performance.now() - started
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js') })
  for (let i = 0; i < 50; i++) {
    if (await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active))) break
    await sleep(100)
  }
  await sleep(500)
  const result = await page.evaluate(async () => {
    const keys = await caches.keys()
    const requests = []
    for (const key of keys) requests.push(...await (await caches.open(key)).keys())
    return { cacheEntries: requests.length, cacheNames: keys, controller: Boolean(navigator.serviceWorker.controller) }
  })
  const metrics = await page.metrics()
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`)
  if (result.cacheEntries > 25) throw new Error(`precache budget exceeded: ${result.cacheEntries}`)
  console.log(JSON.stringify({ navigationMs, taskDuration: metrics.TaskDuration, heapBytes: metrics.JSHeapUsedSize, nodes: metrics.Nodes, ...result }, null, 2))
  await page.close()
  await browser.disconnect()
} finally {
  preview.kill('SIGTERM')
  chromium.kill('SIGTERM')
}

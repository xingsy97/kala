#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const ROOT = new URL('../..', import.meta.url).pathname
const PORT = Number(process.env.VERIFY_DASHBOARD_PORT ?? 3192)
const HOST_URL = `http://127.0.0.1:${PORT}`
const OUT = process.env.DASHBOARD_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'agent-kernel-top-pages-'))
const SESSIONS = mkdtempSync(join(tmpdir(), 'agent-kernel-top-pages-sessions-'))
mkdirSync(OUT, { recursive: true })
const chrome = process.env.CHROME_PATH ?? ['/usr/bin/chromium', '/usr/bin/google-chrome', '/snap/bin/chromium'].find(existsSync)
if (!chrome) throw new Error('Chromium not found; set CHROME_PATH')

await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'], 90_000)
const host = spawn('pnpm', ['--filter', '@agent-kernel/host', 'dev'], {
  cwd: ROOT,
  env: { ...process.env, HOST_PORT: String(PORT), SESSIONS_DIR: SESSIONS, DASHBOARD_DIR: join(ROOT, 'packages/dashboard/dist') },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
host.stdout.on('data', (data) => logs.push(String(data)))
host.stderr.on('data', (data) => logs.push(String(data)))
let browser
const report = []
try {
  await waitFor(async () => {
    try { return (await fetch(HOST_URL)).ok } catch { return false }
  }, 20_000)
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  for (const viewport of [{ width: 390, height: 844, name: 'mobile' }, { width: 1440, height: 900, name: 'desktop' }]) {
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
    await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 20_000 })
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' })
    await page.evaluate(() => document.fonts.ready)
    for (const section of ['operations', 'artifacts', 'pipeline', 'docs']) {
      await page.click(`[data-testid="app-shell-nav-${section}"]`)
      await page.waitForSelector(`[data-testid="${section === 'pipeline' ? 'pipeline-page' : `${section}-page`}"]`, { timeout: 10_000 })
      await sleep(100)
      const geometry = await page.evaluate(() => {
        const unnamed = Array.from(document.querySelectorAll('button,a,input,select,textarea,[role="button"]'))
          .filter((element) => {
            const style = getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden') return false
            const rect = element.getBoundingClientRect()
            if (rect.width < 1 || rect.height < 1) return false
            const label = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.getAttribute('title') || element.textContent?.trim()
            return !label
          })
          .map((element) => ({ tag: element.tagName, testId: element.getAttribute('data-testid') }))
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, unnamed }
      })
      if (geometry.scrollWidth > geometry.width + 1) throw new Error(`${section} overflows at ${viewport.width}: ${JSON.stringify(geometry)}`)
      if (geometry.unnamed.length > 0) throw new Error(`${section} has unnamed controls: ${JSON.stringify(geometry.unnamed)}`)
      const path = join(OUT, `${viewport.name}-${section}.png`)
      await page.screenshot({ path })
      report.push({ viewport: viewport.name, section, path, geometry })
      if (viewport.name === 'mobile' && section === 'operations') {
        await page.click('[data-testid="operations-mobile-profiles"]')
        if (await page.$eval('[data-testid="operations-profiles-panel"]', (el) => getComputedStyle(el).display === 'none')) throw new Error('mobile operations profile switch failed')
      }
      if (viewport.name === 'mobile' && section === 'artifacts') {
        await page.click('[data-testid="artifacts-mobile-memory"]')
        if (await page.$eval('[data-testid="artifacts-memory-panel"]', (el) => getComputedStyle(el).display === 'none')) throw new Error('mobile artifacts memory switch failed')
      }
    }
  }
  if (errors.length > 0) throw new Error(`browser errors: ${errors.join('\n')}`)
  console.log(JSON.stringify({ artifactDir: OUT, report }, null, 2))
} finally {
  if (browser) await browser.close().catch(() => {})
  try { process.kill(-host.pid, 'SIGTERM') } catch { host.kill('SIGTERM') }
  await sleep(200)
}

async function run(command, args, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out`)) }, timeoutMs)
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)) })
  })
}
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100) }
  throw new Error('timed out waiting for host')
}

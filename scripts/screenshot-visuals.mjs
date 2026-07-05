#!/usr/bin/env node
/**
 * Boot host + executor, load the dashboard in real Chrome, take screenshots
 * of the surfaces that changed in the visual overhaul so we can eyeball them.
 *
 * No LLM calls, no real workspaces beyond a /tmp scratch dir. The point is
 * DOM/CSS verification, not e2e behavior.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.VERIFY_DASHBOARD_PORT ?? 3183)
const HOST_URL = `http://localhost:${PORT}`
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'ak-screenshot-sessions-'))
const WORKSPACE = mkdtempSync(join(tmpdir(), 'ak-screenshot-workspace-'))
const WORKSPACE_ID_FILE = join(tmpdir(), `ak-screenshot-workspace-id-${process.pid}`)
const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL ?? 'http://127.0.0.1:9222'
const OUT_DIR = process.env.SCREENSHOT_DIR ?? '/tmp/ak-screenshots'
mkdirSync(OUT_DIR, { recursive: true })

const hostLog = []
const executorLog = []
let host
let executor
let browser
let page

const pageErrors = []

async function main() {
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'], 60_000)

  host = spawn('pnpm', ['--filter', '@agent-kernel/host', 'dev'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST_PORT: String(PORT),
      SESSIONS_DIR,
      DASHBOARD_DIR: join(REPO_ROOT, 'packages/dashboard/dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipe(host, hostLog, 'host')
  await waitForLog(hostLog, `agent-kernel-host listening on port ${PORT}`, 15_000)

  executor = spawn('pnpm', ['--filter', '@agent-kernel/executor', 'dev'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST_URL,
      WORKSPACE_NAME: 'ak-screenshot',
      SANDBOX_ROOTS: WORKSPACE,
      AGENT_KERNEL_WORKSPACE_ID_FILE: WORKSPACE_ID_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipe(executor, executorLog, 'exec')
  await waitForLog(executorLog, 'executor announced', 15_000)

  browser = await puppeteer.connect({ browserURL: CHROME_DEBUG_URL })
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })

  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await page.waitForSelector('[data-testid="new-session-button"]')

  // Screenshot 1: initial workspace picker / explorer (light mode)
  await snap('01-initial-light.png')

  // Toggle dark mode via the theme button if present
  await ensureLightMode()
  await snap('02-full-light.png')

  await toggleDark()
  await sleep(300)
  await snap('03-full-dark.png')

  // Back to light and create a session so we hit chat empty-state
  await toggleLight()
  await sleep(300)

  await createSession()
  await page.waitForSelector('[data-testid="composer-input"]')
  await sleep(400)
  await snap('04-session-empty-light.png')

  // Screenshot composer with focus + expand suggestion cards
  await page.click('[data-testid="composer-input"]')
  await sleep(200)
  await snap('05-composer-focus.png')

  // Dark mode with an active session
  await toggleDark()
  await sleep(300)
  await snap('06-session-empty-dark.png')

  // Settings dialog (opens fine without any session; loads /settings endpoint)
  await toggleLight()
  await sleep(200)
  await page.click('[data-testid="settings-button"]')
  await page.waitForSelector('[data-testid="settings-dialog"]')
  await page.waitForSelector('[data-testid="settings-tab-runtime"]')
  await sleep(300)
  await snap('07-settings-runtime-light.png')

  await page.click('[data-testid="settings-tab-models"]')
  await sleep(200)
  await snap('08-settings-models-light.png')

  await toggleDark()
  await sleep(200)
  await page.click('[data-testid="settings-tab-hooks"]')
  await sleep(200)
  await snap('09-settings-hooks-dark.png')

  await page.click('[data-testid="settings-tab-mcp"]')
  await sleep(200)
  await snap('10-settings-mcp-dark.png')

  // Close settings and stack up sessions so the Explorer time-buckets kick in
  await page.keyboard.press('Escape')
  await sleep(200)
  await toggleLight()
  await createSession()
  await sleep(200)
  await createSession()
  await sleep(400)
  await snap('11-explorer-time-buckets-light.png')

  await toggleDark()
  await sleep(200)
  await snap('12-explorer-time-buckets-dark.png')

  // Approval inline states are covered by ChatPanel.test.tsx unit tests —
  // driving a real pending approval requires either an LLM call or exposing
  // the socket globally, both of which are out of scope for a pure visual
  // regression pass. Skip.

  console.log(`Wrote screenshots to ${OUT_DIR}`)
  console.log(`Page errors:`, pageErrors)
}

main()
  .catch((e) => {
    console.error('FAIL:', e?.stack ?? e)
    process.exitCode = 1
  })
  .finally(async () => {
    if (browser) await browser.disconnect().catch(() => {})
    if (executor) executor.kill('SIGTERM')
    if (host) host.kill('SIGTERM')
    await sleep(400)
  })

async function ensureLightMode() {
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
  })
}

async function toggleDark() {
  await page.evaluate(() => document.documentElement.classList.add('dark'))
}

async function toggleLight() {
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
}

async function createSession() {
  await page.click('[data-testid="new-session-button"]')
  await page.waitForSelector('[data-testid="new-session-dialog"]')
  // Pick the first available workspace so the Create button un-disables.
  const firstPick = await page.waitForSelector('[data-testid^="workspace-pick-"]', { timeout: 5_000 })
  await firstPick.click()
  await page.waitForFunction(
    () => {
      const input = document.querySelector('[data-testid="new-session-cwd-input"]')
      return input instanceof HTMLInputElement && input.value.trim().length > 0
    },
    { timeout: 5_000 },
  )
  const confirm = await page.waitForSelector('[data-testid="new-session-create"]:not([disabled])', { timeout: 5_000 })
  await confirm.click()
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 })
}

async function snap(name) {
  const target = join(OUT_DIR, name)
  await page.screenshot({ path: target, fullPage: false })
  console.log('snap', target)
}

async function run(cmd, args, timeoutMs) {
  await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' })
    const t = setTimeout(() => {
      p.kill('SIGTERM')
      reject(new Error(`${cmd} timeout`))
    }, timeoutMs)
    p.on('exit', (code) => {
      clearTimeout(t)
      code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))
    })
  })
}

function pipe(child, sink, label) {
  child.stdout.on('data', (d) => {
    const s = d.toString()
    sink.push(s)
    process.stderr.write(`[${label}] ${s}`)
  })
  child.stderr.on('data', (d) => {
    const s = d.toString()
    sink.push(s)
    process.stderr.write(`[${label}] ${s}`)
  })
}

async function waitForLog(sink, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sink.some((line) => line.includes(needle))) return
    await sleep(150)
  }
  throw new Error(`Timed out waiting for log: ${needle}`)
}

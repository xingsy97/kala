#!/usr/bin/env node
/**
 * Real browser regression check for the eval modal right-pane vertical
 * scrolling.
 *
 * Bug: after expanding the RunBenchmarkWizard (opening the Paste tab and the
 * JSONL help details), the eval mode right-pane content overflowed the fixed
 * dialog height with no way to scroll down. This script asserts the pane can
 * scroll after those expansions and reaches the bottom-most element.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.VERIFY_EVAL_MODAL_SCROLL_PORT ?? 3187)
const HOST_URL = `http://localhost:${PORT}`
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'ak-eval-modal-scroll-sessions-'))
const ARTIFACT_ROOT = mkdtempSync(join(tmpdir(), 'ak-eval-modal-scroll-artifacts-'))
const CHROME = process.env.CHROME_PATH ?? detectBrowser()

const checks = []
const hostLog = []
let host
let browser

function check(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}

try {
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'], {
    name: 'dashboard build',
    timeoutMs: 30_000,
  })

  host = spawn('pnpm', ['--dir', 'packages/host', 'exec', 'tsx', 'bin/agent-kernel-host.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST_PORT: String(PORT),
      SESSIONS_DIR,
      AGENT_KERNEL_ARTIFACTS_DIR: ARTIFACT_ROOT,
      DASHBOARD_DIR: join(REPO_ROOT, 'packages/dashboard/dist'),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeLog(host, hostLog)
  await waitForLog(hostLog, `"port":${PORT}`, 10_000)

  if (!CHROME) throw new Error('no chromium found; set CHROME_PATH')
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
  await page.goto(HOST_URL, { waitUntil: 'networkidle2', timeout: 15_000 })

  await openEvalMode(page)
  await verifyRightPaneScrolls(page)
} catch (err) {
  check('script completed without uncaught error', false, err?.stack ?? String(err))
} finally {
  if (browser) await browser.close().catch(() => {})
  await stopProcess(host)
}

const failed = checks.filter((c) => !c.pass)
if (failed.length > 0) {
  console.error('\n--- host log tail ---')
  console.error(hostLog.slice(-40).join(''))
  process.exit(1)
}

async function openEvalMode(page) {
  await page.waitForSelector('[data-testid="eval-dashboard-button"]', { timeout: 15_000 })
  await page.click('[data-testid="eval-dashboard-button"]')
  await page.waitForSelector('[data-testid="artifact-dialog"]', { timeout: 10_000 })
  await page.waitForSelector('[data-testid="artifact-mode-eval"]', { timeout: 10_000 })
  await page.click('[data-testid="artifact-mode-eval"]')
  await page.waitForSelector('[data-testid="run-benchmark-wizard-toggle"]', { timeout: 10_000 })
}

async function verifyRightPaneScrolls(page) {
  await page.click('[data-testid="run-benchmark-wizard-toggle"]')
  await page.waitForSelector('[data-testid="instances-source-tab-paste"]', { timeout: 5_000 })
  await page.click('[data-testid="instances-source-tab-paste"]')
  await page.waitForSelector('[data-testid="instances-paste-textarea"]', { timeout: 5_000 })

  const helpDetails = await page.$('[data-testid="artifact-dialog"] details')
  if (helpDetails) {
    await page.evaluate((el) => {
      if (el && !el.open) el.open = true
    }, helpDetails)
  }

  await sleep(200)

  await page.waitForSelector('[data-testid="eval-right-pane"]', { timeout: 5_000 })

  const metrics = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="eval-right-pane"]')
    if (!pane) return { error: 'no eval-right-pane' }
    const style = getComputedStyle(pane)
    return {
      overflowY: style.overflowY,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
    }
  })
  check(
    'eval right pane uses vertical overflow scrolling',
    metrics.overflowY === 'auto' || metrics.overflowY === 'scroll',
    JSON.stringify(metrics),
  )

  const scroll = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="eval-right-pane"]')
    if (!pane) return { error: 'no pane' }
    const before = pane.scrollTop
    pane.scrollTop = pane.scrollHeight
    const after = pane.scrollTop
    return {
      before,
      after,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
    }
  })
  check(
    'eval right pane can scroll vertically after wizard expansion',
    scroll.scrollHeight > scroll.clientHeight && scroll.after > scroll.before,
    JSON.stringify(scroll),
  )
}

function detectBrowser() {
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ]
  for (const path of candidates) if (existsSync(path)) return path
  return undefined
}

function pipeLog(proc, log) {
  proc.stdout.on('data', (b) => log.push(b.toString()))
  proc.stderr.on('data', (b) => log.push(b.toString()))
}

async function waitForLog(log, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (log.join('').includes(needle)) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for log: ${needle}`)
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    proc.kill('SIGTERM')
  }
  const deadline = Date.now() + 2_000
  while (proc.exitCode === null && Date.now() < deadline) {
    await sleep(50)
  }
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}

async function run(cmd, args, { name, timeoutMs }) {
  const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${name} exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

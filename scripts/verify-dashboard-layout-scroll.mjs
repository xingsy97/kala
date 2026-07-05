#!/usr/bin/env node
/**
 * Real dashboard layout/scroll regression check.
 *
 * Boots the built dashboard through a real host process and drives Chrome
 * against it. The session state is created through the host's real dashboard
 * socket so the inspector renders a large AgentState JSON tree without using a
 * mock LLM server.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.VERIFY_LAYOUT_PORT ?? 3174)
const HOST_URL = `http://localhost:${PORT}`
const SESSION_ID = `layout-scroll-${Date.now()}`
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'agent-kernel-layout-sessions-'))
const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL ?? 'http://127.0.0.1:9222'

const checks = []
const hostLog = []
let host
let browser

function check(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}

try {
  writeLargeSessionFixture()

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
      DASHBOARD_DIR: join(REPO_ROOT, 'packages/dashboard/dist'),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeLog(host, hostLog)
  await waitForLog(hostLog, `agent-kernel-host listening on port ${PORT}`, 10_000)

  browser = await puppeteer.connect({ browserURL: CHROME_DEBUG_URL })
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  await page.setViewport({ width: 1200, height: 520, deviceScaleFactor: 1 })
  await page.goto(`${HOST_URL}/?sessionId=${SESSION_ID}`, { waitUntil: 'networkidle2', timeout: 15_000 })
  await page.waitForSelector('[data-testid="composer-state-chips"]')
  await page.waitForSelector('[data-testid="json-block-scrollarea"]')

  await verifyFooterLayout(page)
  await verifyJsonWheelScroll(page)
} catch (err) {
  check('script completed without uncaught error', false, err?.stack ?? String(err))
} finally {
  if (browser) await browser.disconnect().catch(() => {})
  await stopProcess(host)
}

const failed = checks.filter((c) => !c.pass)
if (failed.length > 0) {
  console.error('\n--- host log tail ---')
  console.error(hostLog.slice(-40).join(''))
  process.exit(1)
}

async function verifyFooterLayout(page) {
  const metrics = await page.evaluate(() => {
    const chips = document.querySelector('[data-testid="composer-state-chips"]')
    const footer = chips?.parentElement
    const chipRects = Array.from(chips?.children ?? []).map((el) => {
      const rect = el.getBoundingClientRect()
      return {
        text: el.textContent || '',
        width: rect.width,
        height: rect.height,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        whiteSpace: getComputedStyle(el).whiteSpace,
      }
    })
    return {
      bodyScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      footerWidth: footer?.getBoundingClientRect().width ?? 0,
      footerScrollWidth: footer?.scrollWidth ?? 0,
      chipsText: chips?.textContent || '',
      chipRects,
    }
  })

  const tall = metrics.chipRects.filter((r) => r.height > 34)
  const clipped = metrics.chipRects.filter((r) => r.scrollWidth > Math.ceil(r.width) + 1)
  check('composer footer does not create page horizontal overflow', metrics.bodyScrollWidth <= metrics.viewportWidth + 1, JSON.stringify(metrics))
  check('composer footer content stays inside footer width', metrics.footerScrollWidth <= metrics.footerWidth + 1, JSON.stringify(metrics))
  check('status chips render as single-line pills', tall.length === 0 && clipped.length === 0, JSON.stringify(metrics.chipRects))
  check('token chip uses compact readable label', metrics.chipsText.includes('Tokens') && !metrics.chipsText.includes(' in / '), metrics.chipsText)
}

async function verifyJsonWheelScroll(page) {
  const before = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="json-block-scrollarea"]')
    const viewport = root?.querySelector('[data-radix-scroll-area-viewport]')
    if (!root || !viewport) return { found: false }
    const rect = viewport.getBoundingClientRect()
    return {
      found: true,
      scrollTop: viewport.scrollTop,
      clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      overflowY: getComputedStyle(viewport).overflowY,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }
  })
  if (before.found) {
    await page.mouse.move(before.x, before.y)
    await page.mouse.wheel({ deltaY: 600 })
    await sleep(150)
  }
  const after = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="json-block-scrollarea"]')
    const viewport = root?.querySelector('[data-radix-scroll-area-viewport]')
    if (!root || !viewport) return { found: false }
    return {
      found: true,
      scrollTop: viewport.scrollTop,
      clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      overflowY: getComputedStyle(viewport).overflowY,
    }
  })
  const result = { before, after }

  check('json viewer has a scrollable Radix viewport', before.found && before.scrollHeight > before.clientHeight, JSON.stringify(result))
  check('json viewer wheel changes scrollTop', after.found && after.scrollTop > before.scrollTop, JSON.stringify(result))
}

function writeLargeSessionFixture() {
  const config = { tools: [], systemPrompt: 'layout regression fixture' }
  const initialState = {
    sessionId: SESSION_ID,
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: config.systemPrompt }],
      },
    ],
    pendingCalls: [],
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    cursor: 0,
    todos: [],
    cwd: '/tmp',
    contextPressureLevel: 'none',
    approvalMode: 'auto',
  }
  let seq = 0
  const entries = [
    {
      kind: 'header',
      seq: 0,
      ts: new Date().toISOString(),
      sessionId: SESSION_ID,
      workspaceId: 'layout-workspace',
      workspaceName: 'layout-workspace',
      initialCwd: '/tmp',
      formatVersion: 1,
      kernelVersion: '0.0.0',
      config,
      initialState,
    },
  ]

  for (let i = 0; i < 30; i += 1) {
    const userEvent = {
      kind: 'user_message',
      text: `layout regression message ${i} ${'x'.repeat(120)}`,
    }
    seq += 1
    entries.push({
      kind: 'event',
      seq,
      ts: new Date().toISOString(),
      event: userEvent,
      effects: [{ kind: 'call_llm', messages: [], tools: [] }],
    })

    const assistantEvent = {
      kind: 'llm_response',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `layout regression assistant response ${i} ${'y'.repeat(160)}`,
          },
        ],
      },
      usage: { inputTokens: 100 + i, outputTokens: 10 + i, costUsd: 0 },
    }
    seq += 1
    entries.push({
      kind: 'event',
      seq,
      ts: new Date().toISOString(),
      event: assistantEvent,
      effects: [{ kind: 'finish' }],
    })
  }

  const path = join(SESSIONS_DIR, `${Date.now()}_${SESSION_ID}.jsonl`)
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
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
  while (proc.exitCode === null && Date.now() < deadline) await sleep(50)
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}

async function run(cmd, args, opts) {
  const proc = spawn(cmd, args, { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  pipeLog(proc, log)
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${opts.name} timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)
    proc.on('exit', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })
  if (code !== 0) throw new Error(`${opts.name} failed with ${code}\n${log.join('')}`)
  check(opts.name, true)
}

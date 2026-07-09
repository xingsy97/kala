#!/usr/bin/env node
/**
 * Real browser regression check for dashboard transcript changes.
 *
 * Covers two bugs that jsdom does not reliably expose:
 * - replayed SubAgentCard expansion must render the child transcript
 * - the chat transcript scrollbar owner must be the full chat panel, not the
 *   centered message-width column
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const requireFromHost = createRequire(new URL('../packages/host/package.json', import.meta.url))
const { io } = requireFromHost('socket.io-client')
const { PROTOCOL_VERSION } = await import('../packages/shared/dist/index.js')

const REPO_ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.VERIFY_SUBAGENT_SCROLL_PORT ?? 3176)
const HOST_URL = `http://localhost:${PORT}`
const PARENT_SESSION_ID = `subagent-scroll-parent-${Date.now()}`
const CHILD_SESSION_ID = `subagent-scroll-child-${Date.now()}`
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'agent-kernel-subagent-scroll-sessions-'))
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
  writeFixtureSessions()
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
  await waitForLog(hostLog, `"port":${PORT}`, 10_000)
  await verifyHostListsFixture()

  if (!CHROME) throw new Error('no chromium found; set CHROME_PATH')
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  await page.setViewport({ width: 1920, height: 760, deviceScaleFactor: 1 })
  await page.goto(`${HOST_URL}/?sessionId=${PARENT_SESSION_ID}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForSelector('[data-testid="chat-panel"]')
  await page.waitForSelector('[data-testid="sub-agent-row-agent-call-1"]')

  await verifySubAgentReplayExpansion(page)
  await verifyChatScrollerGeometry(page)
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

async function verifySubAgentReplayExpansion(page) {
  await page.click('[data-testid="sub-agent-toggle-agent-call-1"]')
  await page.waitForSelector('[data-testid="nested-transcript"]', { timeout: 5_000 })
  await page.waitForFunction(
    () => document.body.textContent?.includes('child answer visible in replay'),
    { timeout: 5_000 },
  )
  const metrics = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="sub-agent-row-agent-call-1"]')
    const nested = document.querySelector('[data-testid="nested-transcript"]')
    return {
      rowText: row?.textContent ?? '',
      nestedHeight: nested?.getBoundingClientRect().height ?? 0,
      nestedText: nested?.textContent ?? '',
    }
  })
  check(
    'expanded replayed sub-agent shows child transcript',
    metrics.nestedHeight > 40 && metrics.nestedText.includes('child answer visible in replay'),
    JSON.stringify(metrics),
  )
}

async function verifyChatScrollerGeometry(page) {
  const metrics = await page.evaluate(() => {
    const chat = document.querySelector('[data-testid="chat-panel"]')
    const transcript = document.querySelector('[data-testid="virtual-transcript"]')
    const scroller = transcript?.querySelector('[data-testid="virtuoso-scroller"]')
      ?? transcript?.querySelector('[data-virtuoso-scroller="true"]')
      ?? transcript?.querySelector('[data-virtuoso-scroller]')
      ?? transcript?.firstElementChild
    const rowWrapper = document.querySelector('[data-virt-index]')
    const rectFor = (el) => {
      const rect = el?.getBoundingClientRect()
      return rect
        ? { left: rect.left, right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom, height: rect.height }
        : null
    }
    return {
      chat: rectFor(chat),
      transcript: rectFor(transcript),
      scroller: rectFor(scroller),
      rowWrapper: rectFor(rowWrapper),
      transcriptText: transcript?.textContent?.slice(0, 200) ?? '',
      scrollerTag: scroller?.tagName ?? '',
    }
  })
  const rightDelta = Math.abs((metrics.scroller?.right ?? 0) - (metrics.chat?.right ?? Number.NaN))
  check(
    'chat virtual scroller spans the chat panel width',
    Boolean(metrics.chat && metrics.scroller) && rightDelta <= 4 && metrics.scroller.width >= metrics.chat.width - 4,
    JSON.stringify({ ...metrics, rightDelta }),
  )
  check(
    'chat row content remains width-constrained inside the full scroller',
    Boolean(metrics.rowWrapper && metrics.scroller) && metrics.rowWrapper.width < metrics.scroller.width,
    JSON.stringify(metrics),
  )
}

async function verifyHostListsFixture() {
  const socket = io(`${HOST_URL}/dashboard`, {
    transports: ['websocket'],
    auth: { sessionId: PARENT_SESSION_ID, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5_000)
      socket.on('connect', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
      socket.on('connect_error', reject)
    })
    const sessions = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client:list_sessions timeout')), 5_000)
      socket.once('server:sessions', (payload) => {
        clearTimeout(timer)
        resolve(payload.sessions ?? [])
      })
      socket.emit('client:list_sessions', {})
    })
    check(
      'host lists parent and child fixture sessions',
      sessions.some((s) => s.sessionId === PARENT_SESSION_ID) &&
        sessions.some((s) => s.sessionId === CHILD_SESSION_ID),
      JSON.stringify(sessions),
    )
  } finally {
    socket.close()
  }
}

function writeFixtureSessions() {
  const config = { tools: [], systemPrompt: 'subagent scroll regression fixture' }
  writeSession(PARENT_SESSION_ID, {
    config,
    workspaceId: 'subagent-scroll-workspace',
    workspaceName: 'subagent-scroll-workspace',
    initialState: stateFor(PARENT_SESSION_ID, [
      { role: 'system', content: [{ type: 'text', text: config.systemPrompt }] },
      { role: 'user', content: [{ type: 'text', text: 'spawn a child' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: 'agent-call-1',
            name: 'agent',
            input: { prompt: 'inspect child transcript', agent_type: 'Explore' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            callId: 'agent-call-1',
            ok: true,
            content: subAgentEnvelope(),
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'parent saw child result' }] },
    ]),
  })
  writeSession(CHILD_SESSION_ID, {
    config,
    workspaceId: 'subagent-scroll-workspace',
    workspaceName: 'subagent-scroll-workspace',
    parentSessionId: PARENT_SESSION_ID,
    parentCursor: 3,
    initialState: stateFor(CHILD_SESSION_ID, [
      { role: 'system', content: [{ type: 'text', text: 'child system' }] },
      { role: 'user', content: [{ type: 'text', text: 'child prompt visible in replay' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'child answer visible in replay' }] },
    ]),
  })
}

function writeSession(sessionId, { config, workspaceId, workspaceName, initialState, parentSessionId, parentCursor }) {
  const header = {
    kind: 'header',
    seq: 0,
    ts: new Date().toISOString(),
    sessionId,
    workspaceId,
    workspaceName,
    initialCwd: '/tmp',
    formatVersion: 1,
    kernelVersion: '0.0.0',
    config,
    initialState,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(parentCursor !== undefined ? { parentCursor } : {}),
  }
  writeFileSync(join(SESSIONS_DIR, `${Date.now()}_${sessionId}.jsonl`), `${JSON.stringify(header)}\n`)
}

function stateFor(sessionId, messages) {
  return {
    sessionId,
    messages,
    pendingCalls: [],
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0 },
    cursor: messages.length,
    memory: [],
    cwd: '/tmp',
    contextPressureLevel: 'none',
    approvalMode: 'auto',
  }
}

function subAgentEnvelope() {
  return [
    '<sub_agent',
    `  session_id="${CHILD_SESSION_ID}"`,
    '  agent_type="Explore"',
    '  status="completed"',
    '  turns="2"',
    '  duration_ms="123"',
    '>',
    '<result>',
    'child answer visible in replay',
    '</result>',
    '</sub_agent>',
  ].join('\n')
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

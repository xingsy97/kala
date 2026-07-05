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
const SHOTS_DIR = mkdtempSync(join(tmpdir(), 'agent-kernel-layout-shots-'))
const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL ?? 'http://127.0.0.1:9222'
const LAYOUT_STORAGE_PREFIX = 'react-resizable-panels:ak-outer-cols-'
const VIEWPORTS = [
  { width: 800, height: 620 },
  { width: 1200, height: 620 },
  { width: 1440, height: 780 },
]

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
  await page.goto(HOST_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await clearStoredPanelLayouts(page)
  await page.goto(`${HOST_URL}/?sessionId=${SESSION_ID}`, { waitUntil: 'networkidle2', timeout: 15_000 })
  await page.waitForSelector('[data-testid="activity-bar"]')
  await page.waitForSelector('[data-testid="model-picker"]')
  await page.waitForSelector('[data-testid="json-block-scrollarea"]')

  await verifyViewports(page)
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

async function verifyViewports(page) {
  for (const viewport of VIEWPORTS) {
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
    await sleep(150)
    if (viewport.width >= 1024) {
      await page.waitForSelector('[data-testid="session-row-cwd"]', { timeout: 3_000 })
    }
    await verifyResponsivePanels(page, viewport.width)
    await verifyChatContentLayout(page, viewport.width)
    await verifyFooterLayout(page, viewport.width)
    await verifyActivityBar(page, viewport.width)
    await verifyVisualIntegrity(page, viewport.width)
    await verifyJsonWheelScroll(page, viewport.width)
    const path = join(SHOTS_DIR, `dashboard-${viewport.width}.png`)
    await page.screenshot({ path, fullPage: false })
    check(`dashboard screenshot ${viewport.width}px`, true, path)
  }
  console.log(`Screenshots written to ${SHOTS_DIR}`)
}

async function verifyResponsivePanels(page, viewportWidth) {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="main-panel"]')
    const chat = document.querySelector('[data-testid="chat-panel"]')
    const explorer = document.querySelector('[data-testid="explorer-panel"]')
    const inspector = document.querySelector('[data-testid="inspector-panel"]')
    const toolbar = document.querySelector('[data-testid="workbench-toolbar"]')
    const inspectorToggle = document.querySelector('[data-testid="inspector-toggle"]')
    const selectedSession = document.querySelector('[data-testid="session-row"]')
    const sessionCwd = selectedSession?.querySelector('[data-testid="session-row-cwd"]')
    const rectFor = (el) => {
      const rect = el?.getBoundingClientRect()
      return rect ? { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null
    }
    return {
      viewportWidth: window.innerWidth,
      main: rectFor(main),
      chat: rectFor(chat),
      explorer: rectFor(explorer),
      inspector: rectFor(inspector),
      toolbar: rectFor(toolbar),
      inspectorTogglePresent: Boolean(inspectorToggle),
      sessionCwdText: sessionCwd?.textContent || '',
      sessionCwd: rectFor(sessionCwd),
      selectedSession: rectFor(selectedSession),
    }
  })
  if (viewportWidth < 1024) {
    check(`narrow layout removes explorer rail at ${viewportWidth}px`, metrics.explorer === null, JSON.stringify(metrics))
    check(`narrow layout removes inspector rail at ${viewportWidth}px`, metrics.inspector === null, JSON.stringify(metrics))
    check(`narrow layout keeps main panel readable at ${viewportWidth}px`, metrics.main?.width >= viewportWidth - 24, JSON.stringify(metrics))
    check(`narrow layout keeps chat panel readable at ${viewportWidth}px`, metrics.chat?.width >= viewportWidth - 24, JSON.stringify(metrics))
    check(`narrow layout hides inspector toggle at ${viewportWidth}px`, metrics.inspectorTogglePresent === false, JSON.stringify(metrics))
    return
  }
  const minMainWidth = viewportWidth === 1200 ? 660 : 820
  check(`wide layout keeps explorer rail at ${viewportWidth}px`, Boolean(metrics.explorer?.width), JSON.stringify(metrics))
  check(`wide layout keeps inspector rail at ${viewportWidth}px`, Boolean(metrics.inspector?.width), JSON.stringify(metrics))
  check(`wide layout keeps explorer at top level at ${viewportWidth}px`, metrics.explorer?.top === 0 && metrics.toolbar && metrics.toolbar.left >= (metrics.explorer?.right ?? 0), JSON.stringify(metrics))
  check(`wide layout shows session cwd metadata at ${viewportWidth}px`, metrics.sessionCwdText.includes('cwd /tmp') && metrics.sessionCwd && metrics.selectedSession && metrics.sessionCwd.bottom <= metrics.selectedSession.bottom + 1, JSON.stringify(metrics))
  check(`wide layout keeps explorer rail compact at ${viewportWidth}px`, metrics.explorer?.width <= viewportWidth * 0.19, JSON.stringify(metrics))
  check(`wide layout keeps inspector rail compact at ${viewportWidth}px`, metrics.inspector?.width <= viewportWidth * 0.31, JSON.stringify(metrics))
  check(`wide layout keeps main panel usable at ${viewportWidth}px`, metrics.main?.width >= minMainWidth, JSON.stringify(metrics))
  check(`wide layout exposes inspector toggle at ${viewportWidth}px`, metrics.inspectorTogglePresent === true, JSON.stringify(metrics))
}

async function verifyChatContentLayout(page, viewportWidth) {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="main-panel"]')
    const chat = document.querySelector('[data-testid="chat-panel"]')
    const rows = Array.from(document.querySelectorAll('[data-message-index]'))
    const mainRect = main?.getBoundingClientRect()
    const chatRect = chat?.getBoundingClientRect()
    const rowMetrics = rows.map((row) => {
      const rect = row.getBoundingClientRect()
      return {
        index: row.getAttribute('data-message-index'),
        width: rect.width,
        left: rect.left,
        right: rect.right,
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        textLength: row.textContent?.length ?? 0,
      }
    })
    const oversized = rowMetrics.filter((row) => {
      const overOwnBox = row.scrollWidth > row.clientWidth + 1
      const overMain = mainRect ? row.right > mainRect.right + 1 || row.left < mainRect.left - 1 : false
      return overOwnBox || overMain
    })
    const rawScrollbarNodes = Array.from(document.querySelectorAll('*')).filter((el) => {
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      const canScrollX = el.scrollWidth > el.clientWidth + 1
      const canScrollY = el.scrollHeight > el.clientHeight + 1
      const scrolls = /(auto|scroll)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)
      const isRadixViewport = el.hasAttribute('data-radix-scroll-area-viewport')
      const isControlledVirtualTree = Boolean(el.closest('[data-scroll-owner="react-arborist"]'))
      if (isRadixViewport) return false
      if (isControlledVirtualTree) return false
      if (rect.width < 20 || rect.height < 20) return false
      return scrolls && (canScrollX || canScrollY)
    }).map((el) => {
      const rect = el.getBoundingClientRect()
      return {
        tag: el.tagName,
        testId: el.getAttribute('data-testid'),
        className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
        width: rect.width,
        height: rect.height,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }
    })
    return {
      bodyScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      main: mainRect ? { left: mainRect.left, right: mainRect.right, width: mainRect.width } : null,
      chat: chatRect ? { left: chatRect.left, right: chatRect.right, width: chatRect.width } : null,
      rowCount: rowMetrics.length,
      oversized: oversized.slice(0, 5),
      rawScrollbarNodes: rawScrollbarNodes.slice(0, 8),
    }
  })
  check(`chat renders message rows at ${viewportWidth}px`, metrics.rowCount >= 20, JSON.stringify(metrics))
  check(`chat message rows stay inside main panel at ${viewportWidth}px`, metrics.oversized.length === 0, JSON.stringify(metrics))
  check(`page has no horizontal overflow from long chat content at ${viewportWidth}px`, metrics.bodyScrollWidth <= metrics.viewportWidth + 1, JSON.stringify(metrics))
  check(`scrollable regions use Radix scroll areas at ${viewportWidth}px`, metrics.rawScrollbarNodes.length === 0, JSON.stringify(metrics.rawScrollbarNodes))
}

async function verifyFooterLayout(page, viewportWidth) {
  const metrics = await page.evaluate(() => {
    const realControls = [
      '[data-testid="model-picker"]',
      '[data-testid="connection-status"]',
      '[data-testid="composer-send"]',
    ]
      .map((selector) => document.querySelector(selector))
      .filter(Boolean)
    const footer = document.querySelector('[data-testid="composer-footer"]')
    const controls = realControls.map((el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return {
        testId: el.getAttribute('data-testid'),
        text: el.textContent || '',
        width: rect.width,
        height: rect.height,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        display: style.display,
        visibility: style.visibility,
        whiteSpace: style.whiteSpace,
      }
    })
    return {
      bodyScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      footerWidth: footer?.getBoundingClientRect().width ?? 0,
      footerScrollWidth: footer?.scrollWidth ?? 0,
      footerHeight: footer?.getBoundingClientRect().height ?? 0,
      controls,
    }
  })

  const visibleControls = metrics.controls.filter(
    (r) => r.display !== 'none' && r.visibility !== 'hidden' && r.width > 4 && r.height > 4,
  )
  const tall = visibleControls.filter((r) => r.height > 34)
  const clipped = visibleControls.filter((r) => r.scrollWidth > Math.ceil(r.width) + 1)
  check(`composer footer does not create page horizontal overflow at ${viewportWidth}px`, metrics.bodyScrollWidth <= metrics.viewportWidth + 1, JSON.stringify(metrics))
  check(`composer footer content stays inside footer width at ${viewportWidth}px`, metrics.footerScrollWidth <= metrics.footerWidth + 1, JSON.stringify(metrics))
  check(`composer footer remains a compact single action row at ${viewportWidth}px`, metrics.footerHeight <= 42 && tall.length === 0 && clipped.length === 0, JSON.stringify(visibleControls))
  check(`runtime counters are not rendered in composer footer at ${viewportWidth}px`, !visibleControls.some((r) => /Cursor|Pending tools|Tokens/.test(r.text)), JSON.stringify(visibleControls))
}

async function verifyVisualIntegrity(page, viewportWidth) {
  const metrics = await page.evaluate(() => {
    const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    const selectors = [
      ['toolbar', '[data-testid="workbench-toolbar"]'],
      ['chat', '[data-testid="chat-panel"]'],
      ['activity', '[data-testid="activity-bar"]'],
      ['composer', '[data-testid="composer"]'],
      ['composerFooter', '[data-testid="composer-footer"]'],
      ['modelPicker', '[data-testid="model-picker"]'],
      ['connectionStatus', '[data-testid="connection-status"]'],
      ['sendButton', '[data-testid="composer-send"]'],
      ['explorer', '[data-testid="explorer-panel"]'],
      ['inspector', '[data-testid="inspector-panel"]'],
    ]
    const rectFor = (el) => {
      if (!el) return null
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 1 || rect.height < 1) return null
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      }
    }
    const rects = Object.fromEntries(selectors.map(([name, selector]) => [name, rectFor(document.querySelector(selector))]))
    const insideViewport = Object.entries(rects)
      .filter(([, rect]) => rect)
      .filter(([, rect]) => rect.left < viewport.left - 1 || rect.top < viewport.top - 1 || rect.right > viewport.right + 1 || rect.bottom > viewport.bottom + 1)
      .map(([name, rect]) => ({ name, rect }))
    const clippedControls = ['modelPicker', 'connectionStatus', 'compactButton', 'sendButton']
      .map((name) => ({ name, rect: rects[name] }))
      .filter(({ rect }) => rect && (rect.scrollWidth > Math.ceil(rect.width) + 1 || rect.scrollHeight > Math.ceil(rect.height) + 1))
    const footerControls = ['modelPicker', 'connectionStatus', 'compactButton', 'sendButton']
      .map((name) => ({ name, rect: rects[name] }))
      .filter(({ rect }) => rect)
    const overlappingFooterControls = []
    for (let i = 0; i < footerControls.length; i += 1) {
      for (let j = i + 1; j < footerControls.length; j += 1) {
        const a = footerControls[i]
        const b = footerControls[j]
        const separated = a.rect.right <= b.rect.left + 0.5 || b.rect.right <= a.rect.left + 0.5 || a.rect.bottom <= b.rect.top + 0.5 || b.rect.bottom <= a.rect.top + 0.5
        if (!separated) overlappingFooterControls.push([a.name, b.name])
      }
    }
    const verticalOrderProblems = []
    if (rects.toolbar && rects.chat && rects.toolbar.bottom > rects.chat.top + 1) verticalOrderProblems.push('toolbar overlaps chat')
    if (rects.chat && rects.activity && rects.chat.bottom > rects.activity.top + 1) verticalOrderProblems.push('chat overlaps activity')
    if (rects.activity && rects.composer && rects.activity.bottom > rects.composer.top + 1) verticalOrderProblems.push('activity overlaps composer')
    if (rects.composerFooter && rects.composer && (rects.composerFooter.top < rects.composer.top - 1 || rects.composerFooter.bottom > rects.composer.bottom + 1)) {
      verticalOrderProblems.push('composer footer outside composer')
    }
    return {
      viewport,
      rects,
      insideViewport,
      clippedControls,
      overlappingFooterControls,
      verticalOrderProblems,
      activeElementTag: document.activeElement?.tagName ?? '',
    }
  })

  check(`visible dashboard regions stay inside viewport at ${viewportWidth}px`, metrics.insideViewport.length === 0, JSON.stringify(metrics.insideViewport))
  check(`composer controls are not visually clipped at ${viewportWidth}px`, metrics.clippedControls.length === 0, JSON.stringify(metrics.clippedControls))
  check(`composer controls do not overlap at ${viewportWidth}px`, metrics.overlappingFooterControls.length === 0, JSON.stringify(metrics.overlappingFooterControls))
  check(`main column regions keep vertical order at ${viewportWidth}px`, metrics.verticalOrderProblems.length === 0, JSON.stringify(metrics.verticalOrderProblems))
}

async function verifyActivityBar(page, viewportWidth) {
  const metrics = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="activity-bar"]')
    const summary = document.querySelector('[data-testid="runtime-summary"]')
    const label = bar?.querySelector('[data-testid="activity-label"]')
    const detail = bar?.querySelector('[data-testid="activity-detail"]')
    const rect = bar?.getBoundingClientRect()
    const summaryRect = summary?.getBoundingClientRect()
    const summaryStyle = summary ? getComputedStyle(summary) : null
    return {
      text: bar?.textContent || '',
      visibleText: `${label?.textContent ?? ''} ${detail?.textContent ?? ''}`.trim(),
      summaryText: summary?.textContent || '',
      summaryDisplay: summaryStyle?.display ?? '',
      summaryVisible: Boolean(summaryRect && summaryStyle?.display !== 'none' && summaryRect.width > 4 && summaryRect.height > 4),
      width: rect?.width ?? 0,
      scrollWidth: bar?.scrollWidth ?? 0,
      height: rect?.height ?? 0,
      viewportWidth: window.innerWidth,
    }
  })
  const shouldShowSummary = viewportWidth >= 1536
  check(`activity bar shows readable agent state at ${viewportWidth}px`, metrics.visibleText.includes('Agent Ready') || metrics.visibleText.includes('Agent Done'), JSON.stringify(metrics))
  check(`activity bar runtime summary visibility is responsive at ${viewportWidth}px`, metrics.summaryVisible === shouldShowSummary, JSON.stringify(metrics))
  check(
    `activity bar shows explicit runtime labels at ${viewportWidth}px`,
    !shouldShowSummary || (metrics.summaryText.includes('Cursor') && metrics.summaryText.includes('Pending tools') && metrics.summaryText.includes('Tokens in/out')),
    metrics.summaryText,
  )
  check(`activity bar stays inside viewport at ${viewportWidth}px`, metrics.scrollWidth <= metrics.width + 1 && metrics.height <= 42, JSON.stringify(metrics))
}

async function clearStoredPanelLayouts(page) {
  await page.evaluate((prefix) => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(prefix)) window.localStorage.removeItem(key)
    }
  }, LAYOUT_STORAGE_PREFIX)
}

async function verifyJsonWheelScroll(page, viewportWidth) {
  if (viewportWidth < 1024) {
    const found = await page.evaluate(() => Boolean(document.querySelector('[data-testid="json-block-scrollarea"]')))
    check(`narrow layout does not render inspector json viewer at ${viewportWidth}px`, found === false, String(found))
    return
  }
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

  check(`json viewer has a scrollable Radix viewport at ${viewportWidth}px`, before.found && before.scrollHeight > before.clientHeight, JSON.stringify(result))
  check(`json viewer wheel changes scrollTop at ${viewportWidth}px`, after.found && after.scrollTop > before.scrollTop, JSON.stringify(result))
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

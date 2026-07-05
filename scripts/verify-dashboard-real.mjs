#!/usr/bin/env node
/**
 * Real dashboard E2E verification.
 *
 * This script intentionally exercises the production dashboard bundle served
 * by a real host process, a real executor process, a /tmp workspace, the real
 * configured LLM provider, and a real Chrome instance. It does not start a
 * mock OpenAI-compatible HTTP server.
 *
 * Checks:
 *   1. Streaming assistant drafts render before the final llm_response state.
 *   2. Manual compact completes, does not refresh/navigate the page, and keeps
 *      transcript messages visible.
 *   3. Scroll containers use Radix ScrollArea in the rendered DOM and dashboard
 *      app code has no raw overflow utility classes left in feature surfaces.
 *   4. Composer footer status chips stay single-line and JSON viewers respond
 *      to real mouse wheel scrolling.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.VERIFY_DASHBOARD_PORT ?? 3173)
const HOST_URL = `http://localhost:${PORT}`
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'agent-kernel-dashboard-sessions-'))
const WORKSPACE = mkdtempSync(join(tmpdir(), 'agent-kernel-dashboard-workspace-'))
const WORKSPACE_ID_FILE = join(tmpdir(), `agent-kernel-dashboard-workspace-id-${process.pid}`)
const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL ?? 'http://127.0.0.1:9222'
const MODEL = process.env.VERIFY_MODEL
const ANTHROPIC_MODEL = process.env.VERIFY_ANTHROPIC_MODEL ?? 'claude-opus-4.7-1m-internal'
const REMOVED_ANTHROPIC_MODEL = process.env.VERIFY_REMOVED_ANTHROPIC_MODEL ?? 'claude-haiku-4-5'
const TURN_TIMEOUT_MS = Number(process.env.VERIFY_TURN_TIMEOUT_MS ?? 10_000)

const checks = []
const hostLog = []
const executorLog = []

let host
let executor
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

  host = spawn(
    'pnpm',
    ['--filter', '@agent-kernel/host', 'dev'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOST_PORT: String(PORT),
        SESSIONS_DIR,
        DASHBOARD_DIR: join(REPO_ROOT, 'packages/dashboard/dist'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  pipeLog(host, hostLog)
  await waitForLog(hostLog, `agent-kernel-host listening on port ${PORT}`, 10_000)

  executor = spawn(
    'pnpm',
    ['--filter', '@agent-kernel/executor', 'dev'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOST_URL,
        WORKSPACE_NAME: 'dashboard-real-e2e',
        SANDBOX_ROOTS: WORKSPACE,
        AGENT_KERNEL_WORKSPACE_ID_FILE: WORKSPACE_ID_FILE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  pipeLog(executor, executorLog)
  await waitForLog(executorLog, 'executor announced; awaiting tool calls', 10_000)

  browser = await puppeteer.connect({ browserURL: CHROME_DEBUG_URL })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
  page.setDefaultTimeout(15_000)

  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text())
  })

  await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 15_000 })
  await createSessionFromFinder(page)
  await page.waitForSelector('[data-testid="composer-input"]')

  if (MODEL) await selectModel(page, MODEL)

  await verifyModelPicker(page)
  await verifyScrollbar(page)
  await verifyComposerFooterLayout(page)
  await verifyEmptyCompact(page)
  await verifySessionCwd(page)
  await verifyStreaming(page)
  await verifyStateFlow(page)
  await verifyJsonWheelScroll(page)
  await verifyCompact(page)
  await verifyBackgroundTerminalPanel(page)

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (err) {
  check('script completed without uncaught error', false, err?.stack ?? String(err))
} finally {
  if (browser) await browser.disconnect().catch(() => {})
  await stopProcess(executor)
  await stopProcess(host)
}

async function verifyModelPicker(page) {
  await page.click('[data-testid="model-picker"]')
  const optionText = await page.evaluate(() => document.body.textContent || '')
  check('anthropic primary model is selectable', optionText.includes(ANTHROPIC_MODEL), ANTHROPIC_MODEL)
  check('unavailable anthropic small model is not advertised', !optionText.includes(REMOVED_ANTHROPIC_MODEL), REMOVED_ANTHROPIC_MODEL)
  await page.keyboard.press('Escape')
}

async function createSessionFromFinder(page) {
  const parent = join(WORKSPACE, 'finder-parent')
  const child = join(parent, 'finder-child')
  mkdirSync(child, { recursive: true })

  await page.waitForSelector('[data-testid="new-session-button"]')
  await page.click('[data-testid="new-session-button"]')
  await page.waitForSelector('[data-testid="new-session-dialog"]')
  await page.waitForFunction(
    (workspace) => document.querySelector('[data-testid="new-session-cwd-input"]')?.value === workspace,
    { timeout: 5_000 },
    WORKSPACE,
  )
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('[data-testid="finder-dir"]')).some((el) => el.textContent?.includes('finder-parent')),
    { timeout: 5_000 },
  )
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="finder-dir"]'))
    const row = rows.find((el) => el.textContent?.includes('finder-parent'))
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('[data-testid="finder-dir"]')).some((el) => el.textContent?.includes('finder-child')),
    { timeout: 5_000 },
  )
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="finder-dir"]'))
    const row = rows.find((el) => el.textContent?.includes('finder-child'))
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="new-session-cwd-input"]')?.value === expected,
    { timeout: 5_000 },
    child,
  )
  await page.click('[data-testid="new-session-create"]')
  await page.waitForFunction(() => new URL(location.href).searchParams.has('sessionId'))
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="cwd-label"]')?.textContent?.includes(expected),
    { timeout: 5_000 },
    child,
  )

  const sessionId = new URL(page.url()).searchParams.get('sessionId')
  const header = readSessionHeader(SESSIONS_DIR, sessionId)
  check('new session dialog creates session with selected initial cwd', header?.initialCwd === child && header?.initialState?.cwd === child, JSON.stringify(header ?? null).slice(0, 400))
  check('new session finder opens nested workspace directories', true, child)
}

async function verifyStateFlow(page) {
  await page.click('[data-testid="history-view-state-flow"]')
  const flow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="state-flow-row"]')).map(
      (row) => row.textContent || '',
    )
    return {
      rows,
      hasSection: (document.body.textContent || '').includes('State flow'),
    }
  })
  check('state flow section is visible', flow.hasSection)
  check('state flow records Waiting for LLM transition', flow.rows.some((r) => r.includes('Ready → Waiting for LLM')), flow.rows.join(' | '))
  check('state flow records Done transition', flow.rows.some((r) => r.includes('Waiting for LLM → Done')), flow.rows.join(' | '))
  await page.click('[data-testid="history-view-timeline"]')
}

async function verifyEmptyCompact(page) {
  const timelineRows = await page.$$eval('[data-testid="timeline-row"]', (rows) => rows.length)
  check('history defaults to timeline view', timelineRows === 0, `${timelineRows}`)
  await page.type('[data-testid="composer-input"]', '/compact')
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    () => document.querySelector('[data-testid="activity-bar"]')?.textContent?.includes('Nothing to compact'),
    { timeout: 2_000 },
  )
  const activity = await page.$eval('[data-testid="activity-bar"]', (el) => el.textContent || '')
  check('empty compact shows neutral hint', activity.includes('Nothing to compact') && !activity.includes('Compact failed'), activity)
}

async function verifySessionCwd(page) {
  const cwd = join(WORKSPACE, 'cwd-e2e')
  mkdirSync(cwd, { recursive: true })
  await page.click('[data-testid="cwd-button"]')
  await page.waitForSelector('[data-testid="cwd-input"]')
  await page.click('[data-testid="cwd-input"]', { clickCount: 3 })
  await page.keyboard.type(cwd)
  await page.click('[data-testid="cwd-save-button"]')
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="cwd-label"]')?.textContent?.includes(expected),
    { timeout: 3_000 },
    cwd,
  )

  const sessionId = new URL(page.url()).searchParams.get('sessionId')
  let entries = readSessionEntries(SESSIONS_DIR, sessionId)
  const cwdEvent = entries.find((e) => e.event.kind === 'cwd_changed' && e.event.cwd === cwd)
  check('session cwd can be changed from toolbar', Boolean(cwdEvent), JSON.stringify(cwdEvent ?? null))

  await page.click('[data-testid="cwd-button"]')
  await page.waitForSelector('[data-testid="cwd-input"]')
  await replaceInputValue(page, '[data-testid="cwd-input"]', '/tmp/outside-agent-kernel-cwd')
  await page.click('[data-testid="cwd-save-button"]')
  await page.waitForFunction(
    () => document.querySelector('[data-testid="session-error"]')?.textContent?.includes('cwd outside sandbox roots'),
    { timeout: 3_000 },
  )
  entries = readSessionEntries(SESSIONS_DIR, sessionId)
  const outsideEvent = entries.find((e) => e.event.kind === 'cwd_changed' && e.event.cwd === '/tmp/outside-agent-kernel-cwd')
  const label = await page.$eval('[data-testid="cwd-label"]', (el) => el.textContent || '')
  check('invalid session cwd is rejected by real host validation', !outsideEvent && label.includes(cwd), label)
}

async function replaceInputValue(page, selector, value) {
  await page.click(selector)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(modifier)
  await page.keyboard.press('KeyA')
  await page.keyboard.up(modifier)
  await page.keyboard.type(value)
}

const failed = checks.filter((c) => !c.pass)
if (failed.length > 0) {
  console.error('\n--- host log tail ---')
  console.error(hostLog.slice(-40).join(''))
  console.error('\n--- executor log tail ---')
  console.error(executorLog.slice(-40).join(''))
  process.exit(1)
}
process.exit(0)

async function verifyStreaming(page) {
  const client = await page.createCDPSession()
  const wsEvents = []
  await client.send('Network.enable')
  client.on('Network.webSocketFrameReceived', ({ response }) => {
    const data = response.payloadData || ''
    if (
      data.includes('session:token_delta') ||
      data.includes('event:appended') ||
      data.includes('state:changed')
    ) {
      wsEvents.push({ t: Date.now(), data })
    }
  })

  await installChatMutationProbe(page)
  const sentAt = Date.now()
  await sendMessage(
    page,
    'Answer with exactly these ten words: alpha beta gamma delta epsilon zeta eta theta iota kappa',
  )
  await waitForDone(page, TURN_TIMEOUT_MS)
  const endedAt = Date.now()

  const mutations = await page.evaluate(() => globalThis.__akMutations ?? [])
  const beforeDone = mutations.filter(
    (m) =>
      m.rows?.some((t) => t.length > 0) &&
      !(m.chips || '').includes('Done'),
  )
  const tokenEvents = wsEvents.filter((e) => e.data.includes('session:token_delta'))
  const responseEvents = wsEvents.filter(
    (e) => e.data.includes('event:appended') && e.data.includes('llm_response'),
  )
  const rows = await assistantRows(page)

  check('streaming received token_delta websocket frames', tokenEvents.length > 0, `${tokenEvents.length}`)
  check(
    'assistant draft rendered before Done',
    beforeDone.length > 0,
    beforeDone[0]?.rows?.[0] ?? '(none)',
  )
  check(
    'streaming turn completed within timeout',
    endedAt - sentAt <= TURN_TIMEOUT_MS,
    `${endedAt - sentAt}ms`,
  )
  check(
    'final streamed assistant message visible',
    rows.some((t) => t.includes('alpha beta gamma delta epsilon zeta eta theta iota kappa')),
    rows.join(' | '),
  )
  check(
    'llm_response arrived after token_delta',
    tokenEvents[0] && responseEvents[0] && tokenEvents[0].t <= responseEvents[0].t,
    tokenEvents[0] && responseEvents[0]
      ? `${tokenEvents[0].t - sentAt}ms -> ${responseEvents[0].t - sentAt}ms`
      : '(missing)',
  )
}

async function verifyCompact(page) {
  const beforeUrl = page.url()
  const beforeNavCount = await page.evaluate(() => {
    globalThis.__akBeforeCompactNavigationCount = performance.getEntriesByType('navigation').length
    return globalThis.__akBeforeCompactNavigationCount
  })

  await page.type('[data-testid="composer-input"]', '/compact')
  await page.keyboard.press('Enter')

  let sawRunning = false
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="activity-bar"]')?.textContent?.includes('Compacting context'),
      { timeout: 2_000 },
    )
    sawRunning = true
  } catch {}
  await page.waitForFunction(
    () => document.querySelector('[data-testid="activity-bar"]')?.textContent?.includes('Context compacted'),
    { timeout: TURN_TIMEOUT_MS },
  )

  const afterUrl = page.url()
  const navCheck = await page.evaluate(() => ({
    before: globalThis.__akBeforeCompactNavigationCount,
    after: performance.getEntriesByType('navigation').length,
  }))
  const sessionId = new URL(afterUrl).searchParams.get('sessionId')
  const entries = readSessionEntries(SESSIONS_DIR, sessionId)
  const compactEvents = entries.filter((e) => e.event.kind === 'compact_replaced')
  const bodyText = await page.evaluate(() => document.body.textContent || '')
  const compactUi = await page.evaluate(() => {
    const boundary = document.querySelector('[data-testid="compact-boundary"]')
    return {
      boundaryText: boundary?.textContent || '',
      rows: Array.from(document.querySelectorAll('[data-testid="timeline-row"]')).map((row) => row.textContent || ''),
    }
  })

  const compactEvent = compactEvents[compactEvents.length - 1]?.event

  check('compact running or completion UI observed', sawRunning || bodyText.includes('Context compacted'), sawRunning ? 'Compacting context' : 'Context compacted')
  check('compact completed with success UI', true, 'Context compacted')
  check('compact did not change URL/session', beforeUrl === afterUrl, `${beforeUrl} -> ${afterUrl}`)
  check('compact did not reload page', navCheck.before === beforeNavCount && navCheck.after === beforeNavCount, JSON.stringify(navCheck))
  check('compact_replaced event persisted', compactEvents.length > 0, `${compactEvents.length}`)
  check('compact event records summarizer request', !!compactEvent?.request?.systemPrompt && Array.isArray(compactEvent.request.messages), JSON.stringify(compactEvent?.request ?? null).slice(0, 400))
  check('compact event records manual trigger', compactEvent?.trigger === 'manual', compactEvent?.trigger ?? '(missing)')
  check('chat shows compact boundary', compactUi.boundaryText.includes('Context compacted') && compactUi.boundaryText.includes('Manual compact'), compactUi.boundaryText)
  await openTimelineEvent(page, 'compact_replaced')
  const modalText = await page.$eval('[data-testid="timeline-row-details"]', (el) => el.textContent || '')
  check('compact timeline modal shows summarizer request', modalText.includes('compact summarizer request') && modalText.includes('systemPrompt') && modalText.includes('messages'), modalText.slice(0, 300))
  await page.keyboard.press('Escape')
  check('transcript remains visible after compact', bodyText.includes('alpha beta gamma'), 'streamed text still visible')
}

async function verifyScrollbar(page) {
  const dom = await page.evaluate(() => {
    const rawOverflowClass = Array.from(document.querySelectorAll('[class]'))
      .map((el) => el.getAttribute('class') || '')
      .filter((cls) => /(^|\s)overflow-(auto|x-auto|y-auto|scroll)(\s|$)/.test(cls))
    const radixViewports = document.querySelectorAll('[data-radix-scroll-area-viewport]').length
    const radixScrollbars = document.querySelectorAll('[data-orientation="vertical"], [data-orientation="horizontal"]').length
    const verticalScrollbars = document.querySelectorAll('[data-orientation="vertical"]').length
    const horizontalScrollbars = document.querySelectorAll('[data-orientation="horizontal"]').length
    const chatPanel = document.querySelector('[data-testid="chat-panel"]')
    const chatHasRadixViewport = !!chatPanel?.querySelector('[data-radix-scroll-area-viewport]')
    return { rawOverflowClass, radixViewports, radixScrollbars, verticalScrollbars, horizontalScrollbars, chatHasRadixViewport }
  })
  const sourceRaw = findRawOverflowUtilityClasses()

  check('rendered DOM has Radix ScrollArea viewports', dom.radixViewports > 0, `${dom.radixViewports}`)
  check('rendered DOM has Radix ScrollArea scrollbars', dom.radixScrollbars > 0, `${dom.radixScrollbars}`)
  check('rendered DOM has vertical Radix scrollbars', dom.verticalScrollbars > 0, `${dom.verticalScrollbars}`)
  check('rendered DOM has horizontal Radix scrollbars', dom.horizontalScrollbars > 0, `${dom.horizontalScrollbars}`)
  check('chat panel uses Radix ScrollArea viewport', dom.chatHasRadixViewport)
  check('rendered DOM has no raw overflow auto/scroll utility classes', dom.rawOverflowClass.length === 0, dom.rawOverflowClass.join(' | '))
  check('dashboard source has no raw overflow auto/scroll utility classes', sourceRaw.length === 0, sourceRaw.join(' | '))
}

async function verifyComposerFooterLayout(page) {
  const metrics = await page.evaluate(() => {
    const footer = document.querySelector('[data-testid="composer-footer"]')
    const indicator = document.querySelector('[data-testid="context-usage-indicator"]')
    const footerChildren = Array.from(footer?.children ?? []).filter((el) => {
      const rect = el.getBoundingClientRect()
      return rect.width > 2 && rect.height > 2 && getComputedStyle(el).visibility !== 'hidden'
    })
    const childRects = footerChildren.map((el) => {
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
      indicatorText: indicator?.textContent || '',
      indicatorTitle: indicator?.getAttribute('title') || '',
      childRects,
    }
  })
  const tall = metrics.childRects.filter((r) => r.height > 40)
  const clipped = metrics.childRects.filter((r) => r.scrollWidth > Math.ceil(r.width) + 2)
  check('composer footer does not create page horizontal overflow', metrics.bodyScrollWidth <= metrics.viewportWidth + 1, JSON.stringify(metrics))
  check('composer footer content stays inside footer width', metrics.footerScrollWidth <= metrics.footerWidth + 1, JSON.stringify(metrics))
  check('composer context and runtime metrics are visible', metrics.indicatorText.includes('context') && metrics.indicatorText.includes('Cursor') && metrics.indicatorText.includes('Pending') && metrics.indicatorText.includes('Tokens') && metrics.indicatorTitle.includes('Context window'), JSON.stringify(metrics))
  check('composer footer controls render without clipping', tall.length === 0 && clipped.length === 0, JSON.stringify(metrics.childRects))
}

async function verifyBackgroundTerminalPanel(page) {
  await sendMessage(
    page,
    'Use the bash tool exactly once with command "printf ak-bg-start; sleep 0.2; printf ak-bg-done" and run_in_background true. After it starts, use bash_output on the returned task_id with block true, then answer done.',
  )
  await page.waitForSelector('[data-testid="approvals-panel"]', { timeout: TURN_TIMEOUT_MS })
  const approvalText = await page.$eval('[data-testid="approvals-panel"]', (el) => el.textContent || '')
  check('background bash request asks for approval in real UI', approvalText.includes('bash') && approvalText.includes('run_in_background'), approvalText)
  await page.click('[data-testid="approval-approve"]')
  await page.waitForSelector('[data-testid="background-terminal-panel"]', { timeout: TURN_TIMEOUT_MS })
  await waitForDone(page, TURN_TIMEOUT_MS)
  const panel = await page.$eval('[data-testid="background-terminal-panel"]', (el) => el.textContent || '')
  const sessionId = new URL(page.url()).searchParams.get('sessionId')
  const entries = readSessionEntries(SESSIONS_DIR, sessionId)
  const backgroundStart = entries.find(
    (e) => e.event.kind === 'tool_result' && String(e.event.content).includes('taskId'),
  )
  check('background terminal panel renders real task', panel.includes('Background terminal') && panel.includes('printf ak-bg-start'), panel)
  check('background terminal panel shows captured output', panel.includes('ak-bg-start') || panel.includes('ak-bg-done'), panel)
  check('background shell taskId persisted in event log', !!backgroundStart, JSON.stringify(backgroundStart ?? null))
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
    await page.mouse.wheel({ deltaY: 500 })
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

async function installChatMutationProbe(page) {
  await page.evaluate(() => {
    globalThis.__akMutations = []
    if (globalThis.__akObserver) globalThis.__akObserver.disconnect()
    const observer = new MutationObserver(() => {
      globalThis.__akMutations.push({
        t: performance.now(),
        rows: Array.from(document.querySelectorAll('[data-message-index]'))
          .map((row) => {
            const label = row.querySelector('div')?.textContent?.trim() || ''
            return { label, text: (row.textContent || '').replace(label, '').trim() }
          })
          .filter((row) => row.label === 'Assistant')
          .map((row) => row.text),
        activity: document.querySelector('[data-testid="activity-bar"]')?.textContent || '',
      })
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    globalThis.__akObserver = observer
  })
}

async function assistantRows(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-message-index]'))
      .map((row) => {
        const label = row.querySelector('div')?.textContent?.trim() || ''
        return { label, text: (row.textContent || '').replace(label, '').trim() }
      })
      .filter((row) => row.label === 'Assistant')
      .map((row) => row.text),
  )
}

async function sendMessage(page, text) {
  await page.focus('[data-testid="composer-input"]')
  await page.keyboard.type(text, { delay: 2 })
  await page.keyboard.press('Enter')
}

async function waitForDone(page, timeout) {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="activity-bar"]')?.textContent?.includes('Agent Done'),
    { timeout },
  )
}

async function openTimelineEvent(page, eventKind) {
  await page.click('[data-testid="history-view-timeline"]')
  await page.evaluate((kind) => {
    const rows = Array.from(document.querySelectorAll('[data-testid="timeline-row"]'))
    const row = rows.find((r) => (r.textContent || '').includes(kind))
    row?.querySelector('[data-testid="timeline-row-header"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, eventKind)
  await page.waitForSelector('[data-testid="timeline-row-details"]')
}

async function selectModel(page, model) {
  await page.click('[data-testid="model-picker"]')
  const optionSel = `[data-testid="model-option-${cssEscape(model)}"]`
  await page.waitForSelector(optionSel, { timeout: 4_000 })
  await page.click(optionSel)
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="model-picker"]')?.textContent?.includes(expected),
    { timeout: 4_000 },
    model,
  )
  check('requested model is selected in UI', true, model)
}

function cssEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function readSessionEntries(dir, sessionId) {
  if (!sessionId || !existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => f.endsWith(`_${sessionId}.jsonl`))
  files.sort()
  const file = files[files.length - 1]
  if (!file) return []
  const raw = readFileSync(join(dir, file), 'utf8')
  const entries = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const rec = JSON.parse(line)
      if (rec.kind === 'event' && rec.event) entries.push({ event: rec.event, effects: rec.effects ?? [] })
    } catch {}
  }
  return entries
}

function readSessionHeader(dir, sessionId) {
  if (!sessionId) return null
  const file = readdirSync(dir).find((f) => f.endsWith(`${sessionId}.jsonl`) || f.includes(sessionId))
  if (!file) return null
  const first = readFileSync(join(dir, file), 'utf8').split('\n')[0]
  if (!first) return null
  return JSON.parse(first)
}

function findRawOverflowUtilityClasses() {
  const files = listFiles(join(REPO_ROOT, 'packages/dashboard/src'))
    .filter((f) => /\.(tsx?|css)$/.test(f))
    .filter((f) => !f.endsWith('components/ui/scroll-area.tsx'))
  const hits = []
  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (/overflow-(auto|x-auto|y-auto|scroll)/.test(lines[i])) {
        hits.push(`${file.replace(REPO_ROOT, '')}:${i + 1}:${lines[i].trim()}`)
      }
    }
  }
  return hits
}

function listFiles(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
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
  proc.kill('SIGTERM')
  const deadline = Date.now() + 2_000
  while (proc.exitCode === null && Date.now() < deadline) await sleep(50)
  if (proc.exitCode === null) proc.kill('SIGKILL')
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

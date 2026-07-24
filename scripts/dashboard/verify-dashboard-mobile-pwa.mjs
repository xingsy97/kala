#!/usr/bin/env node
/**
 * Dashboard mobile/PWA viewport regression check.
 *
 * This uses real Chrome against a built dashboard served by the real host. It
 * cannot emulate iOS Safari's keyboard perfectly, but it does verify the app's
 * browser-visible contract across desktop, mobile browser, and standalone PWA
 * display modes: one viewport-sized shell, no horizontal overflow, composer in
 * view, dialogs inside the visible viewport, and touch inputs at 16px+.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const requireFromHost = createRequire(new URL('../../packages/host/package.json', import.meta.url))
const { io } = requireFromHost('socket.io-client')
const { PROTOCOL_VERSION } = await import('../../packages/shared/dist/index.js')

const REPO_ROOT = new URL('../..', import.meta.url).pathname
const PORT = Number(process.env.VERIFY_MOBILE_PWA_PORT ?? 3186)
const HOST_URL = `http://localhost:${PORT}`
const SESSION_ID = `mobile-pwa-${Date.now()}`
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'agent-kernel-mobile-pwa-sessions-'))
const SHOTS_DIR = mkdtempSync(join(tmpdir(), 'agent-kernel-mobile-pwa-shots-'))
const CHROME = process.env.CHROME_PATH ?? detectBrowser()

const cases = [
  {
    name: 'desktop browser',
    viewport: { width: 1440, height: 820, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    standalone: false,
  },
  {
    name: 'mobile browser 320',
    viewport: { width: 320, height: 700, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    standalone: false,
    fullSettings: false,
  },
  {
    name: 'mobile browser 375',
    viewport: { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    standalone: false,
    fullSettings: false,
  },
  {
    name: 'mobile browser 390',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    standalone: false,
    fullSettings: true,
  },
  {
    name: 'mobile browser 430',
    viewport: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    standalone: false,
    fullSettings: false,
  },
  {
    name: 'standalone PWA',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    standalone: true,
    fullSettings: true,
  },
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
  writeSessionFixture()
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'], { name: 'dashboard build', timeoutMs: 45_000 })

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
  await waitForLog(hostLog, `127.0.0.1:${PORT}`, 10_000)
  await verifyHostListsFixture()

  if (!CHROME) throw new Error('no chromium found; set CHROME_PATH')
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })

  for (const scenario of cases) {
    await verifyScenario(scenario)
  }
  console.log(`Screenshots written to ${SHOTS_DIR}`)
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

async function verifyScenario(scenario) {
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  await page.setViewport(scenario.viewport)
  if (scenario.viewport.isMobile) {
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')
  }
  const client = await page.target().createCDPSession()
  await client.send('Network.setBypassServiceWorker', { bypass: false })
  await client.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'display-mode', value: scenario.standalone ? 'standalone' : 'browser' },
      { name: 'prefers-color-scheme', value: 'dark' },
    ],
  })
  await page.goto(`${HOST_URL}/?sessionId=${SESSION_ID}`, { waitUntil: 'networkidle2', timeout: 20_000 })
  await ensureFixtureSessionSelected(page)
  await page.waitForSelector('[data-testid="composer"]')
  await sleep(250)
  await verifyViewportContract(page, scenario.name)
  await verifyDotsToolActivity(page, scenario.name)
  await focusComposerAndVerify(page, scenario.name)
  await verifySettingsDialog(page, scenario.name, scenario.fullSettings !== false)
  if (scenario.name === 'desktop browser') {
    await verifyToolCardModePreference(page, scenario.name)
    await verifyInspectorDefaults(page, scenario.name)
  }
  await page.screenshot({ path: join(SHOTS_DIR, `${slug(scenario.name)}.png`), fullPage: false })
  await page.close()
}

async function verifyDotsToolActivity(page, name) {
  await page.waitForSelector('[data-testid="tool-card-dots-mobile-tool-0"]')
  const metrics = await page.evaluate(() => {
    const rails = Array.from(document.querySelectorAll('[data-testid^="tool-card-dots-"]'))
    const rail = rails[0]
    const rect = rail?.getBoundingClientRect()
    const chat = document.querySelector('[data-testid="chat-panel"]')
    return {
      railCount: rails.length,
      dotCount: rail?.querySelectorAll('[data-testid^="tool-card-dot-"]').length ?? 0,
      hasToolActivityLabel: (chat?.textContent ?? '').includes('Tool activity'),
      narrationCount: Array.from(chat?.querySelectorAll('.ak-chat-text') ?? [])
        .filter((node) => node.textContent?.startsWith('Inspect fixture file')).length,
      assistantAvatarCount: chat?.querySelectorAll('[aria-label="Assistant"]').length ?? 0,
      directionVisible: Boolean(rail?.querySelector('[data-testid="tool-activity-direction"]')),
      rail: rect ? { left: rect.left, right: rect.right, width: rect.width, height: rect.height } : null,
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    }
  })
  check(`${name}: narrated tool turns render as one short chronological dots rail`, metrics.railCount === 1 && metrics.dotCount === 6 && metrics.narrationCount === 6 && metrics.assistantAvatarCount === 1 && metrics.directionVisible && (metrics.rail?.width ?? Number.POSITIVE_INFINITY) <= 220 && !metrics.hasToolActivityLabel, JSON.stringify(metrics))
  check(`${name}: dots rail stays inside the viewport`, Boolean(metrics.rail) && metrics.rail.left >= -1 && metrics.rail.right <= metrics.viewportWidth + 1 && metrics.documentScrollWidth <= metrics.viewportWidth + 1, JSON.stringify(metrics))

  await page.click('[data-testid="tool-card-dot-mobile-tool-2"]')
  await page.waitForSelector('[data-testid="tool-call-group-details-mobile-tool-0"]')
  const expanded = await page.evaluate(() => {
    const details = document.querySelector('[data-testid="tool-call-group-details-mobile-tool-0"]')
    const rect = details?.getBoundingClientRect()
    return {
      rect: rect ? { left: rect.left, right: rect.right, width: rect.width } : null,
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    }
  })
  check(`${name}: expanded tool details stay width-bounded`, Boolean(expanded.rect) && expanded.rect.left >= -1 && expanded.rect.right <= expanded.viewportWidth + 1 && expanded.documentScrollWidth <= expanded.viewportWidth + 1, JSON.stringify(expanded))
  await page.screenshot({ path: join(SHOTS_DIR, `${slug(name)}-tool-dots-expanded.png`), fullPage: false })
  await page.click('[data-testid="tool-call-group-toggle-mobile-tool-0"]')
}

async function verifyViewportContract(page, name) {
  const metrics = await page.evaluate(() => {
    const root = document.getElementById('root')
    const shell = document.querySelector('.ak-app-shell')
    const composer = document.querySelector('[data-testid="composer"]')
    const toolbar = document.querySelector('[data-testid="workbench-toolbar"]')
    const chat = document.querySelector('[data-testid="chat-panel"]')
    const rectFor = (el) => {
      const rect = el?.getBoundingClientRect()
      return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height } : null
    }
    const inputFontSizes = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'))
      .map((el) => Number.parseFloat(getComputedStyle(el).fontSize))
      .filter(Number.isFinite)
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualViewportHeight: window.visualViewport?.height ?? null,
      cssViewportH: getComputedStyle(document.documentElement).getPropertyValue('--ak-viewport-h').trim(),
      keyboard: document.documentElement.dataset.akKeyboard ?? null,
      bodyScrollWidth: document.documentElement.scrollWidth,
      root: rectFor(root),
      shell: rectFor(shell),
      composer: rectFor(composer),
      toolbar: rectFor(toolbar),
      chat: rectFor(chat),
      minInputFontSize: inputFontSizes.length > 0 ? Math.min(...inputFontSizes) : null,
    }
  })
  const expectedHeight = metrics.visualViewportHeight ?? metrics.innerHeight
  check(`${name}: app shell uses visible viewport height`, Math.abs(metrics.shell?.height - expectedHeight) <= 2, JSON.stringify(metrics))
  check(`${name}: document has no horizontal overflow`, metrics.bodyScrollWidth <= metrics.innerWidth + 1, JSON.stringify(metrics))
  check(`${name}: composer remains inside visible viewport`, Boolean(metrics.composer) && metrics.composer.bottom <= expectedHeight + 1 && metrics.composer.top >= -1, JSON.stringify(metrics))
  check(`${name}: toolbar and chat keep vertical order`, Boolean(metrics.toolbar && metrics.chat && metrics.composer) && metrics.toolbar.bottom <= metrics.chat.top + 1 && metrics.chat.bottom <= metrics.composer.top + 1, JSON.stringify(metrics))
  if (metrics.innerWidth < 600) {
    check(`${name}: touch form controls avoid iOS focus zoom`, metrics.minInputFontSize === null || metrics.minInputFontSize >= 16, JSON.stringify(metrics))
  }
}

async function focusComposerAndVerify(page, name) {
  const target = await page.$('[data-testid="composer-input-simple"], [data-testid="composer-input"]')
  if (!target) {
    check(`${name}: focusable composer input exists`, false)
    return
  }
  await target.click()
  await sleep(250)
  const metrics = await page.evaluate(() => {
    const shell = document.querySelector('.ak-app-shell')
    const composer = document.querySelector('[data-testid="composer"]')
    const active = document.activeElement
    const rectFor = (el) => {
      const rect = el?.getBoundingClientRect()
      return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null
    }
    return {
      activeTag: active?.tagName ?? '',
      activeIsContentEditable: active?.isContentEditable ?? false,
      activeFontSize: active ? Number.parseFloat(getComputedStyle(active).fontSize) : null,
      innerHeight: window.innerHeight,
      visualViewportHeight: window.visualViewport?.height ?? null,
      shell: rectFor(shell),
      composer: rectFor(composer),
      keyboard: document.documentElement.dataset.akKeyboard ?? null,
    }
  })
  const focusedFormControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(metrics.activeTag) || metrics.activeIsContentEditable === true
  check(`${name}: composer input receives focus`, focusedFormControl, JSON.stringify(metrics))
  const expectedHeight = metrics.visualViewportHeight ?? metrics.innerHeight
  check(`${name}: focused app shell still matches visible viewport`, Math.abs(metrics.shell?.height - expectedHeight) <= 2, JSON.stringify(metrics))
  check(`${name}: focused composer remains visible`, Boolean(metrics.composer) && metrics.composer.bottom <= expectedHeight + 1 && metrics.composer.top >= -1, JSON.stringify(metrics))
  if (name !== 'desktop browser') {
    check(`${name}: focused form control is mobile zoom-safe`, focusedFormControl && metrics.activeFontSize !== null && metrics.activeFontSize >= 16, JSON.stringify(metrics))
  }
}

async function verifySettingsDialog(page, name, fullSettings) {
  await page.keyboard.press('Escape')
  await sleep(100)
  await page.click('[data-testid="app-shell-nav-settings-icon"]')
  await page.waitForSelector('[data-testid="settings-dialog"]')
  await sleep(150)
  const metrics = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-dialog"]')
    const rect = el?.getBoundingClientRect()
    return rect ? {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.visualViewport?.height ?? window.innerHeight,
    } : null
  })
  check(`${name}: settings dialog fits visible viewport`, Boolean(metrics) && metrics.top >= -1 && metrics.left >= -1 && metrics.right <= metrics.viewportWidth + 1 && metrics.bottom <= metrics.viewportHeight + 1, JSON.stringify(metrics))

  const sections = fullSettings ? ['runtime', 'deployment', 'security', 'socketAdmin', 'hooks'] : []
  for (const section of sections) {
    await page.click(`[data-testid="settings-tab-${section}"]`)
    await sleep(100)
    const contentMetrics = await page.evaluate(() => {
      const content = document.querySelector('[data-testid="settings-responsive-content"]')
      if (!content) return null
      const contentRect = content.getBoundingClientRect()
      const overflowingDescendants = Array.from(content.querySelectorAll('*')).flatMap((element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return []
        const escapesContent = rect.left < contentRect.left - 1 || rect.right > contentRect.right + 1
        if (!escapesContent) return []
        return [{
          tag: element.tagName,
          testId: element.getAttribute('data-testid'),
          className: typeof element.className === 'string' ? element.className.slice(0, 100) : '',
          left: rect.left,
          right: rect.right,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }]
      })
      const ancestors = []
      let current = content.parentElement
      while (current && ancestors.length < 8) {
        const rect = current.getBoundingClientRect()
        ancestors.push({
          tag: current.tagName,
          className: typeof current.className === 'string' ? current.className.slice(0, 100) : '',
          width: rect.width,
          clientWidth: current.clientWidth,
          scrollWidth: current.scrollWidth,
          display: getComputedStyle(current).display,
        })
        current = current.parentElement
      }
      return {
        clientWidth: content.clientWidth,
        scrollWidth: content.scrollWidth,
        viewportClientWidth: content.parentElement?.clientWidth ?? 0,
        viewportScrollWidth: content.parentElement?.scrollWidth ?? 0,
        overflowingDescendants: overflowingDescendants.slice(0, 8),
        ancestors,
      }
    })
    check(
      `${name}: ${section} settings stay width-bounded`,
      Boolean(contentMetrics)
        && contentMetrics.scrollWidth <= contentMetrics.clientWidth + 1
        && contentMetrics.clientWidth <= contentMetrics.viewportClientWidth + 1
        && contentMetrics.viewportScrollWidth <= contentMetrics.viewportClientWidth + 1
        && contentMetrics.overflowingDescendants.length === 0,
      JSON.stringify(contentMetrics),
    )
  }
  if (fullSettings) {
    await page.click('[data-testid="settings-tab-interface"]')
    await page.waitForSelector('[data-testid="settings-toggle-durable-session-cache"]')
    const interfaceControls = await page.evaluate(() => ({
      durable: Boolean(document.querySelector('[data-testid="settings-toggle-durable-session-cache"]')),
      wakeLock: Boolean(document.querySelector('[data-testid="settings-toggle-keep-screen-awake"]')),
      cacheManagement: Boolean(document.querySelector('[data-testid="settings-session-cache-management"]')),
    }))
    check(`${name}: browser capability controls are exposed`, interfaceControls.durable && interfaceControls.wakeLock && interfaceControls.cacheManagement, JSON.stringify(interfaceControls))
    await page.click('[data-testid="settings-tab-notifications"]')
    await page.waitForSelector('[data-testid="settings-toggle-app-badge"]')
    check(`${name}: app badge control is exposed`, Boolean(await page.$('[data-testid="settings-toggle-app-badge"]')))
  }
  await page.screenshot({ path: join(SHOTS_DIR, `${slug(name)}-settings.png`), fullPage: false })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="settings-dialog"]'))
}

async function verifyInspectorDefaults(page, name) {
  const toggle = await page.$('[data-testid="state-diff-toggle"]')
  if (!toggle) {
    check(`${name}: inspector state diff control exists`, false)
    return
  }
  const metrics = await page.evaluate(() => {
    const control = document.querySelector('[data-testid="state-diff-toggle"]')
    const replay = document.querySelector('[data-testid="replay-panel"]')
    return {
      expanded: control?.getAttribute('aria-expanded'),
      bodyVisible: Boolean(document.querySelector('[data-testid="state-diff-view"]')),
      summary: replay?.textContent ?? '',
    }
  })
  check(`${name}: state diff starts collapsed with change count visible`, metrics.expanded === 'false' && !metrics.bodyVisible && metrics.summary.includes('changes'), JSON.stringify(metrics))
}

async function verifyToolCardModePreference(page, name) {
  const infoButton = await page.$('[data-testid="session-info-button"]')
  if (!infoButton) {
    check(`${name}: session info control exists`, false)
    return
  }

  await infoButton.click()
  await page.waitForSelector('[data-testid="session-metadata-dialog"]')
  const modeTrigger = '[data-testid="session-metadata-tool-card-mode"]'
  const initialMode = await page.$eval(modeTrigger, (element) => element.textContent?.trim() ?? '')
  check(`${name}: Tool Card Mode defaults to Dots`, initialMode === 'Dots', initialMode)

  await page.click(modeTrigger)
  await page.waitForSelector('[role="option"]')
  const selected = await page.evaluate(() => {
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .find((element) => element.textContent?.trim() === 'Standard')
    if (!(option instanceof HTMLElement)) return false
    option.click()
    return true
  })
  check(`${name}: Standard Tool Card Mode option is available`, selected)
  await page.click('[data-testid="session-metadata-save"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="session-metadata-dialog"]'))
  await sleep(150)

  await infoButton.click()
  await page.waitForSelector('[data-testid="session-metadata-dialog"]')
  const persistedMode = await page.$eval(modeTrigger, (element) => element.textContent?.trim() ?? '')
  check(`${name}: Tool Card Mode persists after save`, persistedMode === 'Standard', persistedMode)
  await page.screenshot({ path: join(SHOTS_DIR, `${slug(name)}-tool-card-mode.png`), fullPage: false })

  await page.click(modeTrigger)
  await page.waitForSelector('[role="option"]')
  await page.evaluate(() => {
    const option = Array.from(document.querySelectorAll('[role="option"]'))
      .find((element) => element.textContent?.trim() === 'Dots')
    if (option instanceof HTMLElement) option.click()
  })
  await page.click('[data-testid="session-metadata-save"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="session-metadata-dialog"]'))
}

function writeSessionFixture() {
  const config = { tools: [], systemPrompt: 'mobile PWA layout fixture' }
  const initialState = {
    sessionId: SESSION_ID,
    messages: [{ role: 'system', content: [{ type: 'text', text: config.systemPrompt }] }],
    pendingCalls: [],
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0 },
    cursor: 0,
    cwd: '/tmp/agent-runlab-mobile',
    contextPressureLevel: 'none',
    approvalMode: 'auto',
  }
  const entries = [
    {
      kind: 'header',
      seq: 0,
      ts: new Date().toISOString(),
      sessionId: SESSION_ID,
      initialCwd: '/tmp/agent-runlab-mobile',
      formatVersion: 1,
      kernelVersion: '0.0.0',
      config,
      initialState,
    },
    {
      kind: 'event',
      seq: 1,
      ts: new Date().toISOString(),
      event: { kind: 'user_message', text: 'Check the mobile layout.' },
      effects: [{ kind: 'call_llm', messages: [], tools: [] }],
    },
    ...Array.from({ length: 6 }, (_, index) => {
      const callId = `mobile-tool-${index}`
      const responseSeq = 2 + index * 2
      return [
        {
          kind: 'event',
          seq: responseSeq,
          ts: new Date().toISOString(),
          event: {
            kind: 'llm_response',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: `Inspect fixture file ${index}.` },
                { type: 'tool_call', callId, name: 'read', input: { path: `/tmp/agent-runlab-mobile/file-${index}.ts` } },
              ],
            },
            usage: { inputTokens: 42 + index, outputTokens: 18 },
          },
          effects: [{ kind: 'call_tool', callId, name: 'read', input: { path: `/tmp/agent-runlab-mobile/file-${index}.ts` } }],
        },
        {
          kind: 'event',
          seq: responseSeq + 1,
          ts: new Date().toISOString(),
          event: { kind: 'tool_result', callId, ok: true, content: `line ${index + 1}` },
          effects: [{ kind: 'call_llm', messages: [], tools: [] }],
        },
      ]
    }).flat(),
    {
      kind: 'event',
      seq: 14,
      ts: new Date().toISOString(),
      event: {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The dashboard should keep the composer visible without horizontal overflow on mobile and PWA surfaces.' }],
        },
        usage: { inputTokens: 48, outputTokens: 18 },
      },
      effects: [{ kind: 'finish' }],
    },
  ]
  mkdirSync(SESSIONS_DIR, { recursive: true })
  writeFileSync(join(SESSIONS_DIR, `${Date.now()}_${SESSION_ID}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

async function verifyHostListsFixture() {
  const socket = io(`${HOST_URL}/dashboard`, {
    transports: ['websocket'],
    auth: { sessionId: SESSION_ID, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
    check('host lists mobile PWA fixture session', sessions.some((s) => s.sessionId === SESSION_ID), JSON.stringify(sessions))
  } finally {
    socket.close()
  }
}

async function ensureFixtureSessionSelected(page) {
  await page.waitForSelector('[data-testid="workbench-toolbar"]', { timeout: 10_000 })
  const hasComposer = await page.$('[data-testid="composer"]')
  if (hasComposer) return
  const row = await page.$(`[data-testid="session-row"][data-session-id="${SESSION_ID}"]`)
  if (row) await row.click()
}

function detectBrowser() {
  const candidates = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium']
  for (const path of candidates) if (existsSync(path)) return path
  return undefined
}

function pipeLog(child, out) {
  child.stdout?.on('data', (chunk) => out.push(String(chunk)))
  child.stderr?.on('data', (chunk) => out.push(String(chunk)))
}

async function waitForLog(lines, needle, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (lines.join('').includes(needle)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for host log: ${needle}`)
}

async function run(cmd, args, { name, timeoutMs }) {
  const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  const code = await new Promise((resolve) => child.on('exit', resolve))
  clearTimeout(timer)
  if (code !== 0) throw new Error(`${name} failed with ${code}`)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await sleep(300)
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const requireFromHost = createRequire(new URL('../../packages/host/package.json', import.meta.url))
const { io } = requireFromHost('socket.io-client')
const { PROTOCOL_VERSION } = await import('../packages/shared/dist/index.js')

const repo = new URL('../..', import.meta.url).pathname
const port = Number(process.env.VERIFY_DEBUGGER_PORT ?? 3197)
const sessionId = 'debugger-ui-fixture'
const sessionsDir = mkdtempSync(join(tmpdir(), 'ak-debugger-sessions-'))
const shotsDir = mkdtempSync(join(tmpdir(), 'ak-debugger-shots-'))
const hostLog = []
let host
let browser

function log(msg) { console.log(msg) }
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
  if (!pass) throw new Error(`${name}: ${detail}`)
}
function rgbDistance(a, b) {
  return Math.sqrt(
    Math.pow(a.r - b.r, 2) +
    Math.pow(a.g - b.g, 2) +
    Math.pow(a.b - b.b, 2),
  )
}
function describeRgb(c) {
  return `rgb(${c.r}, ${c.g}, ${c.b})`
}
function pipe(proc) {
  proc.stdout.on('data', b => hostLog.push(b.toString()))
  proc.stderr.on('data', b => hostLog.push(b.toString()))
}
async function waitForLog(needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hostLog.join('').includes(needle)) return
    await sleep(100)
  }
  throw new Error(`timeout waiting for ${needle}\n${hostLog.join('')}`)
}
async function stop(proc) {
  if (!proc || proc.exitCode !== null) return
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    proc.kill('SIGTERM')
  }
  const deadline = Date.now() + 2000
  while (proc.exitCode === null && Date.now() < deadline) await sleep(50)
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}

async function verifyHostListsFixture() {
  const socket = io(`http://localhost:${port}/dashboard`, {
    transports: ['websocket'],
    auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5000)
      socket.on('connect', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
      socket.on('connect_error', reject)
    })
    const sessions = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client:list_sessions timeout')), 5000)
      socket.once('server:sessions', (payload) => {
        clearTimeout(timer)
        resolve(payload.sessions ?? [])
      })
      socket.emit('client:list_sessions', {})
    })
    check(
      'host lists debugger fixture session',
      sessions.some((s) => s.sessionId === sessionId),
      JSON.stringify(sessions),
    )
  } finally {
    socket.close()
  }
}

function writeFixture() {
  const config = {
    tools: [
      {
        name: 'edit',
        description: 'Replace exact text in a workspace file.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['path', 'oldText', 'newText'],
          properties: {
            path: { type: 'string' },
            oldText: { type: 'string' },
            newText: { type: 'string' },
          },
        },
      },
      {
        name: 'read',
        description: 'Read a UTF-8 file from the workspace.',
        requiresApproval: false,
        inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      },
    ],
    systemPrompt: 'You are Codex, a coding agent based on GPT-5.',
    contextLimit: 128000,
  }
  const initialState = {
    sessionId,
    messages: [{ role: 'system', content: [{ type: 'text', text: config.systemPrompt }] }],
    pendingCalls: [],
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    cursor: 0,
    memory: [
      { key: 'project_goal', content: 'Keep kernel pure; host owns LLM/event log; executor owns workspace tools.', updatedAt: '2026-07-06T14:22:18.000Z' },
      { key: 'ui_debugger_preference', content: 'Show reducer transitions, LLM calls, tool lifecycle, and raw JSON without making the panel look like an unstyled dump.', updatedAt: '2026-07-06T14:41:03.000Z' },
    ],
    cwd: repo,
    contextPressureLevel: 'soft',
    approvalMode: 'ask',
  }
  const callId = 'toolu_01J4Z7K9V2N8Q5M3B1C6D0E4'
  const llmRequestMessages = [
    ...initialState.messages,
    { role: 'user', content: [{ type: 'text', text: 'Fix executor relative paths so they follow cwd.' }] },
  ]
  const entries = [
    { kind: 'header', seq: 0, ts: '2026-07-06T06:00:00.000Z', sessionId, formatVersion: 1, kernelVersion: '0.0.0', config, initialState, initialCwd: repo },
    { kind: 'event', seq: 1, ts: '2026-07-06T06:00:01.000Z', event: { kind: 'user_message', text: 'Fix executor relative paths so they follow cwd.' }, effects: [{ kind: 'call_llm', messages: llmRequestMessages, tools: config.tools }] },
    { kind: 'event', seq: 2, ts: '2026-07-06T06:00:02.000Z', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId, name: 'edit', input: { path: 'packages/executor/src/sandbox.ts', oldText: 'const base = canonicalRoots[0] ?? process.cwd()', newText: 'const base = opts?.cwd ?? canonicalRoots[0] ?? process.cwd()' } }] }, usage: { inputTokens: 42180, outputTokens: 614, cacheCreationTokens: 0, cacheReadTokens: 32000 } }, effects: [{ kind: 'request_approval', callId, name: 'edit', input: { path: 'packages/executor/src/sandbox.ts' } }], llmTrace: { provider: 'anthropic', model: 'claude-sonnet-4-6', request: { url: 'https://api.anthropic.com/v1/messages', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'test-redacted-api-key' }, body: { model: 'claude-sonnet-4-6', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix executor relative paths so they follow cwd.' }] }], tools: [{ name: 'edit', description: 'Replace exact text in a workspace file.', input_schema: config.tools[0].inputSchema }] } }, response: { status: 200, streamEventTypes: ['message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'message_stop'], body: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'edit', input: { path: 'packages/executor/src/sandbox.ts' } }] } } } },
    { kind: 'event', seq: 3, ts: '2026-07-06T06:00:03.000Z', event: { kind: 'user_approve', callId }, effects: [{ kind: 'call_tool', callId, name: 'edit', input: { path: 'packages/executor/src/sandbox.ts' } }] },
    { kind: 'event', seq: 4, ts: '2026-07-06T06:00:04.000Z', event: { kind: 'tool_result', callId, ok: true, content: 'Applied patch to packages/executor/src/sandbox.ts' }, effects: [{ kind: 'call_llm', messages: [], tools: config.tools }] },
  ]
  const path = join(sessionsDir, `fixture_${sessionId}.jsonl`)
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return path
}

try {
  const fixturePath = writeFixture()
  console.log('fixture written', { sessionsDir, fixturePath })
  host = spawn('pnpm', ['--filter', '@agent-kernel/host', 'dev'], {
    cwd: repo,
    env: { ...process.env, HOST_PORT: String(port), SESSIONS_DIR: sessionsDir, DASHBOARD_DIR: join(repo, 'packages/dashboard/dist') },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipe(host)
  await waitForLog(`"port":${port}`, 10000)
  await verifyHostListsFixture()
  browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.evaluate(() => window.localStorage.clear())
  await page.goto(`http://localhost:${port}/?sessionId=${sessionId}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await ensureFixtureSessionSelected(page)
  await page.waitForSelector('[data-testid="inspector-sidebar-tab-trace"]', { timeout: 15000 })
  await page.click('[data-testid="inspector-sidebar-tab-trace"]')
  try {
    await page.waitForSelector('[data-testid="trace-toolbar"]', { timeout: 15000 })
  } catch (err) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      body: document.body.textContent?.slice(0, 2000) ?? '',
      hasInspectorToggle: Boolean(document.querySelector('[data-testid="app-shell-nav-inspector-icon"]')),
      hasInspectorPanel: Boolean(document.querySelector('[data-testid="inspector-panel"]')),
      rows: Array.from(document.querySelectorAll('[data-testid="session-row"]')).map((e) => ({
        id: e.getAttribute('data-session-id'),
        text: e.textContent?.slice(0, 200),
      })),
      errors: Array.from(document.querySelectorAll('[data-testid="session-error"]')).map((e) => e.textContent),
    }))
    throw new Error(`debugger selector missing: ${JSON.stringify({ ...diag, hostLog: hostLog.join('').slice(-4000) })}`, { cause: err })
  }
  await verifySurfaceContrast(page, 'dark')
  await page.screenshot({ path: join(shotsDir, '01-debugger-reducer.png'), fullPage: false })
  const reducerText = await page.$eval('[data-testid="inspector-view-panel-trace"]', el => el.textContent || '')
  check('reducer trace shows state transition', reducerText.includes('idle → thinking') && reducerText.includes('request_approval'), reducerText.slice(0, 300))
  check(
    'trace advanced controls render',
    ['List', 'Flow', 'Compare'].every((s) => reducerText.includes(s)) &&
      Boolean(await page.$('[data-testid="timeline-minimap"]')) &&
      Boolean(await page.$('[data-testid="replay-panel"]')) &&
      Boolean(await page.$('[data-testid="state-diff-view"]')),
    reducerText.slice(0, 300),
  )
  await page.$eval('[data-testid="teaching-mode-toggle"]', (el) => el.click())
  await page.waitForFunction(() => (document.querySelector('[data-testid="inspector-view-panel-trace"]')?.textContent || '').includes('state machine moves'))
  const teachingText = await page.$eval('[data-testid="inspector-view-panel-trace"]', el => el.textContent || '')
  check('teaching mode explains state machine protocol', teachingText.includes('state machine moves') && teachingText.includes('output actions'), teachingText.slice(0, 300))
  await page.$eval('[data-testid="trace-mode-switch-flow"]', (el) => el.click())
  await page.waitForSelector('[data-testid="protocol-flow-view"]')
  const flowText = await page.$eval('[data-testid="protocol-flow-view"]', el => el.textContent || '')
  check('protocol flow view shows event state machine action lanes', flowText.includes('Input Event') && flowText.includes('State Machine') && flowText.includes('Output Actions') && flowText.includes('call_tool'), flowText.slice(0, 300))
  await page.$eval('[data-testid="trace-mode-switch-list"]', (el) => el.click())
  // Theme control moved from top-bar toggle into Settings → Interface. Open
  // Settings via the nav icon, flip to light, close, then flip back to dark.
  await page.$eval('[data-testid="app-shell-nav-settings-icon"]', (el) => el.click())
  await page.waitForSelector('[data-testid="settings-tab-interface"]')
  await page.$eval('[data-testid="settings-tab-interface"]', (el) => el.click())
  await page.waitForSelector('[data-testid="settings-theme-light"]')
  await page.$eval('[data-testid="settings-theme-light"]', (el) => el.click())
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
  await verifySurfaceContrast(page, 'light')
  await page.screenshot({ path: join(shotsDir, '01-debugger-reducer-light.png'), fullPage: false })
  await page.$eval('[data-testid="settings-theme-dark"]', (el) => el.click())
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
  await page.keyboard.press('Escape')
  await page.$eval('[data-testid="inspector-sidebar-tab-llm"]', (el) => el.click())
  await page.waitForSelector('[data-testid="llm-call-row"]')
  await page.$eval('[data-testid="llm-call-row"]', (el) => el.click())
  await page.waitForSelector('[data-testid="llm-detail"]')
  await page.waitForSelector('[data-testid="message-assembler-view"]')
  await page.screenshot({ path: join(shotsDir, '02-debugger-llm.png'), fullPage: false })
  const llmAssemblyText = await page.$eval('[data-testid="llm-assembly-view"]', el => el.textContent || '')
  check('llm detail explains message assembly', llmAssemblyText.includes('System Prompt') && llmAssemblyText.includes('Kernel Messages') && llmAssemblyText.includes('Adapter Transform'), llmAssemblyText.slice(0, 300))
  check('message assembler does not duplicate captured API body', !llmAssemblyText.includes('Captured API Request') && !llmAssemblyText.includes('Captured API Response'), llmAssemblyText.slice(0, 300))
  await page.waitForSelector('[data-testid="context-proportion-bar"]')
  const contextCompositionText = await page.$eval('[data-testid="context-proportion-bar"]', el => el.textContent || '')
  check('message assembler shows context contribution proportions', ['System', 'User', 'Tool registry'].every((s) => contextCompositionText.includes(s)) && /\d+%/.test(contextCompositionText), contextCompositionText.slice(0, 300))
  await page.$eval('[data-testid="context-proportion-segment-tools"]', (el) => el.click())
  await page.waitForSelector('[data-testid="tool-registry-context-view"]')
  const toolRegistryText = await page.$eval('[data-testid="tool-registry-context-view"]', el => el.textContent || '')
  check('context tools segment opens tool registry details', toolRegistryText.includes('edit') && toolRegistryText.includes('read') && toolRegistryText.includes('Tool Schema'), toolRegistryText.slice(0, 300))
  check('selected tools context highlights registry rows', await page.$$eval('[data-testid="llm-tool-row"][data-highlighted="true"]', rows => rows.length) >= 2)
  await page.$eval('[data-testid="context-proportion-segment-user"]', (el) => el.click())
  await page.waitForSelector('[data-testid="kernel-messages-view"]')
  check('selected user context highlights matching kernel messages', await page.$$eval('[data-testid="kernel-message-row"][data-highlighted="true"]', rows => rows.length) >= 1)
  await page.waitForSelector('[data-testid="kernel-messages-view"]')
  const kernelMessagesText = await page.$eval('[data-testid="kernel-messages-view"]', el => el.textContent || '')
  check('llm detail shows kernel messages', kernelMessagesText.includes('user') && kernelMessagesText.includes('Fix executor'), kernelMessagesText.slice(0, 300))
  await page.$eval('[data-testid="llm-detail-view-switch-api"]', (el) => el.click())
  await page.waitForSelector('[data-testid="api-call-view"]')
  await page.waitForSelector('[data-testid="api-request-view"]')
  await page.waitForSelector('[data-testid="api-response-view"]')
  const apiText = await page.$eval('[data-testid="api-call-view"]', el => el.textContent || '')
  check('llm detail shows captured API request and response', apiText.includes('Captured API Request') && apiText.includes('Captured API Response') && apiText.includes('Parsed Kernel Response') && apiText.includes('test-redacted-api-key'), apiText.slice(0, 300))
  check('llm API summary strip renders', apiText.includes('request keys') && apiText.includes('stream events') && apiText.includes('HTTP trace'), apiText.slice(0, 300))
  const requestPaneText = await page.$eval('[data-testid="api-request-view"]', el => el.textContent || '')
  const responsePaneText = await page.$eval('[data-testid="api-response-view"]', el => el.textContent || '')
  check('API request body is only in request pane', requestPaneText.includes('Captured API Request') && requestPaneText.includes('messages') && !responsePaneText.includes('Captured API Request'), requestPaneText.slice(0, 300))
  check('API response stays separate from request pane', responsePaneText.includes('Captured API Response') && responsePaneText.includes('Parsed Kernel Response') && !requestPaneText.includes('Captured API Response'), responsePaneText.slice(0, 300))
  check('API call redacts concrete provider base URL', !apiText.includes('https://api.anthropic.com') && apiText.includes('https://<redacted>'), apiText.slice(0, 400))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="llm-detail"]'))
  await page.$eval('[data-testid="inspector-sidebar-tab-tools"]', (el) => el.click())
  await page.waitForSelector('[data-testid="tool-call-row"]')
  await page.$eval('[data-testid="tool-call-row"]', (el) => el.click())
  await page.waitForSelector('[data-testid="tool-detail"]')
  await page.screenshot({ path: join(shotsDir, '03-debugger-tool.png'), fullPage: false })
  const toolText = await page.$eval('[data-testid="tool-detail"]', el => el.textContent || '')
  check('tool detail shows lifecycle raw data', toolText.includes('Tool Input') && toolText.includes('Tool Result Event'), toolText.slice(0, 300))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="tool-detail"]'))
  await page.$eval('[data-testid="inspector-sidebar-tab-status"]', (el) => el.click())
  await page.waitForSelector('[data-testid="runtime-view-switch"]')
  await page.$eval('[data-testid="runtime-view-switch-state"]', (el) => el.click())
  await page.waitForSelector('[data-testid="state-runtime"]')
  const stateRuntimeText = await page.$eval('[data-testid="state-runtime"]', el => el.textContent || '')
  check('state runtime shows compact grouped summary', ['Core', 'Workload', 'Usage', 'Memory', 'View JSON'].every((s) => stateRuntimeText.includes(s)), stateRuntimeText.slice(0, 300))
  const healthText = await page.$eval('[data-testid="run-health-panel"]', el => el.textContent || '')
  check('run health panel shows non-cost run health', healthText.includes('Run status') && healthText.includes('Missing HTTP traces') && !/cost|money/i.test(healthText), healthText.slice(0, 300))
  check('watch expressions panel removed', await page.$('[data-testid="watch-expressions"]') === null)
  check('state runtime keeps full JSON out of sidebar', !stateRuntimeText.includes('Full AgentState JSON'), stateRuntimeText.slice(0, 300))
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.trim() === 'View JSON')
    if (!(button instanceof HTMLButtonElement)) throw new Error('View JSON button not found')
    button.click()
  })
  await page.waitForSelector('[data-testid="agent-state-json-dialog"]')
  await page.screenshot({ path: join(shotsDir, '04-debugger-state-json-modal.png'), fullPage: false })
  const stateJsonText = await page.$eval('[data-testid="agent-state-json-dialog"]', el => el.textContent || '')
  check('state JSON modal exposes full AgentState', stateJsonText.includes('Full AgentState JSON') && stateJsonText.includes(sessionId), stateJsonText.slice(0, 300))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-state-json-dialog"]'))
  await page.waitForSelector('[data-testid="runtime-view-switch"]')
  await page.$eval('[data-testid="runtime-view-switch-tools"]', (el) => el.click())
  await page.waitForSelector('[data-testid="tool-registry"]')
  await page.screenshot({ path: join(shotsDir, '05-debugger-runtime-tools.png'), fullPage: false })
  check('no page errors', errors.length === 0, errors.join(' | '))
  log(`Screenshots: ${shotsDir}`)
} finally {
  if (browser) await browser.disconnect().catch(() => {})
  await stop(host)
}

async function ensureFixtureSessionSelected(page) {
  const selected = await page.evaluate((id) => {
    const row = document.querySelector(`[data-testid="session-row"][data-session-id="${id}"]`)
    if (!row) return { found: false, selected: false }
    const selectedNow = row.className.includes('border-l-primary') || row.className.includes('bg-accent')
    if (!selectedNow) row.click()
    return { found: true, selected: selectedNow }
  }, sessionId)
  if (selected.found) {
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="session-row"][data-session-id="${id}"]`),
      { timeout: 5000 },
      sessionId,
    )
  }
}

async function verifySurfaceContrast(page, theme) {
  const surfaces = await page.evaluate(() => {
    const parseRgb = (value) => {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      if (!match) throw new Error(`cannot parse color: ${value}`)
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), raw: value }
    }
    const bg = (selector) => {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`missing surface selector: ${selector}`)
      return parseRgb(getComputedStyle(el).backgroundColor)
    }
    return {
      app: bg('body'),
      inspector: bg('[data-testid="inspector-panel"]'),
      sidebarTabs: bg('[data-testid="inspector-sidebar-tabs"]'),
      traceHeader: bg('[data-testid="trace-toolbar"]'),
      traceSwitcher: bg('[data-testid="trace-mode-switch"]'),
    }
  })
  const pairs = [
    ['app', 'inspector', 8],
    ['inspector', 'traceSwitcher', 10],
    ['traceHeader', 'traceSwitcher', 10],
  ]
  for (const [left, right, min] of pairs) {
    const distance = rgbDistance(surfaces[left], surfaces[right])
    check(
      `${theme} surface contrast ${left} vs ${right}`,
      distance >= min,
      `${describeRgb(surfaces[left])} vs ${describeRgb(surfaces[right])}; distance ${distance.toFixed(1)}`,
    )
  }
  check(
    `${theme} sidebar tab and trace header share the same deliberate band`,
    rgbDistance(surfaces.sidebarTabs, surfaces.traceHeader) < 2,
    `${describeRgb(surfaces.sidebarTabs)} vs ${describeRgb(surfaces.traceHeader)}`,
  )
}

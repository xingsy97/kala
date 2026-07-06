import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const requireFromHost = createRequire(new URL('../packages/host/package.json', import.meta.url))
const { io } = requireFromHost('socket.io-client')

const repo = new URL('..', import.meta.url).pathname
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
    auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
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
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    cursor: 0,
    todos: [],
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
    { role: 'user', content: [{ type: 'text', text: ' -  executor  -  cwd  - ' }] },
  ]
  const entries = [
    { kind: 'header', seq: 0, ts: '2026-07-06T06:00:00.000Z', sessionId, formatVersion: 1, kernelVersion: '0.0.0', config, initialState, initialCwd: repo },
    { kind: 'event', seq: 1, ts: '2026-07-06T06:00:01.000Z', event: { kind: 'user_message', text: ' -  executor  -  cwd  - ' }, effects: [{ kind: 'call_llm', messages: llmRequestMessages, tools: config.tools }] },
    { kind: 'event', seq: 2, ts: '2026-07-06T06:00:02.000Z', event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId, name: 'edit', input: { path: 'packages/executor/src/sandbox.ts', oldText: 'const base = canonicalRoots[0] ?? process.cwd()', newText: 'const base = opts?.cwd ?? canonicalRoots[0] ?? process.cwd()' } }] }, usage: { inputTokens: 42180, outputTokens: 614, costUsd: 0.1264, cacheCreationTokens: 0, cacheReadTokens: 32000 } }, effects: [{ kind: 'request_approval', callId, name: 'edit', input: { path: 'packages/executor/src/sandbox.ts' } }], llmTrace: { provider: 'anthropic', model: 'claude-sonnet-4-6', request: { url: 'https://api.anthropic.com/v1/messages', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'test-redacted-api-key' }, body: { model: 'claude-sonnet-4-6', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: ' -  executor  -  cwd  - ' }] }], tools: [{ name: 'edit', description: 'Replace exact text in a workspace file.', input_schema: config.tools[0].inputSchema }] } }, response: { status: 200, streamEventTypes: ['message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'message_stop'], body: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'edit', input: { path: 'packages/executor/src/sandbox.ts' } }] } } } },
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
    await page.waitForSelector('[data-testid="trace-view-switch"]', { timeout: 15000 })
  } catch (err) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      body: document.body.textContent?.slice(0, 2000) ?? '',
      hasInspectorToggle: Boolean(document.querySelector('[data-testid="inspector-toggle"]')),
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
  const reducerText = await page.$eval('[aria-label="trace view"]', el => el.textContent || '')
  check('reducer trace shows state transition', reducerText.includes('idle  -  thinking') && reducerText.includes('request_approval'), reducerText.slice(0, 300))
  await page.click('[data-testid="theme-toggle"]')
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
  await verifySurfaceContrast(page, 'light')
  await page.screenshot({ path: join(shotsDir, '01-debugger-reducer-light.png'), fullPage: false })
  await page.click('[data-testid="theme-toggle"]')
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
  await page.click('[data-testid="trace-view-switch-llm"]')
  await page.waitForSelector('[data-testid="llm-call-row"]')
  await page.click('[data-testid="llm-call-row"]')
  await page.screenshot({ path: join(shotsDir, '02-debugger-llm.png'), fullPage: false })
  const llmAssemblyText = await page.$eval('[data-testid="llm-assembly-view"]', el => el.textContent || '')
  check('llm detail explains message assembly', llmAssemblyText.includes('System Prompt') && llmAssemblyText.includes('Kernel Messages') && llmAssemblyText.includes('Adapter Transform'), llmAssemblyText.slice(0, 300))
  await page.click('[data-testid="llm-detail-view-switch-context"]')
  await page.waitForSelector('[data-testid="kernel-messages-view"]')
  const kernelMessagesText = await page.$eval('[data-testid="kernel-messages-view"]', el => el.textContent || '')
  check('llm detail shows kernel messages', kernelMessagesText.includes('user') && kernelMessagesText.includes(' -  executor'), kernelMessagesText.slice(0, 300))
  await page.click('[data-testid="llm-detail-view-switch-payload"]')
  await page.waitForSelector('[data-testid="provider-payload-view"]')
  const payloadText = await page.$eval('[data-testid="provider-payload-view"]', el => el.textContent || '')
  check('llm detail shows provider payload', payloadText.includes('Provider Request') && payloadText.includes('Kernel Request') && payloadText.includes('test-redacted-api-key'), payloadText.slice(0, 300))
  await page.click('[data-testid="llm-detail-view-switch-response"]')
  await page.waitForSelector('[data-testid="llm-response-view"]')
  const responseText = await page.$eval('[data-testid="llm-response-view"]', el => el.textContent || '')
  check('llm detail shows provider response and parsed response', responseText.includes('Provider Response') && responseText.includes('Parsed Kernel Response'), responseText.slice(0, 300))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="llm-detail"]'))
  await page.click('[data-testid="trace-view-switch-tools"]')
  await page.waitForSelector('[data-testid="tool-call-row"]')
  await page.click('[data-testid="tool-call-row"]')
  await page.screenshot({ path: join(shotsDir, '03-debugger-tool.png'), fullPage: false })
  const toolText = await page.$eval('[data-testid="tool-detail"]', el => el.textContent || '')
  check('tool detail shows lifecycle raw data', toolText.includes('Tool Input') && toolText.includes('Tool Result Event'), toolText.slice(0, 300))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="tool-detail"]'))
  await page.click('[data-testid="inspector-sidebar-tab-debugger"]')
  await page.click('[data-testid="runtime-view-switch-state"]')
  await page.waitForSelector('[data-testid="state-runtime"]')
  const stateRuntimeText = await page.$eval('[data-testid="state-runtime"]', el => el.textContent || '')
  check('state runtime shows compact grouped summary', ['Core', 'Workload', 'Usage', 'Memory', 'View JSON'].every((s) => stateRuntimeText.includes(s)), stateRuntimeText.slice(0, 300))
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
  await page.click('[data-testid="runtime-view-switch-tools"]')
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
      traceHeader: bg('[aria-label="trace view"] > div:first-child'),
      traceSwitcher: bg('[data-testid="trace-view-switch"]'),
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

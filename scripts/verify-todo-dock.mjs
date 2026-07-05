#!/usr/bin/env node
/**
 * REAL end-to-end verify of the todo management feature:
 *   1. Open dashboard on a fresh sessionId.
 *   2. Send a prompt that forces the LLM to call `todowrite`.
 *   3. Wait for the tool_result event on disk (llm calls todowrite  -  kernel
 *      promotes input.todos onto state.todos  -  state.changed broadcasts).
 *   4. Assert the TodoDock is visible with the right progress counter,
 *      correct number of items, and correct icons per status.
 *
 * `todowrite` doesn't need an executor process for the state promotion  - 
 * BUT the host's loop dispatches call_tool as a websocket message and needs
 * SOMETHING to ack it. So we do spawn an executor (which has the todowrite
 * runner and returns "todos updated: N items").
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? '/tmp/agent-kernel-e2e-sessions'
const MODEL = process.env.VERIFY_MODEL ?? 'gpt-5.5'
const stamp = Date.now().toString(36).toUpperCase().padStart(11, '0').slice(-11)
const SESSION_ID = `01JVTD${stamp}TODO`.padEnd(26, 'X').slice(0, 26)
const WORKSPACE = process.env.VERIFY_WORKSPACE ?? join(tmpdir(), `verify-todo-${SESSION_ID}`)
const REPO_ROOT = new URL('..', import.meta.url).pathname

mkdirSync(WORKSPACE, { recursive: true })

let exitCode = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  -  ${detail}` : ''}`)
  if (!pass) exitCode = 1
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1600, height: 1000 },
})

let executor
const execLog = []

try {
  const page = await browser.newPage()

  await page.goto(`${DASHBOARD_URL}/?sessionId=${SESSION_ID}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() ===
      'ready',
    { timeout: 8_000 },
  )

  await page.click('[data-testid="model-picker"]')
  const optionSel = `[data-testid="model-option-${MODEL}"]`
  await page.waitForSelector(optionSel, { timeout: 4_000 })
  await page.click(optionSel)
  await sleep(200)

  // Empty state: TodoDock should NOT be visible before the LLM calls todowrite.
  const dockBefore = await page.$('[data-testid="todo-dock"]')
  check('TodoDock hidden when state.todos is empty', dockBefore === null, dockBefore ? 'visible' : 'hidden')

  // Warm-up prompt so the session lands on disk before we spawn the executor.
  const composerSel = '[data-testid="composer-input"]'
  const sendSel = '[data-testid="composer-send"]'
  await page.focus(composerSel)
  await page.keyboard.type(`Say just the word "ok" and nothing else.`, { delay: 5 })
  await page.click(sendSel)

  const warmupDeadline = Date.now() + 20_000
  let warmupOk = false
  while (Date.now() < warmupDeadline) {
    const entries = readSessionEntries(SESSIONS_DIR, SESSION_ID)
    if (entries.some((e) => e.event.kind === 'llm_response')) {
      warmupOk = true
      break
    }
    await sleep(400)
  }
  check('warm-up llm_response received', warmupOk)
  if (!warmupOk) throw new Error('warm-up never completed')

  // Spawn executor.
  executor = spawn(
    'pnpm',
    [
      '--silent',
      '--filter',
      '@agent-kernel/executor',
      'exec',
      'tsx',
      'bin/agent-kernel-executor.ts',
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOST_URL,
        SESSION_ID,
        WORKSPACE,
        EXECUTOR_ID: `verify-${SESSION_ID}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  executor.stdout.on('data', (b) => execLog.push(`[out] ${b.toString()}`))
  executor.stderr.on('data', (b) => execLog.push(`[err] ${b.toString()}`))
  let executorReady = false
  executor.stdout.on('data', (b) => {
    if (b.toString().includes('executor announced')) executorReady = true
  })
  const execDeadline = Date.now() + 10_000
  while (!executorReady && Date.now() < execDeadline) await sleep(200)
  check('executor announced within 10s', executorReady, executorReady ? '' : execLog.join(''))
  if (!executorReady) throw new Error('executor never announced')
  await sleep(300)

  // Prompt the LLM to write three todos. Precise phrasing so the model doesn't
  // improvise a different mix of statuses. Sent as a single line  -  the composer
  // treats Enter as submit, so multi-line prompts would fragment into many
  // user_message events.
  await page.focus(composerSel)
  const prompt =
    `Use the "todowrite" tool RIGHT NOW to record exactly three todos in one call, in this order and with these exact statuses: ` +
    `(1) content="design the schema" status="completed"; ` +
    `(2) content="wire the backend" status="in_progress"; ` +
    `(3) content="build the UI dock" status="pending". ` +
    `Do not do anything else. Do not write any text response. Only invoke the tool once.`
  await page.keyboard.type(prompt, { delay: 3 })
  await page.click(sendSel)

  // Wait for tool_result with name=todowrite in the JSONL log.
  const cutoff = Date.now() + 60_000
  let entries = []
  let todoCall = null
  while (Date.now() < cutoff) {
    entries = readSessionEntries(SESSIONS_DIR, SESSION_ID)
    const effects = entries.flatMap((e) => e.effects.filter((f) => f.kind === 'call_tool'))
    todoCall = effects.find((e) => e.name === 'todowrite')
    if (todoCall && entries.some((e) => e.event.kind === 'tool_result' && e.event.callId === todoCall.callId)) {
      break
    }
    await sleep(500)
  }
  check('kernel dispatched a call_tool for todowrite', !!todoCall, todoCall ? JSON.stringify(todoCall.input).slice(0, 120) : '(none)')

  const toolResult = todoCall
    ? entries.map((e) => e.event).find((e) => e.kind === 'tool_result' && e.callId === todoCall.callId)
    : undefined
  check('todowrite tool returned ok:true', toolResult?.ok === true, toolResult?.content ?? '(none)')

  // Now wait for the dashboard's DOM to reflect state.todos (state:changed
  // triggers a re-render).
  await page.waitForSelector('[data-testid="todo-dock"]', { timeout: 8_000 })
  const dockVisible = await page.$('[data-testid="todo-dock"]')
  check('TodoDock rendered after todowrite call', !!dockVisible)

  const progress = await page.$eval('[data-testid="todo-dock-progress"]', (n) => n.textContent?.trim() ?? '')
  // 1 completed of 3 total.
  check('progress counter shows "1/3 tasks"', progress === '1/3 tasks', `got=${progress}`)

  const items = await page.$$eval('[data-testid="todo-dock-item"]', (nodes) =>
    nodes.map((n) => ({
      status: n.getAttribute('data-status') ?? '',
      content: n.textContent?.trim() ?? '',
    })),
  )
  check('exactly 3 todo items rendered', items.length === 3, `count=${items.length}`)
  check(
    'first item is completed "design the schema"',
    items[0]?.status === 'completed' && items[0]?.content?.includes('design the schema'),
    `${items[0]?.status}: ${items[0]?.content}`,
  )
  check(
    'second item is in_progress "wire the backend"',
    items[1]?.status === 'in_progress' && items[1]?.content?.includes('wire the backend'),
    `${items[1]?.status}: ${items[1]?.content}`,
  )
  check(
    'third item is pending "build the UI dock"',
    items[2]?.status === 'pending' && items[2]?.content?.includes('build the UI dock'),
    `${items[2]?.status}: ${items[2]?.content}`,
  )

  // Toggle collapse: clicking the header should hide the list and reveal the
  // active-task preview.
  await page.click('[data-testid="todo-dock-toggle"]')
  await sleep(200)
  const listHidden = await page.$('[data-testid="todo-dock-list"]')
  check('list hidden after collapse', listHidden === null, listHidden ? 'still visible' : 'hidden')
  const preview = await page.$eval(
    '[data-testid="todo-dock-active-preview"]',
    (n) => n.textContent?.trim() ?? '',
  ).catch(() => '(missing)')
  check(
    'collapsed dock shows active-task preview',
    preview.includes('wire the backend'),
    `preview=${preview}`,
  )

  // Re-open for good measure.
  await page.click('[data-testid="todo-dock-toggle"]')
  await sleep(200)
  const listAgain = await page.$('[data-testid="todo-dock-list"]')
  check('list visible again after re-expand', !!listAgain)
} finally {
  await browser.close()
  if (executor) {
    executor.kill('SIGTERM')
    await sleep(300)
  }
  if (exitCode !== 0) {
    console.error('--- executor log tail ---')
    console.error(execLog.slice(-30).join(''))
  }
}
process.exit(exitCode)

function readSessionEntries(dir, sessionId) {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => f.endsWith(`_${sessionId}.jsonl`))
  files.sort()
  const file = files[files.length - 1]
  if (!file) return []
  const raw = readFileSync(join(dir, file), 'utf8')
  const entries = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const rec = JSON.parse(line)
      if (rec.kind === 'event' && rec.event) {
        entries.push({ event: rec.event, effects: rec.effects ?? [] })
      }
    } catch {}
  }
  return entries
}

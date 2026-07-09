#!/usr/bin/env node
/**
 * REAL end-to-end verify of the tool-call path:
 *   1. Open dashboard on a fresh sessionId.
 *   2. Send a warm-up prompt ("hi") — this materializes the session on disk
 *      (dashboards don't create sessions on connect, only on first user_message)
 *      and lets us wait for the first llm_response so we know the LLM wire is
 *      healthy.
 *   3. Spawn an executor pointing at that same sessionId. Host now has the
 *      session in its store, so the executor's announce succeeds.
 *   4. Send a tool-forcing prompt ("Use the read tool to read /etc/hostname").
 *   5. Wait for the `tool_result` event and assert ok:true + non-empty content
 *      + host never emitted "no executor connected".
 *
 * This exercises: dashboard → kernel → LLM → call_tool effect → executor →
 * tool result → kernel → llm_response — the full tool-call path that the
 * previous "no-auth-error" verify skipped entirely.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? '/tmp/agent-kernel-e2e-sessions'
const MODEL = process.env.VERIFY_MODEL ?? 'gpt-5.5'
const SESSION_ID = process.env.VERIFY_SESSION_ID ?? '01JVERIFYTOOLCALLREAD00'
const WORKSPACE = process.env.VERIFY_WORKSPACE ?? join(tmpdir(), `verify-tool-${SESSION_ID}`)
const REPO_ROOT = new URL('..', import.meta.url).pathname

mkdirSync(WORKSPACE, { recursive: true })

let exitCode = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) exitCode = 1
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

let executor
const execLog = []

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto(`${DASHBOARD_URL}/?sessionId=${SESSION_ID}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-status') ===
      'ready',
    { timeout: 8_000 },
  )

  await page.click('[data-testid="model-picker"]')
  const optionSel = `[data-testid="model-option-${MODEL}"]`
  await page.waitForSelector(optionSel, { timeout: 4_000 })
  await page.click(optionSel)
  await sleep(200)

  // Warm-up prompt. Materializes session on disk + verifies LLM wire.
  const composerSel = '[data-testid="composer-input"]'
  const sendSel = '[data-testid="composer-send"]'
  const textarea = await page.$(composerSel)
  if (!textarea) throw new Error('composer textarea not found')
  await textarea.click()
  await page.keyboard.type(`Say just the word "ok" and nothing else.`, { delay: 5 })
  await page.click(sendSel)

  // Wait for session JSONL + first llm_response.
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

  // Now the session is on disk. Spawn executor.
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
  // Give the host a beat to register the executor in `bySession`.
  await sleep(300)

  // Seed a file inside the workspace so the read tool has a legal target
  // (the sandbox rejects reads outside WORKSPACE with EACCES).
  const seedPath = join(WORKSPACE, 'greeting.txt')
  const seedText = `hello from verify-tool-call ${SESSION_ID}`
  writeFileSync(seedPath, seedText, 'utf8')

  // Tool-forcing prompt.
  await page.focus(composerSel)
  await page.keyboard.type(
    `Use the "read" tool to read the file at absolute path ${seedPath}. Report the content verbatim.`,
    { delay: 5 },
  )
  await page.click(sendSel)

  const cutoff = Date.now() + 30_000
  let entries = []
  while (Date.now() < cutoff) {
    entries = readSessionEntries(SESSIONS_DIR, SESSION_ID)
    if (entries.some((e) => e.event.kind === 'tool_result')) break
    await sleep(500)
  }
  const events = entries.map((e) => e.event)
  const callToolEffects = entries.flatMap((e) => e.effects.filter((f) => f.kind === 'call_tool'))
  check(
    'kernel dispatched at least one call_tool effect',
    callToolEffects.length > 0,
    callToolEffects.map((e) => e.name).join(',') || '(none)',
  )
  const readCall = [...callToolEffects].reverse().find((e) => e.name === 'read')
  check(
    'call_tool named "read" present',
    !!readCall,
    readCall ? JSON.stringify(readCall.input) : '(none)',
  )

  const toolResults = events.filter((e) => e.kind === 'tool_result')
  check(
    'tool_result event present',
    toolResults.length > 0,
    toolResults.map((e) => `ok=${e.ok}`).join(',') || '(none)',
  )
  const readResult = readCall
    ? toolResults.find((e) => e.callId === readCall.callId)
    : undefined
  check(
    'read tool returned ok:true',
    readResult?.ok === true,
    readResult?.content?.slice(0, 80) ?? '(none)',
  )
  check(
    'read tool content contains seed text',
    typeof readResult?.content === 'string' && readResult.content.includes(seedText),
    readResult?.content?.slice(0, 120) ?? '(none)',
  )

  const noExec = toolResults.some(
    (e) => typeof e.content === 'string' && e.content.includes('no executor connected'),
  )
  check('no tool_result carries "no executor connected"', !noExec)

  const errorEvents = events.filter((e) => e.kind === 'llm_error')
  check(
    'no llm_error events',
    errorEvents.length === 0,
    errorEvents[0]?.error?.slice(0, 100) ?? '(none)',
  )

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '(none)')
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

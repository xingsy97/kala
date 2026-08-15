#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'
import { browserMetadata, resolveChrome, startProfileWindow, stopProfileWindow, summarizeCpuProfile } from './profiling-utils.mjs'

const root = new URL('../..', import.meta.url).pathname
const bundle = join(root, 'release', 'bundle-dashboard-with-runtime.cjs')
const port = Number(process.env.PERF_DASHBOARD_PORT ?? 3210)
const origin = `http://127.0.0.1:${port}`
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-production-profile-'))
const sessionsDir = join(stateRoot, 'sessions')
const evidenceRoot = process.env.PERF_EVIDENCE_ROOT ?? join(stateRoot, 'evidence')
const longSessionId = `perf-long-${Date.now()}`
const longTurns = Number(process.env.PERF_TURNS ?? 1_250)
const shortSessionId = `perf-short-${Date.now()}`
const chrome = resolveChrome()
const hostLogs = []
let host
let browser

if (!existsSync(bundle)) throw new Error('production release bundle missing; run build:release-assets')
if (!chrome) throw new Error('Chromium not found; set CHROME_PATH')
mkdirSync(sessionsDir, { recursive: true })
mkdirSync(evidenceRoot, { recursive: true })
writeSession(longSessionId, longTurns)
writeSession(shortSessionId, 8)

try {
  host = spawn(process.execPath, [bundle], {
    cwd: root,
    env: { ...process.env, HOST_LISTEN_HOST: '127.0.0.1', HOST_PORT: String(port), SESSIONS_DIR: sessionsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout.on('data', (chunk) => hostLogs.push(chunk.toString()))
  host.stderr.on('data', (chunk) => hostLogs.push(chunk.toString()))
  await waitForHttp(`${origin}/settings`)

  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 180_000 })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.setCacheEnabled(false)
  await installPageObservers(page)
  const cdp = await page.target().createCDPSession()
  await cdp.send('Performance.enable')

  const report = {
    generatedAt: new Date().toISOString(),
    artifact: bundle,
    artifactMetadata: await browserMetadata(browser, page, bundle, root),
    parameters: { longTurns, viewport: { width: 1440, height: 900 }, cacheEnabled: false },
    sessions: { longSessionId, shortSessionId, longTimelineEntries: longTurns * 4 + 1 },
    scenarios: {},
  }

  report.scenarios.coldLoad = await sampleScenario({
    name: 'cold-load-long-session', page, cdp, evidenceRoot,
    action: async () => {
      await page.goto(`${origin}/?sessionId=${longSessionId}`, { waitUntil: 'networkidle2', timeout: 120_000 })
      await page.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 })
      await page.waitForSelector('[data-testid="chat-panel"]', { timeout: 60_000 })
    },
  })

  report.scenarios.scroll = await sampleScenario({
    name: 'long-transcript-scroll', page, cdp, evidenceRoot,
    action: async () => {
      const scroller = await page.waitForSelector('[data-virtuoso-scroller="true"]')
      await scroller.evaluate((element) => { element.scrollTop = 0 })
      await sleep(500)
      await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' }))
      await sleep(2_000)
      await scroller.evaluate((element) => { element.scrollTop = 0 })
      await sleep(500)
    },
  })

  report.scenarios.typing = await sampleScenario({
    name: 'composer-typing-240-chars', page, cdp, evidenceRoot,
    action: async () => {
      const input = await page.waitForSelector('[data-testid="composer-input"]')
      await input.click()
      await page.keyboard.type('真实输入性能 '.repeat(20), { delay: 4 })
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
      await page.keyboard.press('Backspace')
      await sleep(300)
    },
  })

  report.scenarios.switchToShort = await sampleScenario({
    name: 'switch-long-to-short', page, cdp, evidenceRoot,
    action: async () => {
      await clickVisibleSession(page, shortSessionId)
      await page.waitForFunction(() => document.body.innerText.includes('Completed item 7.'))
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-minimap-item"]').length > 0)
    },
  })
  report.scenarios.switchToLong = await sampleScenario({
    name: 'switch-short-to-long', page, cdp, evidenceRoot,
    action: async () => {
      await clickVisibleSession(page, longSessionId)
      await page.waitForFunction((last) => document.body.innerText.includes(`Completed item ${last}.`), {}, longTurns - 1)
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-minimap-item"]').length === 120)
    },
  })

  const budget = evaluateBudget(report)
  writeFileSync(join(evidenceRoot, 'report.json'), `${JSON.stringify({ ...report, budget }, null, 2)}\n`)
  console.log(JSON.stringify({ evidenceRoot, report, budget }, null, 2))
  if (process.env.PERF_ASSERT_BUDGET === '1' && !budget.pass) throw new Error(`production performance budget failed: ${budget.failures.join('; ')}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (host && host.exitCode === null) {
    host.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => host.once('exit', resolve)), sleep(5_000)])
    if (host.exitCode === null) host.kill('SIGKILL')
  }
  if (!process.env.PERF_KEEP_STATE) rmSync(stateRoot, { recursive: true, force: true })
}

function evaluateBudget(report) {
  const failures = []
  const long = report.scenarios.switchToLong
  const cold = report.scenarios.coldLoad
  if (long.domNodes > 5_000) failures.push(`long-session DOM ${long.domNodes} > 5000`)
  if ((long.testIdDescendants.find((item) => item.testId === 'reducer-trace-list')?.descendants ?? Infinity) > 1_000) failures.push('Reducer Trace DOM is not bounded')
  if ((long.testIdDescendants.find((item) => item.testId === 'timeline-minimap')?.descendants ?? Infinity) > 150) failures.push('Timeline minimap DOM is not sampled')
  if (Math.max(...long.longTasks.map((item) => item.duration), 0) > 200) failures.push('Session switch has a >200ms long task')
  if (Math.max(...cold.longTasks.map((item) => item.duration), 0) > 250) failures.push('Cold load has a >250ms long task')
  return { pass: failures.length === 0, failures }
}

function writeSession(sessionId, turns) {
  const now = new Date().toISOString()
  const cwd = '/tmp/agent-runlab-performance'
  const config = { tools: [], systemPrompt: 'Production performance fixture' }
  const initialState = {
    sessionId,
    messages: [{ role: 'system', content: [{ type: 'text', text: config.systemPrompt }] }],
    pendingCalls: [], status: 'idle', usage: { inputTokens: 0, outputTokens: 0 }, cursor: 0,
    cwd, contextPressureLevel: 'none', approvalMode: 'allow_all',
  }
  const entries = [{ kind: 'header', seq: 0, ts: now, sessionId, initialCwd: cwd, formatVersion: 1, kernelVersion: '0.0.0', config, initialState }]
  let seq = 0
  for (let index = 0; index < turns; index += 1) {
    const callId = `${sessionId}-tool-${index}`
    entries.push({ kind: 'event', seq: ++seq, ts: now, event: { kind: 'user_message', text: `Investigate performance item ${index}` }, effects: [{ kind: 'call_llm', messages: [], tools: [] }] })
    entries.push({
      kind: 'event', seq: ++seq, ts: now,
      event: { kind: 'llm_response', message: { role: 'assistant', content: [
        { type: 'text', text: `### Analysis ${index}\n\nThis is a realistic markdown block with **bold text**, a [source](src/file-${index}.ts), and inline code \`value-${index}\`.\n\n\`\`\`typescript\nexport const value${index} = ${index}\n\`\`\`` },
        { type: 'tool_call', callId, name: 'read_file', input: { path: `src/file-${index}.ts`, _intent: `Read performance fixture ${index}.` } },
      ] }, usage: { inputTokens: 100 + index, outputTokens: 50 } },
      effects: [{ kind: 'call_tool', callId, name: 'read_file', input: { path: `src/file-${index}.ts` } }],
    })
    entries.push({ kind: 'event', seq: ++seq, ts: now, event: { kind: 'tool_result', callId, ok: true, content: `export const value${index} = ${index}\n` }, effects: [{ kind: 'call_llm', messages: [], tools: [] }] })
    entries.push({ kind: 'event', seq: ++seq, ts: now, event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: `Completed item ${index}. The result is stable and persisted.` }] }, usage: { inputTokens: 150 + index, outputTokens: 24 } }, effects: [{ kind: 'finish' }] })
  }
  writeFileSync(join(sessionsDir, `${Date.now()}_${sessionId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

async function installPageObservers(page) {
  await page.evaluateOnNewDocument(() => {
    window.__runlabPerf = { longTasks: [], events: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__runlabPerf.longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name })
    }).observe({ type: 'longtask', buffered: true })
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__runlabPerf.events.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration, interactionId: entry.interactionId ?? 0 })
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 })
    } catch {}
  })
}

async function sampleScenario({ name, page, cdp, evidenceRoot, action }) {
  await page.evaluate(() => { if (window.__runlabPerf) { window.__runlabPerf.longTasks = []; window.__runlabPerf.events = [] } })
  const tracePath = join(evidenceRoot, `${name}.trace.json`)
  const cpuPath = join(evidenceRoot, `${name}.cpuprofile.json`)
  const startedAt = await startProfileWindow(page, cdp)
  await action()
  const { durationMs, profile, frames } = await stopProfileWindow(page, cdp, { startedAt, tracePath })
  writeFileSync(cpuPath, JSON.stringify(profile))
  const pageEvidence = await page.evaluate(() => ({
    url: location.href,
    longTasks: window.__runlabPerf?.longTasks ?? [],
    events: window.__runlabPerf?.events ?? [],
    domNodes: document.getElementsByTagName('*').length,
    mountedTranscriptRows: document.querySelectorAll('[data-virt-index]').length,
    toolDots: document.querySelectorAll('[data-testid^="tool-card-dot-"]').length,
    rowDescendants: [...document.querySelectorAll('[data-virt-index]')].map((row) => ({
      index: row.getAttribute('data-virt-index'),
      descendants: row.querySelectorAll('*').length,
      text: row.textContent?.slice(0, 120) ?? '',
      testIds: [...row.querySelectorAll('[data-testid]')].slice(0, 8).map((node) => node.getAttribute('data-testid')),
    })).sort((a, b) => b.descendants - a.descendants).slice(0, 20),
    topLevelDescendants: [...document.body.children].map((node) => ({ tag: node.tagName, id: node.id, className: String(node.className).slice(0, 120), descendants: node.querySelectorAll('*').length })),
    testIdDescendants: [...document.querySelectorAll('[data-testid]')].map((node) => ({
      testId: node.getAttribute('data-testid'), descendants: node.querySelectorAll('*').length,
      display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility,
      rect: (() => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height } })(),
    })).sort((a, b) => b.descendants - a.descendants).slice(0, 40),
    largestNonTranscriptNodes: [...document.querySelectorAll('#root *')].filter((node) => !node.closest('[data-virt-index]')).map((node) => ({
      tag: node.tagName, testId: node.getAttribute('data-testid'), className: String(node.className).slice(0, 100), descendants: node.querySelectorAll('*').length,
    })).sort((a, b) => b.descendants - a.descendants).slice(0, 30),
    tagCounts: Object.fromEntries([...document.querySelectorAll('*')].reduce((map, node) => map.set(node.tagName, (map.get(node.tagName) ?? 0) + 1), new Map()).entries()),
  }))
  const metrics = await cdp.send('Performance.getMetrics')
  const metricMap = Object.fromEntries(metrics.metrics.map((item) => [item.name, item.value]))
  const cpuSummary = summarizeCpuProfile(profile)
  return {
    durationMs: Math.round(durationMs * 10) / 10,
    frames,
    ...pageEvidence,
    jsHeapUsedBytes: metricMap.JSHeapUsedSize,
    jsHeapTotalBytes: metricMap.JSHeapTotalSize,
    layoutCount: metricMap.LayoutCount,
    recalcStyleCount: metricMap.RecalcStyleCount,
    scriptDurationSeconds: metricMap.ScriptDuration,
    layoutDurationSeconds: metricMap.LayoutDuration,
    cpuSummary,
    tracePath,
    cpuPath,
  }
}

async function clickVisibleSession(page, sessionId) {
  const selector = `[data-testid="session-row"][data-session-id="${sessionId}"]`
  await page.waitForSelector(selector)
  const rows = await page.$$(selector)
  for (const row of rows) {
    const visible = await row.evaluate((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 })
    if (!visible) continue
    const started = performance.now()
    await row.click()
    await page.waitForFunction((id) => new URL(location.href).searchParams.get('sessionId') === id, { timeout: 30_000 }, sessionId)
    await page.waitForSelector('[data-testid="composer-input"]')
    return performance.now() - started
  }
  throw new Error(`no visible Session row: ${sessionId}`)
}

async function waitForHttp(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch {}
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${url}; host logs: ${hostLogs.slice(-20).join('')}`)
}

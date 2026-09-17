#!/usr/bin/env node
// Run with: pnpm --dir packages/host exec tsx ../../scripts/dashboard/verify-dashboard-stream-lifecycle.mjs
// Real Host/Socket.IO + production App/ChatPanel in Chromium. Only the model
// and executor are controlled; the state-only cases replay external-runtime
// callbacks at the same Host broadcast boundary used by Copilot.
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { io } from 'socket.io-client'
import { startHostServer } from '../../packages/host/src/server.ts'
import { createConfig, createInitialState } from '../../packages/kernel/src/index.ts'
import { PROTOCOL_VERSION } from '../../packages/shared/src/index.ts'

const root = resolve(import.meta.dirname, '../..')
const evidence = resolve(root, '.artifacts', process.env.STREAM_EVIDENCE_NAME ?? 'outputting-browser')
await mkdir(evidence, { recursive: true })
const stateRoot = resolve(evidence, 'host-state')
await mkdir(stateRoot, { recursive: true })
const steps = []
const errors = []
let browser, host, dashboard, executor, page
const gates = new Map()
const gate = (name) => new Promise((done) => gates.set(name, done))
const release = (name) => { assert(gates.has(name), `missing gate ${name}`); gates.get(name)(); gates.delete(name) }
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(25) }
  throw new Error(`Timed out: ${label}`)
}
const text = (value) => ({ role: 'assistant', content: [{ type: 'text', text: value }] })
const config = createConfig({ systemPrompt: 'Controlled streaming lifecycle.', tools: [{
  name: 'probe', description: 'Controlled lifecycle probe', inputSchema: { type: 'object' }, requiresApproval: false,
}] })
let calls = 0
try {
  const http = createServer()
  await new Promise((done) => http.listen(0, '127.0.0.1', done))
  host = await startHostServer({
    httpServer: http, port: http.address().port, sessionsDir: stateRoot, artifactRootDir: false,
    staticDir: process.env.STREAM_DASHBOARD_DIST ?? resolve(root, 'packages/dashboard/dist'),
    defaultConfig: config, toolTimeoutMs: 60_000,
    llm: { name: 'controlled-stream-lifecycle', async call(params) {
      calls++
      const request = params.messages.filter((message) => message.role === 'user').at(-1)?.content[0]?.text
      if (request === 'cancel' || request === 'error') {
        params.onTextDelta?.(`${request} partial text.`)
        await Promise.race([
          gate(request),
          new Promise((_, reject) => params.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })),
        ])
        if (request === 'error') throw new Error('Controlled provider failure')
        return { message: text('Cancelled completion must not be displayed.') }
      }
      if (calls === 1) {
        params.onTextDelta?.('Before the tool.')
        await gate('first-response')
        return { message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'probe-1', name: 'probe', input: {} }] } }
      }
      params.onTextDelta?.('Distinct final answer.')
      await gate('final-response')
      return { message: text('Distinct final answer.') }
    } },
  })
  const origin = `http://127.0.0.1:${host.port}`
  const kernel = await host.store.create({ sessionId: 'stream-kernel', config })
  const external = await host.store.create({ sessionId: 'stream-external', config, agentRuntime: 'copilot' })
  dashboard = io(`${origin}/dashboard`, { transports: ['websocket'], auth: { sessionId: kernel.sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION } })
  await new Promise((done) => dashboard.once('session:ready', done))
  dashboard.on('event:appended', (payload) => console.log(`WIRE ${payload.seq} ${payload.event.kind} ${payload.event.kind === 'llm_response' ? JSON.stringify(payload.event.message) : ''}`))
  executor = io(`${origin}/executor`, { transports: ['websocket'], auth: { role: 'executor', clientVersion: PROTOCOL_VERSION } })
  executor.on('tool:call', async (payload, ack) => {
    await gate('tool-result')
    ack({ callId: payload.callId, ok: true, content: 'probe complete' })
  })
  await new Promise((done) => executor.once('connect', done))
  executor.emit('executor:announce', { executorId: 'stream-executor', workspaceId: 'stream-workspace', workspaceName: 'Stream regression', tools: ['probe'], runtime: 'node', runtimeVersion: '22' })
  await wait(() => host.executorsSnapshot().length > 0, 'executor connection')
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium',
    headless: true, userDataDir: resolve(evidence, 'chrome-profile'),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('ak-smooth-streaming-text', 'false')
    localStorage.setItem('i18nextLng', 'en')
  })
  const navigate = async (id) => {
    await page.goto(`${origin}/?sessionId=${id}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-testid="composer-input"]')
  }
  const cursor = async (present) => page.waitForFunction(
    (expected) => Boolean(document.querySelector('[data-testid="streaming-cursor"]')) === expected, {}, present,
  )
  const visible = async (value) => page.waitForFunction((expected) => [...document.querySelectorAll('.ak-chat-container')].some((element) => element.textContent?.includes(expected)), {}, value)
  const quiet = async () => {
    await cursor(false)
    await page.waitForFunction(() => !/\bOutputting\b/.test(document.body.innerText))
  }
  const step = async (name, fn) => {
    await fn()
    steps.push({ name, pass: true })
    console.log(`PASS ${name}`)
    await page.screenshot({ path: resolve(evidence, `${steps.length}.png`) })
  }
  await navigate(kernel.sessionId)
  await step('real Host stream is active before the response completes', async () => {
    const ack = await dashboard.timeout(5000).emitWithAck('client:user_message', { sessionId: kernel.sessionId, text: 'tool flow' })
    assert.equal(ack.ok, true)
    await cursor(true)
    await visible('Before the tool.')
  })
  await step('tool-only response preserves text but stops cursor and Outputting', async () => {
    release('first-response')
    await wait(() => gates.has('tool-result'), 'real tool dispatch')
    await quiet()
    await visible('Before the tool.')
    assert.equal(kernel.state.status, 'executing_tools')
  })
  await step('next LLM iteration has a separate active draft and retains tool preamble', async () => {
    release('tool-result')
    await wait(() => gates.has('final-response'), 'second provider call')
    await cursor(true)
    await visible('Before the tool.')
    await visible('Distinct final answer.')
  })
  await step('authoritative completion stops all output indicators without deleting prose', async () => {
    release('final-response')
    await wait(() => kernel.state.status === 'done', 'kernel terminal state')
    await quiet()
    await visible('Before the tool.')
    await visible('Distinct final answer.')
    const content = await page.$$eval('.ak-chat-container', (elements) => elements.map((element) => element.textContent).join('\n'))
    assert.equal(content.split('Distinct final answer.').length - 1, 1)
  })
  for (const kind of ['cancel', 'error']) {
    await step(`real Host ${kind} retains partial output without a blinking cursor`, async () => {
      await dashboard.timeout(5000).emitWithAck('client:user_message', { sessionId: kernel.sessionId, text: kind })
      await cursor(true)
      if (kind === 'cancel') {
        dashboard.emit('client:cancel', { sessionId: kernel.sessionId })
        await wait(() => kernel.state.status === 'done', 'cancel completion')
      }
      release(kind)
      await wait(() => kernel.state.status === (kind === 'error' ? 'error' : 'done'), `${kind} terminal state`)
      await quiet()
      await visible(`${kind} partial text.`)
    })
  }
  await navigate(external.sessionId)
  let messages = [{ role: 'user', content: [{ type: 'text', text: 'External runtime request.' }] }]
  let sequence = 1
  const state = async (status) => {
    external.state = { ...createInitialState({ sessionId: external.sessionId }), status, messages, cursor: sequence++ }
    host.io.of('/dashboard').to(`session:${external.sessionId}`).emit('state:changed', { sessionId: external.sessionId, state: external.state, cursor: external.state.cursor })
    await sleep(100)
  }
  const delta = (value) => host.io.of('/dashboard').to(`session:${external.sessionId}`).emit('session:token_delta', { sessionId: external.sessionId, text: value })
  await step('state-only runtime renders prior history throughout streaming', async () => {
    await state('thinking')
    delta('External final answer.')
    await cursor(true)
    await visible('External runtime request.')
  })
  await step('state-only done replaces draft with authoritative answer and stops Outputting', async () => {
    messages = [...messages, text('External final answer.')]
    await state('done')
    await quiet()
    await visible('External final answer.')
    await visible('External runtime request.')
  })
  await step('state-only tool transition retains prose and next iteration does not merge it', async () => {
    messages = [...messages, { role: 'user', content: [{ type: 'text', text: 'Another request.' }] }]
    await state('thinking')
    delta('External tool preamble.')
    await cursor(true)
    await state('executing_tools')
    await quiet()
    await visible('External tool preamble.')
    messages = [...messages, { role: 'assistant', content: [{ type: 'tool_call', callId: 'external-tool', name: 'probe', input: {} }] }]
    await state('thinking')
    await page.waitForSelector('[data-testid="inline-status-thinking"]')
    await quiet()
    await visible('External tool preamble.')
    delta('Independent subsequent stream.')
    await cursor(true)
    await visible('External tool preamble.')
    await visible('Independent subsequent stream.')
    await state('idle')
    await quiet()
    await visible('Independent subsequent stream.')
  })
  await step('reconnect uses authoritative resting baseline without resurrecting a cursor', async () => {
    messages = [...messages, text('Independent subsequent stream.')]
    await state('done')
    for (const socket of host.io.of('/dashboard').sockets.values()) {
      if (socket.rooms.has(`session:${external.sessionId}`)) socket.conn.close()
    }
    await sleep(1500)
    await quiet()
    await visible('Independent subsequent stream.')
  })
  assert.deepEqual(errors, [])
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: resolve(evidence, 'failure.png') })
    await writeFile(resolve(evidence, 'failure-dom.txt'), await page.evaluate(() => document.body.innerText))
  }
  steps.push({ name: 'failure', pass: false, error: error.stack ?? String(error) })
  process.exitCode = 1
  console.error(error)
} finally {
  await browser?.close()
  dashboard?.close()
  executor?.close()
  for (const done of gates.values()) done()
  await host?.close()
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify({ steps, errors, generatedAt: new Date().toISOString() }, null, 2))
  await rm(stateRoot, { recursive: true, force: true })
  await rm(resolve(evidence, 'chrome-profile'), { recursive: true, force: true })
}

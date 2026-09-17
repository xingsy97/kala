#!/usr/bin/env node
// pnpm --dir packages/host exec tsx ../../scripts/dashboard/verify-dashboard-simple-chat.mjs
// Real production App, Host, admission ledger, attachment storage and runtime
// projections. Only model responses / Copilot's external SDK session are controlled.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { io } from 'socket.io-client'
import { startHostServer } from '../../packages/host/src/server.ts'
import { CopilotAgentRuntime } from '../../packages/host/src/agent-runtime/copilot-runtime.ts'
import { createConfig, createInitialState } from '../../packages/kernel/src/index.ts'
import { PROTOCOL_VERSION } from '../../packages/shared/src/index.ts'

const root = resolve(import.meta.dirname, '../..')
const evidence = resolve(root, '.artifacts', process.env.SIMPLE_CHAT_EVIDENCE_NAME ?? 'simple-chat-draft-browser')
const stateRoot = resolve(evidence, 'host-state')
await rm(stateRoot, { recursive: true, force: true })
await mkdir(stateRoot, { recursive: true })
const steps = [], errors = [], creates = [], admissions = [], sdkCalls = [], kernelCalls = []
const probes = []
let failHostProbe = false, holdExecutorProbe = false
let host, browser, executor, page, intercept = null, uploadCount = 0
const wait = async (predicate, label) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await predicate()) return
    await sleep(25)
  }
  throw new Error(`Timed out: ${label}`)
}
const testId = (id) => `[data-testid="${id}"]`
const originalStart = CopilotAgentRuntime.prototype.start
const originalEnsure = CopilotAgentRuntime.prototype.ensureSession
CopilotAgentRuntime.prototype.start = async function () { this.status = 'ready'; this.reason = undefined }
CopilotAgentRuntime.prototype.ensureSession = async function (record) {
  return {
    on: () => () => {},
    setModel: async () => {},
    sendAndWait: async (input) => {
      for (const attachment of input.attachments ?? []) {
        if (attachment.type === 'file') assert.equal(await readFile(attachment.path, 'utf8'), 'draft attachment')
      }
      sdkCalls.push({ sessionId: record.sessionId, prompt: input.prompt, attachments: input.attachments?.length ?? 0 })
      return { type: 'assistant.message', data: { content: `Copilot reply: ${input.prompt}` } }
    },
  }
}
try {
  const http = createServer()
  await new Promise((done) => http.listen(0, '127.0.0.1', done))
  const config = createConfig({ systemPrompt: 'Draft fixture.', tools: [] })
  host = await startHostServer({
    httpServer: http, port: http.address().port, sessionsDir: stateRoot, artifactRootDir: false,
    staticDir: process.env.SIMPLE_CHAT_DASHBOARD_DIST ?? resolve(root, 'packages/dashboard/dist'),
    copilot: { enabled: false }, defaultConfig: config,
    llm: { name: 'controlled-draft-fixture', async call(input) {
      const message = input.messages.filter((item) => item.role === 'user').at(-1)
      const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
      kernelCalls.push(text)
      return { message: { role: 'assistant', content: [{ type: 'text', text: `Kernel reply: ${text}` }] } }
    } },
  })
  const origin = `http://127.0.0.1:${host.port}`
  const existing = 'draft-existing'
  await host.store.create({ sessionId: existing, config, initialState: {
    ...createInitialState({ sessionId: existing }), status: 'done',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Previously selected chat' }] }],
  } })
  host.io.of('/dashboard').on('connection', (socket) => {
    socket.on('client:create_session', (payload) => creates.push(payload))
    socket.use((packet, next) => {
      if (packet[0] === 'client:connection_ping' || packet[0] === 'client:executor_ping') {
        probes.push({ event: packet[0], workspaceId: packet[0] === 'client:executor_ping' ? packet[1] : undefined })
        if (packet[0] === 'client:connection_ping' && failHostProbe) return
        if (packet[0] === 'client:executor_ping' && holdExecutorProbe) return
      }
      next()
    })
  })
  await writeFile(resolve(evidence, 'notes.txt'), 'draft attachment')
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true,
    userDataDir: resolve(evidence, 'chrome-profile'),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.evaluateOnNewDocument(() => localStorage.setItem('i18nextLng', 'en'))
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    try {
      if (request.url().includes('/runtime/attachments?') && request.method() === 'POST') uploadCount++
      if (request.url().endsWith('/runtime/admission/messages') && request.method() === 'POST') {
        admissions.push(JSON.parse(request.postData()))
        if (intercept === 'reject') {
          intercept = null
          await request.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled rejection' }) })
          return
        }
        if (intercept === 'lose-ack') {
          const response = await fetch(request.url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.postData() })
          assert(response.ok, await response.text())
          await request.respond({ status: 503, contentType: 'application/json', body: '{"error":"Controlled lost acknowledgement"}' })
          return
        }
      }
      await request.continue()
    } catch (error) {
      errors.push(String(error))
      await request.abort().catch(() => {})
    }
  })
  const step = async (name, fn) => {
    await fn()
    await sleep(300)
    await page.screenshot({ path: resolve(evidence, `${steps.length + 1}.png`) })
    steps.push({ name, pass: true })
    console.log(`PASS ${name}`)
  }
  const rootDraft = async (width = 1440, explorer = true) => {
    await page.setViewport({ width, height: width < 600 ? 844 : 1000 })
    // This origin's saved tabs intentionally survive navigation.
    if (page.url().startsWith(origin)) await page.evaluate((open) => localStorage.setItem('ak-explorer-open', String(open)), explorer)
    await page.goto(origin, { waitUntil: 'networkidle2' })
    await page.waitForSelector(testId('simple-chat-draft'), { visible: true })
    await page.waitForSelector(testId('composer-input'), { visible: true })
    assert.equal(await page.$(testId('workbench-new-session')), null)
    assert.equal(new URL(page.url()).searchParams.has('sessionId'), false)
  }
  const openExplorer = async () => {
    await page.waitForSelector('[data-testid="explorer-drawer"][data-state="closed"]', { hidden: true })
    const button = await page.$(testId('explorer-new-chat'))
    if (!button || !await button.isVisible()) await page.click(testId('explorer-toggle'))
    await page.waitForSelector(testId('explorer-new-chat'), { visible: true })
    await sleep(300)
  }
  const newDraft = async () => {
    await openExplorer()
    const before = creates.length
    await page.click(testId('explorer-new-chat'))
    await page.waitForSelector(testId('simple-chat-draft'), { visible: true })
    await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value === '')
    assert.equal(creates.length, before)
  }
  const selected = async (id) => {
    await page.waitForFunction((sessionId) => new URL(location.href).searchParams.get('sessionId') === sessionId, {}, id)
    await page.waitForSelector(testId('simple-chat-draft'), { hidden: true })
    await page.waitForSelector(testId('composer-input'), { visible: true })
    await wait(() => host.store.get(id)?.state.status === 'done', 'completed first message')
  }
  const submit = async (text, runtime = 'kernel') => {
    await page.click(testId(`draft-runtime-${runtime}`))
    await page.type(testId('composer-input'), text)
    await page.click(testId('composer-send'))
  }
  const assertChat = (id, runtime) => {
    const record = host.store.get(id)
    assert(record)
    assert.equal(record.agentRuntime, runtime)
    assert.equal(record.workspaceId, undefined)
    assert.equal(record.state.cwd, undefined)
    assert.equal(record.state.messages.filter((message) => message.role === 'user').length, 1)
    const request = creates.find((item) => item.sessionId === id)
    for (const field of ['cwd', 'workspaceId', 'workspaceName']) assert.equal(request[field], undefined)
  }
  const assertHostOnlyHealth = async () => {
    await page.waitForSelector('[data-testid="connection-status"][data-status="ready"]', { visible: true })
    await page.click(testId('connection-status'))
    await page.waitForSelector(testId('connection-status-popover'), { visible: true })
    await page.waitForFunction(() => document.querySelector('[data-testid="connection-status-popover"]')?.textContent.includes('Healthy'))
    assert.equal(await page.$(testId('connection-segment-service-executor')), null)
    assert.equal(await page.$(testId('connection-health-executor-line')), null)
    assert.equal(await page.$eval(testId('connection-health-curve'), (element) => element.querySelectorAll('circle').length), 0)
    assert.equal(await page.$eval(testId('connection-status-popover'), (element) => element.textContent.includes('Executor')), false)
    await page.click(testId('connection-status'))
  }
  await step('root opens an unsaved draft even with existing sessions and saved tabs', async () => {
    await rootDraft()
    await page.type(testId('composer-input'), 'Not sent')
    await page.click(testId('draft-runtime-copilot'))
    await (await page.$(testId('composer-file-input'))).uploadFile(resolve(evidence, 'notes.txt'))
    await page.waitForSelector(testId('attachment-tray'))
    assert.equal(creates.length, 0)
    assert.equal(uploadCount, 0)
    assert.equal(host.store.list().length, 1)
    assert.deepEqual([...host.io.of('/dashboard').sockets.values()].flatMap((socket) => [...socket.rooms]).filter((room) => room.startsWith('session:')), [])
    await rootDraft()
    assert.equal(await page.$eval(testId('composer-input'), (element) => element.value), '')
    assert.equal(creates.length, 0)
  })
  for (const width of [1440, 390]) {
    for (const runtime of ['kernel', 'copilot']) {
      await step(`${width}px ${runtime} first send materializes and delivers once`, async () => {
        await rootDraft(width, width === 1440)
        const before = creates.length
        await submit(`${runtime}-${width}`, runtime)
        await wait(() => creates.length === before + 1, 'one created conversation')
        const id = creates.at(-1).sessionId
        await selected(id)
        assertChat(id, runtime)
        await assertHostOnlyHealth()
        assert.equal(probes.filter((probe) => probe.event === 'client:executor_ping').length, 0)
        await page.waitForFunction((text) => document.body.textContent.includes(text), {}, `${runtime === 'kernel' ? 'Kernel' : 'Copilot'} reply: ${runtime}-${width}`)
        await newDraft()
        assert.equal(creates.length, before + 1)
      })
    }
  }
  await step('explicit query and notification hash links open existing sessions', async () => {
    for (const suffix of [`?sessionId=${existing}`, `#/sessions/${existing}`]) {
      await page.goto(`${origin}/${suffix}`, { waitUntil: 'networkidle2' })
      await selected(existing)
      await page.waitForFunction(() => document.body.textContent.includes('Previously selected chat'))
    }
    await rootDraft(390, false)
    assert.equal(new URL(page.url()).searchParams.has('sessionId'), false)
    await openExplorer()
    await page.click(`[data-testid="session-row"][data-session-id="${existing}"]`)
    await selected(existing)
    await newDraft()
  })
  await step('attachments upload only at first send and reach the Copilot SDK boundary', async () => {
    await rootDraft()
    const before = uploadCount
    await (await page.$(testId('composer-file-input'))).uploadFile(resolve(evidence, 'notes.txt'))
    await page.waitForSelector(testId('attachment-tray'))
    assert.equal(uploadCount, before)
    await submit('read attached file', 'copilot')
    await wait(() => uploadCount === before + 1, 'one deferred upload')
    const id = creates.at(-1).sessionId
    await selected(id)
    assertChat(id, 'copilot')
    assert.equal(sdkCalls.at(-1).attachments, 1)
  })
  await step('rejected first send restores text and retries the same materialized session', async () => {
    await rootDraft()
    const before = creates.length
    intercept = 'reject'
    await submit('retry rejected message')
    await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]')?.value === 'retry rejected message')
    assert.equal(creates.length, before + 1)
    const id = creates.at(-1).sessionId
    await page.click(testId('composer-send'))
    await selected(id)
    assert.equal(creates.length, before + 1)
    assertChat(id, 'kernel')
  })
  await step('lost admission acknowledgements retry the same operation without duplicate messages', async () => {
    await rootDraft()
    const before = admissions.length
    intercept = 'lose-ack'
    await submit('uncertain first message')
    await page.waitForSelector(testId('draft-retry-send'), { visible: true })
    const id = creates.at(-1).sessionId
    assert.equal(admissions.length, before + 3)
    assert.equal(new Set(admissions.slice(before).map((item) => item.operationId)).size, 1)
    intercept = null
    await page.click(testId('draft-retry-send'))
    await selected(id)
    assert.equal(new Set(admissions.slice(before).map((item) => item.operationId)).size, 1)
    assertChat(id, 'kernel')
    assert.equal(kernelCalls.filter((text) => text === 'uncertain first message').length, 1)
  })
  executor = io(`${origin}/executor`, { transports: ['websocket'], auth: { role: 'executor', clientVersion: PROTOCOL_VERSION }, reconnection: false })
  executor.on('executor:health_ping', (_sentAt, ack) => ack(Date.now()))
  executor.on('tool:call', (payload, ack) => {
    const result = payload.name === '__fs_list_dirs'
      ? { requestId: payload.input.requestId, workspaceId: payload.input.workspaceId, path: payload.input.path ?? root, roots: [root], entries: [] }
      : { requestId: payload.input.requestId, tasks: [], files: [], stdout: '', stderr: '', exitCode: 1, durationMs: 0 }
    ack({ callId: payload.callId, ok: true, content: JSON.stringify(result) })
  })
  await new Promise((done) => executor.once('connect', done))
  executor.emit('executor:announce', { executorId: 'draft-executor', workspaceId: 'draft-workspace', workspaceName: 'Draft workspace fixture', tools: [], sandboxRoots: [root], runtime: 'node', runtimeVersion: '22' })
  await wait(() => host.executorsSnapshot().length === 1, 'workspace connection')
  await step('saved workspace order still pins Chats first without duplicate child bubbles', async () => {
    await page.evaluate(() => localStorage.setItem('agent-kernel:explorer:workspace-order:v1', JSON.stringify(['draft-workspace'])))
    await rootDraft()
    await openExplorer()
    const rows = await page.$$eval(testId('workspace-row'), (elements) => elements.map((element) => element.getAttribute('data-workspace-id')))
    assert.equal(rows[0], 'unassigned')
    assert(rows.includes('draft-workspace'))
    assert(await page.$(testId('chats-icon')))
    assert.equal(await page.$(testId('chat-session-icon')), null)
    assert(await page.$('[data-testid="session-row"] [data-testid="session-status-indicator"]'))
  })
  for (const width of [1440, 390]) {
    await step(`${width}px workspace plus preserves cwd while New chat remains workspace-free`, async () => {
      await rootDraft(width)
      await openExplorer()
      await page.waitForSelector(testId('workspace-new-session-draft-workspace'), { visible: true })
      await page.click(testId('workspace-new-session-draft-workspace'))
      await page.waitForSelector(testId('new-session-scoped-workspace'), { visible: true })
      await page.click(testId('new-session-runtime-kernel'))
      await page.click(testId('new-session-create'))
      await wait(() => creates.at(-1)?.workspaceId === 'draft-workspace', 'workspace creation')
      const workspaceSession = creates.at(-1).sessionId
      await page.waitForFunction((id) => new URL(location.href).searchParams.get('sessionId') === id, {}, workspaceSession)
      assert.equal(host.store.get(workspaceSession).state.cwd, root)
      await page.waitForSelector(testId('new-session-dialog'), { hidden: true })
      await sleep(350)
      await wait(() => probes.some((probe) => probe.workspaceId === 'draft-workspace'), 'real workspace executor probe')
      await page.click(testId('connection-status'))
      await page.waitForSelector(testId('connection-segment-service-executor'), { visible: true })
      await page.click(testId('connection-status'))
      await sleep(300)
      await openExplorer()
      await page.waitForSelector(testId('workspace-new-session-draft-workspace'), { visible: true })
      await page.click(testId('workspace-new-session-draft-workspace'))
      await page.waitForSelector(testId('new-session-simple-chat'), { visible: true })
      const before = creates.length
      await page.click(testId('new-session-runtime-copilot'))
      await page.click(testId('new-session-simple-chat'))
      await page.waitForSelector(testId('simple-chat-draft'), { visible: true })
      await page.waitForSelector(testId('new-session-dialog'), { hidden: true })
      await sleep(300)
      assert.equal(creates.length, before)
      assert.equal(await page.$eval(testId('draft-runtime-copilot'), (element) => element.getAttribute('aria-checked')), 'true')
      await submit(`workspace-free ${width}`, 'copilot')
      await wait(() => creates.length === before + 1, 'first send from workspace picker draft')
      await selected(creates.at(-1).sessionId)
      assertChat(creates.at(-1).sessionId, 'copilot')
      const executorProbeCount = probes.filter((probe) => probe.event === 'client:executor_ping').length
      await assertHostOnlyHealth()
      assert.equal(probes.filter((probe) => probe.event === 'client:executor_ping').length, executorProbeCount)
    })
  }
  await step('host-only Chats expose real host probe timeouts and recover after resynchronizing', async () => {
    await rootDraft()
    await page.goto(`${origin}/?sessionId=${existing}`, { waitUntil: 'networkidle2' })
    await selected(existing)
    failHostProbe = true
    await page.click(testId('connection-status'))
    await page.waitForSelector('[data-testid="connection-status"][data-status="error"]')
    assert.equal(await page.$(testId('connection-segment-service-executor')), null)
    failHostProbe = false
    await page.evaluate(() => [...document.querySelectorAll('button')].find((element) => element.textContent === 'Measure again').click())
    await page.waitForSelector('[data-testid="connection-status"][data-status="ready"]')
    await page.evaluate(() => [...document.querySelectorAll('button')].find((element) => element.textContent === 'Resync').click())
    await page.waitForSelector('[data-testid="connection-status"][data-status="ready"]')
  })
  await step('switching a workspace with pending executor probes to Chat cannot leak stale errors', async () => {
    const workspaceSession = creates.find((item) => item.workspaceId === 'draft-workspace').sessionId
    holdExecutorProbe = true
    await page.goto(`${origin}/?sessionId=${workspaceSession}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(testId('composer-input'), { visible: true })
    await openExplorer()
    await page.click(`[data-testid="session-row"][data-session-id="${existing}"]`)
    await selected(existing)
    await sleep(4000)
    holdExecutorProbe = false
    await assertHostOnlyHealth()
  })
  assert.deepEqual(errors, [])
} catch (error) {
  steps.push({ name: 'failure', pass: false, error: error.stack ?? String(error) })
  process.exitCode = 1
  console.error(error)
} finally {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: resolve(evidence, 'final.png') })
    await writeFile(resolve(evidence, 'final-dom.txt'), await page.evaluate(() => document.body.innerText))
  }
  await browser?.close()
  executor?.close()
  await host?.close()
  CopilotAgentRuntime.prototype.start = originalStart
  CopilotAgentRuntime.prototype.ensureSession = originalEnsure
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify({ steps, errors, creates, admissions, sdkCalls, kernelCalls, probes, uploadCount, generatedAt: new Date().toISOString() }, null, 2))
  await rm(stateRoot, { recursive: true, force: true })
  await rm(resolve(evidence, 'chrome-profile'), { recursive: true, force: true })
  await rm(resolve(evidence, 'push-vapid.json'), { force: true })
}

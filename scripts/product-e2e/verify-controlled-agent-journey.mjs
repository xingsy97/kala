#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProductE2EHarness, clickByTestId, clickElement, clickFirstVisible, hoverAncestorAndClickFirst, runCommand, sha256File, startProcess, waitFor, waitForHttp } from './harness.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const bundle = join(root, 'release', 'bundle-dashboard-with-runtime.cjs')
const executorAsset = join(root, 'release', 'agent-kernel-executor.cjs')
const hostPort = Number(process.env.PRODUCT_E2E_AGENT_PORT ?? 3197)
const providerPort = Number(process.env.PRODUCT_E2E_PROVIDER_PORT ?? 3198)
const origin = `http://127.0.0.1:${hostPort}`
const providerOrigin = `http://127.0.0.1:${providerPort}`
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-e2e-agent-state-'))
const home = join(stateRoot, 'home')
const sessionsDir = join(stateRoot, 'sessions')
const workspace = join(stateRoot, 'workspace')
const token = `agent-e2e-${process.pid}-${Date.now()}`
const customPrompt = `Controlled provider prompt ${Date.now()}\n\nWhen referencing a file, use [filename](path/to/this/file).`
const intention = 'Read the real fixture so the controlled tool flow proves Host and Executor integration.'
const harness = new ProductE2EHarness({ name: 'controlled-agent-journey' })
const providerRequests = []
const hostLogs = []
const executorLogs = []
let releaseFirstProvider
const firstProviderGate = new Promise((resolve) => { releaseFirstProvider = resolve })
let subAgentSpawned = false
let subAgentCompleted = false
let cancellableSubAgentSpawned = false
let releaseCancelledChild
const cancelledChildGate = new Promise((resolve) => { releaseCancelledChild = resolve })
let actor
let primarySessionId
let secondarySessionId
let result
let thrown

mkdirSync(join(home, '.claude'), { recursive: true })
mkdirSync(join(home, '.config', 'agent-kernel'), { recursive: true })
mkdirSync(sessionsDir, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'controlled.txt'), 'CONTROLLED_TOOL_FILE\n', 'utf8')
writeFileSync(join(home, '.claude', 'settings.json'), '{}\n', 'utf8')
writeFileSync(join(home, '.config', 'agent-kernel', 'agent.json'), `${JSON.stringify({ systemPromptPreset: 'custom', customSystemPrompt: customPrompt }, null, 2)}\n`)

const provider = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/messages') { res.writeHead(404).end(); return }
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  providerRequests.push(body)
  const latestRequestText = JSON.stringify((body.messages ?? []).at(-1) ?? null)
  if (latestRequestText.includes('Child must fail from provider')) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'SUBAGENT_PROVIDER_FAILURE' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  if (latestRequestText.includes('spawn failing subagent')) {
    sendToolResponse(res, 'controlled-agent-fail', 'agent', { prompt: 'Child must fail from provider.', max_turns: 1, _intent: 'Spawn a child whose provider fails to prove failure propagation.' }, 'msg_agent_fail')
  } else if (latestRequestText.includes('run controlled background shell')) {
    sendToolResponse(res, 'controlled-background-shell-1', 'shell', { command: "printf 'BACKGROUND_SHELL_E2E_READY\\n'; sleep 60", run_in_background: true, _intent: 'Start a real long-running background shell for Workspace registry verification.' }, 'msg_background_shell')
  } else if (latestRequestText.includes('controlled-background-shell-1')) {
    sendTextResponse(res, 'BACKGROUND_SHELL_STARTED', 'msg_background_shell_final')
  } else if (latestRequestText.includes('run controlled write shell test')) {
    sendToolResponse(res, 'matrix-search-1', 'tool_search', { query: 'write_file', limit: 4, _intent: 'Discover the file-writing tool before creating the matrix fixture.' }, 'msg_matrix_search')
  } else if (latestRequestText.includes('matrix-search-1')) {
    sendToolResponse(res, 'matrix-write-1', 'write_file', { path: 'matrix-e2e.txt', content: 'MATRIX_E2E_OK\n', _intent: 'Create the matrix fixture before validating it with a shell test.' }, 'msg_matrix_write')
  } else if (latestRequestText.includes('MATRIX_SHELL_OK')) {
    sendTextResponse(res, 'MATRIX_TOOL_CHAIN_COMPLETE', 'msg_matrix_final')
  } else if (latestRequestText.includes('matrix-write-1') || latestRequestText.includes('matrix-e2e.txt')) {
    sendToolResponse(res, 'matrix-shell-1', 'shell', { command: "test \"$(cat matrix-e2e.txt)\" = MATRIX_E2E_OK && printf MATRIX_SHELL_OK", _intent: 'Run a real shell assertion against the newly written fixture.' }, 'msg_matrix_shell')
  } else if (latestRequestText.includes('attempt denied outside read')) {
    sendSse(res, { type: 'message_start', message: { id: 'msg_denied', usage: { input_tokens: 8, output_tokens: 0 } } })
    sendSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'controlled-denied-read', name: 'read_file', input: {} } })
    sendSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: '../outside.txt', _intent: 'Attempt an out-of-workspace read to prove sandbox denial reaches the UI.' }) } })
    sendSse(res, { type: 'content_block_stop', index: 0 })
    sendSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
  } else if (latestRequestText.includes('spawn cancellable subagent') && !cancellableSubAgentSpawned) {
    cancellableSubAgentSpawned = true
    sendSse(res, { type: 'message_start', message: { id: 'msg_agent_cancel', usage: { input_tokens: 10, output_tokens: 0 } } })
    sendSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'controlled-agent-cancel', name: 'agent', input: {} } })
    sendSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ prompt: 'Wait until interrupted and do not finish.', max_turns: 3, _intent: 'Start a cancellable child to verify interruption and cleanup.' }) } })
    sendSse(res, { type: 'content_block_stop', index: 0 })
    sendSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } })
  } else if (latestRequestText.includes('Wait until interrupted and do not finish')) {
    await cancelledChildGate
    if (!res.writableEnded && !res.destroyed) sendTextResponse(res, 'UNEXPECTED_CHILD_COMPLETION', 'msg_cancel_child')
  } else if (latestRequestText.includes('spawn controlled subagent') && !subAgentSpawned) {
    subAgentSpawned = true
    sendSse(res, { type: 'message_start', message: { id: 'msg_agent', usage: { input_tokens: 10, output_tokens: 0 } } })
    sendSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'controlled-agent-1', name: 'agent', input: {} } })
    sendSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ prompt: 'Return SUBAGENT_E2E_SUCCESS and finish.', max_turns: 2, _intent: 'Delegate a bounded child task to prove the complete sub-agent lifecycle.' }) } })
    sendSse(res, { type: 'content_block_stop', index: 0 })
    sendSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } })
  } else if (latestRequestText.includes('Return SUBAGENT_E2E_SUCCESS') && !subAgentCompleted) {
    subAgentCompleted = true
    sendTextResponse(res, 'SUBAGENT_E2E_SUCCESS', 'msg_child')
  } else if (subAgentCompleted && latestRequestText.includes('SUBAGENT_E2E_SUCCESS')) {
    sendTextResponse(res, 'Parent observed child success.', 'msg_parent_final')
  } else if (latestRequestText.includes('Read controlled.txt and report the result.')) {
    sendSse(res, { type: 'message_start', message: { id: 'msg_tool', usage: { input_tokens: 10, output_tokens: 0 } } })
    for (let index = 0; index < 3; index += 1) {
      sendSse(res, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `controlled-read-${index + 1}`, name: 'read_file', input: {} } })
    }
    await firstProviderGate
    for (let index = 0; index < 3; index += 1) {
      sendSse(res, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'controlled.txt', _intent: `${intention} Step ${index + 1}.` }) } })
      sendSse(res, { type: 'content_block_stop', index })
    }
    sendSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 18 } })
  } else {
    sendSse(res, { type: 'message_start', message: { id: 'msg_final', usage: { input_tokens: 20, output_tokens: 0 } } })
    sendSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const text of ['Controlled ', 'tool flow ', 'completed.']) {
      sendSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      await sleep(100)
    }
    sendSse(res, { type: 'content_block_stop', index: 0 })
    sendSse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })
  }
  sendSse(res, { type: 'message_stop' })
  res.end()
})

function startHost(label) {
  const host = startProcess(bundle, [], { cwd: root, env: {
    ...process.env,
    HOME: home,
    HOST_LISTEN_HOST: '127.0.0.1', HOST_PORT: String(hostPort), SESSIONS_DIR: sessionsDir,
    AGENT_KERNEL_ARTIFACTS_DIR: join(stateRoot, 'artifacts'), EXECUTOR_TOKENS: JSON.stringify([{ token }]),
    ANTHROPIC_API_KEY: 'controlled-key', ANTHROPIC_MODEL: 'controlled-model', ANTHROPIC_BASE_URL: `${providerOrigin}/v1/messages`,
  } })
  harness.registerProcess(label, host, hostLogs)
  return host
}

try {
  if (!existsSync(bundle) || !existsSync(executorAsset)) throw new Error('production release assets are missing')
  await new Promise((resolve) => provider.listen(providerPort, '127.0.0.1', resolve))
  harness.registerResource('controlled-provider', String(providerPort), async () => await new Promise((resolve) => provider.close(resolve)))
  await harness.start()
  harness.registerResource('state-root', stateRoot, async () => rmSync(stateRoot, { recursive: true, force: true }))

  await harness.step('start production Host and Executor with controlled protocol provider', async () => {
    const host = startHost('production-host-initial')
    await waitForHttp(`${origin}/settings`)
    const executor = startProcess(executorAsset, ['--host', origin, '--sandbox-root', workspace], { cwd: workspace, env: {
      ...process.env, HOME: home, HOST_URL: origin, EXECUTOR_TOKEN: token, WORKSPACE_NAME: 'controlled-agent-workspace',
      AGENT_KERNEL_WORKSPACE_ID_FILE: join(stateRoot, 'workspace-id'),
    } })
    harness.registerProcess('production-executor', executor, executorLogs)
    await waitFor(() => executorLogs.some((line) => line.includes('executor announced')), { timeoutMs: 30_000, name: 'Executor announce' })
    return { host: sha256File(bundle), executor: sha256File(executorAsset), providerProtocol: 'Anthropic Messages SSE' }
  })

  actor = await harness.newActor('operator')
  await actor.page.evaluateOnNewDocument(() => {
    const original = window.matchMedia.bind(window)
    window.matchMedia = (query) => query === '(hover: hover) and (pointer: fine)'
      ? { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }
      : original(query)
  })
  await actor.page.goto(origin, { waitUntil: 'networkidle2' })
  primarySessionId = await createSession(actor.page)
  secondarySessionId = await createSession(actor.page)
  await selectSession(actor.page, primarySessionId)

  await harness.step('send message and switch Sessions during a live provider stream', async () => {
    await setAllowAll(actor.page)
    await clickByTestId(actor.page, 'send-mode-toggle')
    await clickByTestId(actor.page, 'send-mode-queue')
    await clickByTestId(actor.page, 'composer-input')
    await actor.page.keyboard.type('Read controlled.txt and report the result.')
    await clickByTestId(actor.page, 'composer-send')
    await waitFor(() => providerRequests.length >= 1, { timeoutMs: 20_000, name: 'provider request' })
    for (const text of ['queue-second', 'queue-third', 'queue-delete']) {
      await clickByTestId(actor.page, 'composer-input')
      await actor.page.keyboard.type(text)
      await clickByTestId(actor.page, 'composer-send')
    }
    await actor.page.waitForFunction(() => document.querySelectorAll('[data-testid="queued-message-row"]').length === 3)
    await waitFor(() => {
      const file = readdirSync(sessionsDir).find((name) => name.includes(primarySessionId))
      const text = file ? readFileSync(join(sessionsDir, file), 'utf8') : ''
      return text.includes('queue-second') && text.includes('queue-third') && text.includes('queue-delete')
    }, { timeoutMs: 20_000, name: 'three persisted queue messages' })
    const rows = await actor.page.$$('[data-testid="queued-message-row"]')
    await clickElement(await rows[1].$('[data-testid="queued-message-edit"]'), 'Edit queued message')
    const editInput = await actor.page.waitForSelector('[data-testid="queued-message-edit-input"]')
    await clickElement(editInput, 'Queued message editor')
    await actor.page.keyboard.down('Control'); await actor.page.keyboard.press('KeyA'); await actor.page.keyboard.up('Control')
    await actor.page.keyboard.type('queue-third-edited')
    const editedValue = await editInput.evaluate((element) => element.value)
    if (editedValue !== 'queue-third-edited') throw new Error(`queued message editor contains ${JSON.stringify(editedValue)}`)
    await clickByTestId(actor.page, 'queued-message-save')
    await actor.page.waitForFunction(() => (document.querySelector('[data-testid="queued-messages-dock"]')?.textContent ?? '').includes('queue-third-edited'))
    const updatedRows = await actor.page.$$('[data-testid="queued-message-row"]')
    const editedRow = await findRowByText(updatedRows, 'queue-third-edited')
    await clickElement(await editedRow.$('[data-testid="queued-message-up"]'), 'Move queued message up')
    const deleteRows = await actor.page.$$('[data-testid="queued-message-row"]')
    const deleteRow = await findRowByText(deleteRows, 'queue-delete')
    await clickElement(await deleteRow.$('[data-testid="queued-message-delete"]'), 'Delete queued message')
    await actor.page.waitForFunction(() => {
      const text = document.querySelector('[data-testid="queued-messages-dock"]')?.textContent ?? ''
      return document.querySelectorAll('[data-testid="queued-message-row"]').length === 2 && text.includes('queue-third-edited') && !text.includes('queue-delete')
    })
    const expectedConsoleStart = actor.consoleErrors.length
    const expectedFailureStart = actor.requestFailures.length
    const initialHost = harness.resources.find((item) => item.kind === 'process' && item.id === 'production-host-initial')
    await initialHost.cleanup(); initialHost.cleaned = true
    const reconnectLogStart = executorLogs.length
    startHost('production-host-restarted-during-turn')
    await waitForHttp(`${origin}/settings`, { timeoutMs: 30_000 })
    await waitFor(() => executorLogs.slice(reconnectLogStart).some((line) => line.includes('socket connected; announcing workspace')), { timeoutMs: 30_000, name: 'Executor reconnect after Host restart' })
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForSelector('[data-testid="workspace-row"][data-online="true"]', { timeout: 30_000 })
    await actor.page.waitForFunction(() => {
      const text = document.querySelector('[data-testid="queued-messages-dock"]')?.textContent ?? ''
      return document.querySelectorAll('[data-testid="queued-message-row"]').length === 2 && text.includes('queue-third-edited') && text.includes('queue-second')
    }, { timeout: 30_000 })
    const restartConsole = actor.consoleErrors.slice(expectedConsoleStart)
    const restartFailures = actor.requestFailures.slice(expectedFailureStart)
    if (restartConsole.some((message) => !message.includes('ERR_CONNECTION_REFUSED')) || restartFailures.some((item) => !item.error.includes('ERR_CONNECTION_REFUSED'))) {
      throw new Error(`unexpected restart errors: ${JSON.stringify({ restartConsole, restartFailures })}`)
    }
    actor.consoleErrors.splice(expectedConsoleStart)
    actor.requestFailures.splice(expectedFailureStart)
    const started = performance.now()
    await selectSession(actor.page, secondarySessionId)
    const switchedInMs = Math.round(performance.now() - started)
    if (switchedInMs > 1_000) throw new Error(`running Session switch took ${switchedInMs}ms`)
    const primaryRow = await visibleSessionRow(actor.page, primarySessionId)
    await primaryRow.hover()
    await actor.page.waitForSelector('[data-testid="session-hover-preview"]', { timeout: 10_000 })
    await actor.page.waitForFunction(() => document.querySelector('[data-testid="session-hover-preview-freshness"]')?.textContent === 'live', { timeout: 5_000 })
    const freshness = await actor.page.$eval('[data-testid="session-hover-preview-freshness"]', (element) => element.textContent ?? '')
    const previewText = await actor.page.$eval('[data-testid="session-hover-preview-summary"]', (element) => element.textContent ?? '')
    if (!previewText.includes('Read controlled.txt')) throw new Error(`preview omitted latest content: ${previewText.slice(0, 500)}`)
    releaseFirstProvider()
    await selectSession(actor.page, primarySessionId)
    return { primarySessionId, secondarySessionId, switchedInMs, previewFreshness: freshness }
  })

  await harness.step('prove custom prompt, tool intention, real result, and final response', async () => {
    await actor.page.waitForFunction(() => document.body.innerText.includes('Controlled tool flow completed.'), { timeout: 30_000 })
    await waitFor(() => {
      const file = readdirSync(sessionsDir).find((name) => name.includes(primarySessionId))
      if (!file) return false
      const lines = readFileSync(join(sessionsDir, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      const userTexts = lines.filter((entry) => entry.kind === 'event' && entry.event?.kind === 'user_message').map((entry) => entry.event.text)
      return userTexts.filter((text) => text === 'queue-second').length === 1
        && userTexts.filter((text) => text === 'queue-third-edited').length === 1
        && userTexts.filter((text) => text === 'queue-delete').length === 0
    }, { timeoutMs: 30_000, name: 'exactly-once queued message commits' })
    const requestSystem = Array.isArray(providerRequests[0]?.system)
      ? providerRequests[0].system.map((block) => block?.text ?? '').join('\n')
      : String(providerRequests[0]?.system ?? '')
    if (!requestSystem.includes(customPrompt)) throw new Error(`custom prompt missing from real provider request: ${requestSystem.slice(0, 1_500)}`)
    await actor.page.waitForSelector('[data-testid="tool-card-dot-group-controlled-read-1"]')
    await actor.page.waitForFunction(() => document.querySelector('[data-testid="tool-card-dot-count-controlled-read-1"]')?.textContent === '×3')
    await actor.page.waitForSelector('[data-testid="tool-card-dots-intent-controlled-read-1"]')
    const intent = await actor.page.$eval('[data-testid="tool-card-dots-intent-controlled-read-1"]', (element) => element.textContent ?? '')
    if (!intent.includes(intention)) throw new Error(`intention missing from dot line: ${intent}`)
    const geometry = await actor.page.evaluate(() => {
      const dot = document.querySelector('[data-testid="tool-card-dot-group-controlled-read-1"]')?.getBoundingClientRect()
      const rail = document.querySelector('[data-testid="tool-activity-rail"]')?.getBoundingClientRect()
      const chat = document.querySelector('[data-testid="chat-panel"]')?.getBoundingClientRect()
      const rect = (value) => value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom } : null
      return { dot: rect(dot), rail: rect(rail), chat: rect(chat) }
    })
    if (!geometry.dot || !geometry.rail || !geometry.chat || geometry.dot.left < geometry.chat.left || geometry.dot.right > geometry.chat.right || geometry.rail.right > geometry.chat.right) {
      throw new Error(`invalid tool rail geometry: ${JSON.stringify(geometry)}`)
    }
    await clickByTestId(actor.page, 'tool-card-dot-group-controlled-read-1')
    await clickFirstVisible(actor.page, '[data-testid^="grouped-tool-row-controlled-read-"]', { description: 'Expanded controlled read row' })
    const previewText = await actor.page.$eval('[data-testid="tool-call-group-details-controlled-read-1"]', (element) => element.textContent ?? '')
    const resultVisible = previewText.includes('CONTROLLED_TOOL_FILE')
    if (!previewText.includes(intention) || !resultVisible) throw new Error(`expanded tool detail/result is incomplete: ${previewText.slice(0, 1_500)}`)
    await harness.screenshot(actor, 'controlled-tool-complete')
    return { providerRequests: providerRequests.length, intention, resultVisible: true, customPromptForwarded: true, toolCount: 3, geometry }
  })

  await harness.step('run real write and shell test tool chain', async () => {
    const matrixSessionId = await createSession(actor.page)
    await setAllowAll(actor.page)
    await clickByTestId(actor.page, 'composer-input')
    await actor.page.keyboard.type('run controlled write shell test')
    await clickByTestId(actor.page, 'composer-send')
    try {
      await actor.page.waitForFunction(() => document.body.innerText.includes('MATRIX_TOOL_CHAIN_COMPLETE'), { timeout: 30_000 })
    } catch (error) {
      const recent = providerRequests.slice(-6).map((request) => JSON.stringify((request.messages ?? []).at(-1) ?? null))
      const ui = await actor.page.evaluate(() => ({
        approval: document.querySelector('[data-testid="approval-card"]')?.textContent ?? null,
        composer: document.querySelector('[data-testid="composer-input"]')?.value ?? null,
        sendMode: document.querySelector('[data-testid="send-mode-toggle"]')?.getAttribute('aria-label') ?? null,
        bodyTail: document.body.innerText.slice(-2_000),
      }))
      throw new Error(`matrix flow did not finish; recent provider messages: ${JSON.stringify(recent)}; ui=${JSON.stringify(ui)}`, { cause: error })
    }
    if (readFileSync(join(workspace, 'matrix-e2e.txt'), 'utf8') !== 'MATRIX_E2E_OK\n') throw new Error('write_file side effect missing')
    await actor.page.waitForSelector('[data-testid="tool-card-dot-matrix-search-1"]')
    await actor.page.waitForSelector('[data-testid="tool-card-dot-matrix-write-1"]')
    await actor.page.waitForSelector('[data-testid="tool-card-dot-matrix-shell-1"]')
    return { sessionId: matrixSessionId, fileWritten: true, shellAsserted: true }
  })

  await harness.step('run, inspect, reload, and kill a real background Workspace shell', async () => {
    const backgroundSessionId = await createSession(actor.page)
    await setAllowAll(actor.page)
    await clickByTestId(actor.page, 'composer-input')
    await actor.page.keyboard.type('run controlled background shell')
    await clickByTestId(actor.page, 'composer-send')
    await actor.page.waitForFunction(() => document.body.innerText.includes('BACKGROUND_SHELL_STARTED'), { timeout: 30_000 })
    await clickByTestId(actor.page, 'background-shells-trigger')
    await actor.page.waitForSelector('[data-testid^="bg-task-row-"]', { visible: true, timeout: 30_000 })
    await actor.page.waitForFunction(() => document.body.innerText.includes('BACKGROUND_SHELL_E2E_READY'), { timeout: 30_000 })
    const taskId = await actor.page.$eval('[data-testid^="bg-task-row-"]', (element) =>
      element.getAttribute('data-testid')?.replace('bg-task-row-', '') ?? '')
    if (!taskId) throw new Error('background shell task id is missing')
    await actor.page.keyboard.press('Escape')
    await actor.page.waitForSelector('[data-testid="background-terminal-panel"]', { hidden: true })
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForFunction((expected) => new URL(location.href).searchParams.get('sessionId') === expected, {}, backgroundSessionId)
    await clickByTestId(actor.page, 'background-shells-trigger')
    await actor.page.waitForSelector(`[data-testid="bg-task-row-${taskId}"]`, { visible: true, timeout: 30_000 })
    await actor.page.waitForFunction(() => document.body.innerText.includes('BACKGROUND_SHELL_E2E_READY'), { timeout: 30_000 })
    await clickByTestId(actor.page, `bg-task-kill-selected-${taskId}`)
    await actor.page.waitForFunction((expectedTaskId) => {
      const row = document.querySelector(`[data-testid="bg-task-row-${expectedTaskId}"]`)
      return /killed|signaled|exited/iu.test(row?.textContent ?? '')
    }, { timeout: 30_000 }, taskId)
    await actor.page.keyboard.press('Escape')
    await actor.page.waitForSelector('[data-testid="background-terminal-panel"]', { hidden: true })
    return { sessionId: backgroundSessionId, taskId, outputVisible: true, survivedReload: true, killed: true }
  })

  await harness.step('surface real sandbox path denial in tool UI', async () => {
    const denialSessionId = await createSession(actor.page)
    await setAllowAll(actor.page)
    await clickByTestId(actor.page, 'composer-input')
    await actor.page.keyboard.type('attempt denied outside read')
    await clickByTestId(actor.page, 'composer-send')
    await actor.page.waitForSelector('[data-testid="tool-card-dot-controlled-denied-read"]', { timeout: 30_000 })
    const deniedDot = await actor.page.$('[data-testid="tool-card-dot-controlled-denied-read"]')
    const deniedGroupHandle = await deniedDot.evaluateHandle((element) => element.closest('[data-testid^="tool-call-group-"]'))
    const deniedGroup = deniedGroupHandle.asElement()
    await clickElement(await deniedGroup?.$('[data-testid="tool-activity-direction"]'), 'Expand denied tool activity')
    await actor.page.waitForSelector('[data-testid="tool-call-group-details-controlled-denied-read"]')
    const denialText = await actor.page.$eval('[data-testid="tool-call-group-details-controlled-denied-read"]', (element) => element.textContent ?? '')
    if (!/EACCES|outside|denied|not allowed/iu.test(denialText)) throw new Error(`sandbox denial missing: ${denialText}`)
    return { sessionId: denialSessionId, denied: true, diagnostic: denialText.slice(-500) }
  })

  await selectSession(actor.page, primarySessionId)
  await harness.step('spawn and complete a live Sub-agent Session', async () => {
    await clickByTestId(actor.page, 'composer-input')
    await actor.page.keyboard.type('spawn controlled subagent')
    await clickByTestId(actor.page, 'composer-send')
    await actor.page.waitForSelector('[data-testid="sub-agent-row-controlled-agent-1"]', { timeout: 30_000 })
    await actor.page.waitForFunction(() => document.querySelector('[data-testid="sub-agent-row-controlled-agent-1"]')?.getAttribute('data-sub-agent-status') === 'completed', { timeout: 30_000 })
    await clickFirstVisible(actor.page, '[data-testid="sub-agent-dot-controlled-agent-1"], [data-testid="sub-agent-toggle-controlled-agent-1"]', { description: 'Completed Sub-agent details' })
    const childLog = await waitFor(() => {
      const file = readdirSync(sessionsDir).find((name) => !name.includes(primarySessionId) && !name.includes(secondarySessionId) && readFileSync(join(sessionsDir, name), 'utf8').includes('SUBAGENT_E2E_SUCCESS'))
      return file ? join(sessionsDir, file) : undefined
    }, { timeoutMs: 30_000, name: 'persisted child Session result' })
    return { spawned: subAgentSpawned, completed: subAgentCompleted, status: 'completed', childLog }
  })

  await harness.step('propagate a real child provider failure to the parent card', async () => {
    const failureSessionId = await createSession(actor.page)
    await setAllowAll(actor.page)
    await clickByTestId(actor.page, 'composer-input')
    await actor.page.keyboard.type('spawn failing subagent')
    await clickByTestId(actor.page, 'composer-send')
    await actor.page.waitForSelector('[data-testid="sub-agent-row-controlled-agent-fail"]', { timeout: 30_000 })
    await actor.page.waitForFunction(() => document.querySelector('[data-testid="sub-agent-row-controlled-agent-fail"]')?.getAttribute('data-sub-agent-status') === 'failed', { timeout: 30_000 })
    const cardText = await actor.page.$eval('[data-testid="sub-agent-row-controlled-agent-fail"]', (element) => element.textContent ?? '')
    return { sessionId: failureSessionId, failed: true, cardText: cardText.slice(-500) }
  })

  await harness.step('interrupt a live Sub-agent and persist cancelled state', async () => {
    const cancelSessionId = await createSession(actor.page)
    await actor.page.waitForSelector('[data-testid="composer-send"]', { timeout: 30_000 })
    await setAllowAll(actor.page)
    await clickByTestId(actor.page, 'composer-input')
    await actor.page.keyboard.type('spawn cancellable subagent')
    const requestsBefore = providerRequests.length
    await clickByTestId(actor.page, 'composer-send')
    await waitFor(() => providerRequests.length > requestsBefore, { timeoutMs: 20_000, name: 'cancellable parent provider request' })
    await actor.page.waitForSelector('[data-testid="sub-agent-row-controlled-agent-cancel"][data-sub-agent-status="running"]', { timeout: 30_000 })
    await clickByTestId(actor.page, 'sub-agent-interrupt-controlled-agent-cancel')
    await actor.page.waitForFunction(() => document.querySelector('[data-testid="sub-agent-row-controlled-agent-cancel"]')?.getAttribute('data-sub-agent-status') === 'cancelled', { timeout: 30_000 })
    releaseCancelledChild()
    return { spawned: cancellableSubAgentSpawned, status: 'cancelled', sessionId: cancelSessionId }
  })

  await harness.step('reload and replay tool intention/result from persistence', async () => {
    await selectSession(actor.page, primarySessionId)
    const expectedFailureStart = actor.requestFailures.length
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForSelector('[data-testid="tool-card-dot-group-controlled-read-1"]')
    const text = await actor.page.$eval('[data-testid="tool-card-dots-intent-controlled-read-1"]', (element) => element.textContent ?? '')
    if (!text.includes(intention)) throw new Error('persisted intention missing after reload')
    const reloadFailures = actor.requestFailures.slice(expectedFailureStart)
    if (reloadFailures.some((item) => !(item.error === 'net::ERR_ABORTED' && item.url.endsWith('/manifest.webmanifest')))) {
      throw new Error(`unexpected reload request failure: ${JSON.stringify(reloadFailures)}`)
    }
    actor.requestFailures.splice(expectedFailureStart)
    return { sessionId: primarySessionId, replayed: true, expectedManifestAborts: reloadFailures.length }
  })

} catch (error) { thrown = error } finally {
  releaseFirstProvider?.()
  releaseCancelledChild?.()
  result = await harness.finalize({
    revision: (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true })).stdout.trim(),
    controlledBoundaries: ['paid model provider replaced by same-protocol Anthropic Messages SSE server'],
    untestedExternalCapabilities: ['real Anthropic compatibility and model behavior'],
    primarySessionId, secondarySessionId, providerRequestCount: providerRequests.length,
    hostLogTail: hostLogs.slice(-80), executorLogTail: executorLogs.slice(-80),
  })
}
if (!thrown) { try { harness.assertClean(result.report) } catch (error) { thrown = error } }
if (thrown) { console.error(thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown)); console.error(`Evidence: ${result?.evidenceRoot ?? '<unavailable>'}`); process.exit(1) }
console.log(`PASS controlled-agent-journey system E2E\nEvidence: ${result.evidenceRoot}`)

async function createSession(page) {
  const previous = new URL(page.url()).searchParams.get('sessionId')
  await hoverAncestorAndClickFirst(page, '[data-testid^="workspace-new-session-"]', '[data-testid="workspace-row"]', { description: 'New Session for online Workspace' })
  await page.waitForSelector('[data-testid="new-session-dialog"]')
  await clickByTestId(page, 'new-session-create')
  await page.waitForFunction((oldId) => {
    const next = new URL(location.href).searchParams.get('sessionId')
    return Boolean(next && next !== oldId)
  }, {}, previous)
  await page.waitForSelector('[data-testid="new-session-dialog"]', { hidden: true })
  await page.waitForSelector('[data-testid="dialog-overlay"]', { hidden: true })
  await page.waitForSelector('[data-testid="composer-input"]')
  await clickByTestId(page, 'send-mode-toggle')
  await clickByTestId(page, 'send-mode-steer')
  return new URL(page.url()).searchParams.get('sessionId')
}

async function setAllowAll(page) {
  const successText = 'Approval mode changed to Allow all'
  const before = await page.evaluate((expected) => document.body.innerText.split(expected).length - 1, successText)
  await clickByTestId(page, 'approval-mode-picker')
  await clickByTestId(page, 'approval-mode-option-allow_all')
  await page.waitForFunction(() =>
    /allow all/iu.test(document.querySelector('[data-testid="approval-mode-picker"]')?.textContent ?? ''))
  await page.waitForFunction((expected, previous) =>
    document.body.innerText.split(expected).length - 1 > previous, {}, successText, before)
}

async function visibleSessionRow(page, id) {
  const selector = `[data-testid="session-row"][data-session-id="${id}"]`
  return await waitFor(async () => {
    const rows = await page.$$(selector)
    for (const row of rows) {
      if (await row.isVisible()) return row
    }
    return null
  }, { timeoutMs: 15_000, name: `visible Session row ${id}` })
}
async function selectSession(page, id) {
  const visible = await visibleSessionRow(page, id)
  const hit = await visible.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const x = rect.left + Math.min(100, rect.width / 2)
    const y = rect.top + rect.height / 2
    const target = document.elementFromPoint(x, y)
    return { x, y, target: target?.getAttribute('data-testid') ?? target?.tagName ?? null }
  })
  await page.mouse.click(hit.x, hit.y)
  try {
    await page.waitForFunction((expected) => new URL(location.href).searchParams.get('sessionId') === expected, { timeout: 10_000 }, id)
  } catch (error) {
    throw new Error(`clicking visible Session ${id} hit ${hit.target} but URL stayed ${page.url()}`, { cause: error })
  }
}
async function findRowByText(rows, text) {
  for (const row of rows) if (await row.evaluate((element, expected) => element.textContent?.includes(expected), text)) return row
  throw new Error(`queued row not found: ${text}`)
}
function sendToolResponse(res, callId, name, input, id) {
  sendSse(res, { type: 'message_start', message: { id, usage: { input_tokens: 5, output_tokens: 0 } } })
  sendSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name, input: {} } })
  sendSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  sendSse(res, { type: 'content_block_stop', index: 0 })
  sendSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
}
function sendTextResponse(res, text, id) {
  sendSse(res, { type: 'message_start', message: { id, usage: { input_tokens: 5, output_tokens: 0 } } })
  sendSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  sendSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  sendSse(res, { type: 'content_block_stop', index: 0 })
  sendSse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
}
function sendSse(res, value) { res.write(`data: ${JSON.stringify(value)}\n\n`) }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

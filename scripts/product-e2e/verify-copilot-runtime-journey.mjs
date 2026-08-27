#!/usr/bin/env node
import { randomUUID } from 'node:crypto'

import { io } from 'socket.io-client'

import { ProductE2EHarness, clickByTestId, waitFor } from './harness.mjs'

const origin = process.env.RUNLAB_URL ?? process.env.DASHBOARD_URL
const sourceRevision = process.env.RUNLAB_REVISION
const artifactDigest = process.env.RUNLAB_ARTIFACT_DIGEST
if (!origin) throw new Error('set RUNLAB_URL or DASHBOARD_URL to the production Agent RunLab origin')
if (!sourceRevision || !artifactDigest) {
  throw new Error('set RUNLAB_REVISION and RUNLAB_ARTIFACT_DIGEST to the exact deployed production artifact evidence')
}

const normalizedOrigin = origin.replace(/\/$/u, '')
const runId = randomUUID()
const executorMarker = `COPILOT_E2E_EXECUTOR_${runId}`
const executorFinalMarker = `COPILOT_E2E_EXECUTOR_DONE_${runId}`
const hostFinalMarker = `COPILOT_E2E_HOST_DONE_${runId}`
const hostNodeId = `copilot-e2e-host-${runId}`
const bootstrapSessionId = `copilot-e2e-bootstrap-${runId}`
const harness = new ProductE2EHarness({ name: 'copilot-runtime-official-provider-canary' })
const states = new Map()
let actor
let socket
let sessionId
let workspaceId
let workspaceName
let runtimeVersion
let result
let thrown
let deletedThroughUi = false

try {
  await harness.start()
  actor = await harness.newActor('operator')
  socket = io(`${normalizedOrigin}/dashboard`, {
    transports: ['websocket'],
    auth: { role: 'dashboard', sessionId: bootstrapSessionId, clientVersion: '1' },
    reconnection: false,
  })
  socket.on('state:changed', (payload) => {
    if (payload?.sessionId && payload.state) states.set(payload.sessionId, payload.state)
  })
  harness.registerResource('socket', bootstrapSessionId, async () => socket.close())

  await harness.step('preflight real Copilot Runtime and connected Workspace', async () => {
    await once(socket, 'session:ready', 20_000)
    const runtimesPromise = once(socket, 'server:agent_runtimes', 10_000)
    socket.emit('client:list_sessions', {})
    const runtimes = await runtimesPromise
    const copilot = runtimes.runtimes?.find((runtime) => runtime.id === 'copilot')
    if (!copilot?.available || copilot.status !== 'ready') {
      throw new Error(`Copilot runtime is not ready: ${copilot?.reason ?? copilot?.status ?? 'missing'}`)
    }
    runtimeVersion = copilot.version
    const executors = await responseEvent(socket, 'client:list_executors', 'server:executors', {})
    const executor = executors.executors?.find((candidate) => candidate.workspaceId)
    if (!executor) throw new Error('no connected Workspace Executor is available')
    workspaceId = executor.workspaceId
    workspaceName = executor.workspaceName
    return {
      sourceRevision,
      artifactDigest,
      runtime: { id: copilot.id, version: copilot.version, status: copilot.status },
      workspace: { workspaceId, workspaceName },
    }
  })

  await harness.step('select Copilot, prove cwd failure, retry, and create through production UI', async () => {
    await actor.page.goto(normalizedOrigin, { waitUntil: 'networkidle2' })
    await actor.page.evaluate(() => localStorage.removeItem('ak-agent-runtime'))
    await openNewSession(actor.page, workspaceId)
    const runtimeButton = await actor.page.$('[data-testid="new-session-runtime-copilot"]')
    if (!runtimeButton || await runtimeButton.evaluate((element) => element.hasAttribute('disabled'))) {
      throw new Error('Copilot runtime is not selectable in the production Session dialog')
    }
    await clickByTestId(actor.page, 'new-session-runtime-copilot')
    const rememberedRuntime = await actor.page.evaluate(() => localStorage.getItem('ak-agent-runtime'))
    if (rememberedRuntime !== 'copilot') throw new Error(`Copilot preference was not persisted: ${rememberedRuntime}`)

    const cwdSelector = '[data-testid="new-session-cwd-input"]'
    const validCwd = await actor.page.$eval(cwdSelector, (input) => input.value)
    if (!validCwd) throw new Error('selected Workspace did not expose a default directory')
    const invalidCwd = `${validCwd.replace(/\/+$/u, '')}/.runlab-copilot-e2e-missing-${runId}`
    await replaceInput(actor.page, cwdSelector, invalidCwd)
    await clickByTestId(actor.page, 'new-session-create')
    await actor.page.waitForSelector('[data-testid="new-session-error"]', { visible: true })
    const actionableError = await actor.page.$eval('[data-testid="new-session-error"]', (element) => element.textContent?.trim() ?? '')
    if (!actionableError || !/director|folder|path|目录|文件夹/iu.test(actionableError)) {
      throw new Error(`invalid cwd did not produce an actionable error: ${actionableError}`)
    }

    await replaceInput(actor.page, cwdSelector, validCwd)
    await clickByTestId(actor.page, 'new-session-create')
    await actor.page.waitForFunction(() => new URL(location.href).searchParams.has('sessionId'))
    sessionId = new URL(actor.page.url()).searchParams.get('sessionId')
    if (!sessionId) throw new Error('created Session ACK id is missing from the URL')
    harness.registerResource('session', sessionId, async () => {
      if (deletedThroughUi) return
      const response = await ack(socket, 'client:delete_session', {
        operationId: `operation-cleanup-${randomUUID()}`,
        sessionId,
      }).catch(() => undefined)
      if (response?.ok === false) throw new Error(`fallback Session cleanup failed: ${response.error ?? 'unknown error'}`)
    })
    const readyPromise = onceMatching(socket, 'session:ready', (payload) => payload?.sessionId === sessionId, 20_000)
    socket.emit('subscribe', { sessionId })
    const ready = await readyPromise
    states.set(sessionId, ready.state)
    if (ready.agentRuntime !== 'copilot') throw new Error(`created Session uses ${ready.agentRuntime ?? 'unknown'} instead of copilot`)
    return { sessionId, validCwd, invalidCwd, actionableError, agentRuntime: ready.agentRuntime }
  })

  await harness.step('expose the authoritative Copilot Runtime in Session Info', async () => {
    const row = await sessionRow(actor.page, sessionId)
    await row.hover()
    await row.$eval('[data-testid="session-info-button"]', (button) => button.click())
    await actor.page.waitForSelector('[data-testid="session-metadata-dialog"]')
    const runtimeText = await actor.page.$eval('[data-testid="session-metadata-agent-runtime"]', (element) => element.textContent ?? '')
    if (!runtimeText.includes('GitHub Copilot SDK') || !runtimeText.includes('(copilot)')) {
      throw new Error(`Session Info omitted the Copilot Runtime: ${runtimeText}`)
    }
    if (runtimeVersion && !runtimeText.includes(`v${runtimeVersion}`)) {
      throw new Error(`Session Info omitted Copilot Runtime version ${runtimeVersion}: ${runtimeText}`)
    }
    await actor.page.keyboard.press('Escape')
    await actor.page.waitForSelector('[data-testid="session-metadata-dialog"]', { hidden: true })
    return { runtimeText }
  })

  await harness.step('approve a real Copilot Executor tool and observe streaming final output', async () => {
    await actor.page.evaluate(() => {
      window.__copilotE2ESawStreaming = Boolean(document.querySelector('[data-testid="streaming-cursor"]'))
      window.__copilotE2EObserver = new MutationObserver(() => {
        if (document.querySelector('[data-testid="streaming-cursor"]')) window.__copilotE2ESawStreaming = true
      })
      window.__copilotE2EObserver.observe(document.body, { childList: true, subtree: true, attributes: true })
    })
    await setApprovalMode(actor.page, 'ask')
    const command = `printf '${executorMarker}\\n'`
    await sendMessage(actor.page, [
      'Call the shell tool exactly once before answering.',
      `Use exactly this JSON input: ${JSON.stringify({ command, _intent: 'Verify Copilot Executor tool approval and routing.' })}.`,
      `After the tool succeeds, write eight short numbered lines and finish with exactly ${executorFinalMarker}.`,
    ].join(' '))
    await actor.page.waitForSelector('[data-testid="approval-card"]', { visible: true, timeout: 120_000 })
    const approvalText = await actor.page.$eval('[data-testid="approval-card"]', (element) => element.textContent ?? '')
    if (!approvalText.includes(executorMarker)) throw new Error(`approval card omitted the real Executor command: ${approvalText}`)
    await clickByTestId(actor.page, 'approval-approve')
    const state = await waitForState(sessionId, (candidate) => (
      candidate.status === 'done'
      && successfulToolResult(candidate, 'shell', executorMarker)
      && assistantText(candidate).includes(executorFinalMarker)
    ), 180_000)
    await actor.page.waitForFunction((marker) => document.body.innerText.includes(marker), { timeout: 30_000 }, executorFinalMarker)
    const sawStreaming = await actor.page.evaluate(() => window.__copilotE2ESawStreaming === true)
    if (!sawStreaming) throw new Error('Copilot final response completed without an observed production streaming cursor')
    return {
      approvalText: approvalText.slice(0, 1_000),
      sawStreaming,
      status: state.status,
      cursor: state.cursor,
      executorTool: toolEvidence(state, 'shell'),
    }
  })

  await harness.step('route a real Copilot Host tool and persist its result', async () => {
    await setApprovalMode(actor.page, 'allow_all')
    const input = {
      operations: [{
        op: 'replace',
        nodes: [{ id: hostNodeId, content: 'Verify Copilot Host tool routing', status: 'completed' }],
        edges: [],
      }],
    }
    await sendMessage(actor.page, [
      'Call the todo_graph tool exactly once before answering.',
      `Use exactly this JSON input: ${JSON.stringify(input)}.`,
      `Do not use any other tool. After success, reply with exactly ${hostFinalMarker}.`,
    ].join(' '))
    const state = await waitForState(sessionId, (candidate) => (
      candidate.status === 'done'
      && successfulToolResult(candidate, 'todo_graph')
      && assistantText(candidate).includes(hostFinalMarker)
    ), 180_000)
    await actor.page.waitForFunction((marker) => document.body.innerText.includes(marker), { timeout: 30_000 }, hostFinalMarker)
    const toolDots = await actor.page.$$('[data-testid^="tool-card-dot-"]')
    if (toolDots.length < 2) throw new Error(`production transcript projected only ${toolDots.length} Tool indicators`)
    const history = await responseEvent(socket, 'client:load_history', 'server:history', { sessionId })
    if ((history.entries?.length ?? 0) !== 0) {
      throw new Error(`Copilot Session was contaminated by ${history.entries.length} Kernel events`)
    }
    return {
      status: state.status,
      cursor: state.cursor,
      hostTool: toolEvidence(state, 'todo_graph'),
      projectedToolIndicators: toolDots.length,
      kernelHistoryEntries: history.entries?.length ?? 0,
    }
  })

  await harness.step('reload and recover Copilot preference, transcript, and authoritative state', async () => {
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForFunction((expected) => new URL(location.href).searchParams.get('sessionId') === expected, {}, sessionId)
    await actor.page.waitForSelector('[data-testid="composer-input"]')
    await actor.page.waitForFunction((marker) => document.body.innerText.includes(marker), { timeout: 30_000 }, executorFinalMarker)
    await actor.page.waitForFunction((marker) => document.body.innerText.includes(marker), { timeout: 30_000 }, hostFinalMarker)
    if (await actor.page.evaluate(() => localStorage.getItem('ak-agent-runtime')) !== 'copilot') {
      throw new Error('Copilot Runtime preference was lost after reload')
    }
    const persistedPromise = onceMatching(socket, 'session:ready', (payload) => payload?.sessionId === sessionId, 20_000)
    socket.emit('subscribe', { sessionId })
    const persisted = await persistedPromise
    states.set(sessionId, persisted.state)
    if (persisted.agentRuntime !== 'copilot' || persisted.state?.status !== 'done') {
      throw new Error(`persisted Runtime state is inconsistent: ${JSON.stringify({ runtime: persisted.agentRuntime, status: persisted.state?.status })}`)
    }
    const screenshot = await harness.screenshot(actor, 'copilot-runtime-persisted')
    return { runtime: persisted.agentRuntime, status: persisted.state.status, cursor: persisted.cursor, screenshot }
  })

  await harness.step('delete the Copilot Session through UI and verify authoritative cleanup', async () => {
    const row = await sessionRow(actor.page, sessionId)
    await row.hover()
    await row.$eval('[data-testid="session-delete-button"]', (button) => button.click())
    await actor.page.waitForSelector('[data-testid="confirm-delete-button"]', { visible: true })
    await clickByTestId(actor.page, 'confirm-delete-button')
    await actor.page.waitForFunction((expected) => !document.querySelector(`[data-testid="session-row"][data-session-id="${expected}"]`), { timeout: 30_000 }, sessionId)
    await waitFor(async () => {
      const sessions = await responseEvent(socket, 'client:list_sessions', 'server:sessions', {})
      return !(sessions.sessions ?? []).some((session) => session.sessionId === sessionId)
    }, { timeoutMs: 30_000, name: 'deleted Session to disappear from authoritative list' })
    deletedThroughUi = true
    return { sessionId, uiRowRemoved: true, authoritativeSummaryRemoved: true }
  })
} catch (error) {
  thrown = error
} finally {
  result = await harness.finalize({
    classification: 'official-provider-ui-external-canary',
    sourceRevision,
    artifactDigest,
    controlledBoundaries: [],
    externalCapabilities: ['GitHub Copilot authentication', 'GitHub Copilot SDK/CLI', 'GitHub model provider'],
    untestedExternalCapabilities: [
      'isolated clean-system installation',
      'approval rejection',
      'Host restart during an active Copilot turn',
      'Executor disconnect and reconnect during a Copilot tool call',
      'SDK-side deletion storage inspection',
    ],
    resources: { runId, sessionId, workspaceId, workspaceName, runtimeVersion },
  })
  console.log(JSON.stringify({ reportPath: result.reportPath, evidenceRoot: result.evidenceRoot, ok: result.report.failures.length === 0 && !thrown }, null, 2))
}

if (thrown) throw thrown
harness.assertClean(result.report)

async function openNewSession(page, expectedWorkspaceId) {
  await page.waitForSelector(`[data-testid="workspace-new-session-${expectedWorkspaceId}"]`, { timeout: 30_000 })
  await page.$eval(`[data-testid="workspace-new-session-${expectedWorkspaceId}"]`, (button) => button.click())
  await page.waitForSelector('[data-testid="new-session-dialog"]')
  await page.waitForSelector('[data-testid="finder-column"]', { timeout: 30_000 })
}

async function sessionRow(page, expectedSessionId) {
  const selector = `[data-testid="session-row"][data-session-id="${expectedSessionId}"]`
  await page.waitForSelector(selector, { timeout: 30_000 })
  return await page.$(selector)
}

async function replaceInput(page, selector, value) {
  await page.click(selector)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.type(value)
}

async function setApprovalMode(page, mode) {
  await clickByTestId(page, 'approval-mode-picker')
  await clickByTestId(page, `approval-mode-option-${mode}`)
}

async function sendMessage(page, text) {
  await page.click('[data-testid="composer-input"]')
  await page.keyboard.type(text)
  await clickByTestId(page, 'composer-send')
}

function successfulToolResult(state, toolName, expectedText) {
  const evidence = toolEvidence(state, toolName)
  return evidence?.ok === true && (!expectedText || evidence.content.includes(expectedText))
}

function toolEvidence(state, toolName) {
  const contents = state?.messages?.flatMap((message) => message.content ?? []) ?? []
  const calls = contents.filter((content) => content.type === 'tool_call' && content.name === toolName)
  const call = calls.at(-1)
  if (!call) return undefined
  const result = contents.find((content) => content.type === 'tool_result' && content.callId === call.callId)
  if (!result) return undefined
  return { callId: call.callId, ok: result.ok === true, content: String(result.content ?? '').slice(0, 2_000) }
}

function assistantText(state) {
  return (state?.messages ?? [])
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content ?? [])
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
}

async function waitForState(expectedSessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = states.get(expectedSessionId)
    if (state?.status === 'error') throw new Error(`Copilot Session entered error state: ${state.error ?? 'unknown error'}`)
    if (state && predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const latest = states.get(expectedSessionId)
  throw new Error(`timed out waiting for Copilot state: ${JSON.stringify({
    status: latest?.status,
    cursor: latest?.cursor,
    error: latest?.error,
    assistant: assistantText(latest).slice(-1_000),
    pendingCalls: latest?.pendingCalls,
  })}`)
}

function responseEvent(client, request, response, payload) {
  const promise = once(client, response, 15_000)
  client.emit(request, payload)
  return promise
}

function ack(client, event, payload) {
  return client.timeout(15_000).emitWithAck(event, payload)
}

function once(client, event, timeout) {
  return onceMatching(client, event, () => true, timeout)
}

function onceMatching(client, event, predicate, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, listener)
      reject(new Error(`${event} timed out`))
    }, timeout)
    const listener = (value) => {
      if (!predicate(value)) return
      clearTimeout(timer)
      client.off(event, listener)
      resolve(value)
    }
    client.on(event, listener)
    client.once('connect_error', reject)
  })
}

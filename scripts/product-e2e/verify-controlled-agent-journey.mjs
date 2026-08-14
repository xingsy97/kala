#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProductE2EHarness, clickByTestId, runCommand, sha256File, startProcess, waitFor, waitForHttp } from './harness.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const bundle = join(root, 'release', 'bundle-dashboard-with-runtime.cjs')
const executorAsset = join(root, 'release', 'runlab-executor-linux-x64')
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
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const callIndex = providerRequests.length
  if (callIndex === 1) {
    sendSse(res, { type: 'message_start', message: { id: 'msg_tool', usage: { input_tokens: 10, output_tokens: 0 } } })
    sendSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'controlled-read-1', name: 'read_file', input: {} } })
    await sleep(1_500)
    sendSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'controlled.txt', _intent: intention }) } })
    sendSse(res, { type: 'content_block_stop', index: 0 })
    sendSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } })
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

try {
  if (!existsSync(bundle) || !existsSync(executorAsset)) throw new Error('production release assets are missing')
  await new Promise((resolve) => provider.listen(providerPort, '127.0.0.1', resolve))
  harness.registerResource('controlled-provider', String(providerPort), async () => await new Promise((resolve) => provider.close(resolve)))
  await harness.start()
  harness.registerResource('state-root', stateRoot, async () => rmSync(stateRoot, { recursive: true, force: true }))

  await harness.step('start production Host and Executor with controlled protocol provider', async () => {
    const host = startProcess(bundle, [], { cwd: root, env: {
      ...process.env,
      HOME: home,
      HOST_LISTEN_HOST: '127.0.0.1', HOST_PORT: String(hostPort), SESSIONS_DIR: sessionsDir,
      AGENT_KERNEL_ARTIFACTS_DIR: join(stateRoot, 'artifacts'), EXECUTOR_TOKENS: JSON.stringify([{ token }]),
      ANTHROPIC_API_KEY: 'controlled-key', ANTHROPIC_MODEL: 'controlled-model', ANTHROPIC_BASE_URL: `${providerOrigin}/v1/messages`,
    } })
    harness.registerProcess('production-host', host, hostLogs)
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
  await actor.page.goto(origin, { waitUntil: 'networkidle2' })
  primarySessionId = await createSession(actor.page)
  secondarySessionId = await createSession(actor.page)
  await selectSession(actor.page, primarySessionId)

  await harness.step('send message and switch Sessions during a live provider stream', async () => {
    await clickByTestId(actor.page, 'approval-mode-picker')
    await clickByTestId(actor.page, 'approval-mode-option-allow_all')
    await actor.page.click('[data-testid="composer-input"]')
    await actor.page.keyboard.type('Read controlled.txt and report the result.')
    await clickByTestId(actor.page, 'composer-send')
    await waitFor(() => providerRequests.length >= 1, { timeoutMs: 20_000, name: 'provider request' })
    const started = performance.now()
    await selectSession(actor.page, secondarySessionId)
    const switchedInMs = Math.round(performance.now() - started)
    if (switchedInMs > 1_000) throw new Error(`running Session switch took ${switchedInMs}ms`)
    await selectSession(actor.page, primarySessionId)
    return { primarySessionId, secondarySessionId, switchedInMs }
  })

  await harness.step('prove custom prompt, tool intention, real result, and final response', async () => {
    await actor.page.waitForFunction(() => document.body.innerText.includes('Controlled tool flow completed.'), { timeout: 30_000 })
    const requestSystem = Array.isArray(providerRequests[0]?.system)
      ? providerRequests[0].system.map((block) => block?.text ?? '').join('\n')
      : String(providerRequests[0]?.system ?? '')
    if (!requestSystem.includes(customPrompt)) throw new Error(`custom prompt missing from real provider request: ${requestSystem.slice(0, 1_500)}`)
    await actor.page.waitForSelector('[data-testid="tool-card-dot-controlled-read-1"]')
    await actor.page.waitForSelector('[data-testid="tool-card-dots-intent-controlled-read-1"]')
    const intent = await actor.page.$eval('[data-testid="tool-card-dots-intent-controlled-read-1"]', (element) => element.textContent ?? '')
    if (!intent.includes(intention)) throw new Error(`intention missing from dot line: ${intent}`)
    await clickByTestId(actor.page, 'tool-card-dot-controlled-read-1')
    await actor.page.waitForSelector('[data-testid="tool-call-detail-intent-controlled-read-1"]')
    const detail = await actor.page.$eval('[data-testid="tool-call-detail-intent-controlled-read-1"]', (element) => element.textContent ?? '')
    const previewText = await actor.page.$eval('[data-testid="tool-card-preview-scroll-controlled-read-1"]', (element) => element.textContent ?? '')
    const resultVisible = previewText.includes('CONTROLLED_TOOL_FILE')
    if (!detail.includes(intention) || !resultVisible) throw new Error(`expanded tool detail/result is incomplete: ${previewText.slice(0, 1_500)}`)
    await harness.screenshot(actor, 'controlled-tool-complete')
    return { providerRequests: providerRequests.length, intention, resultVisible: true, customPromptForwarded: true }
  })

  await harness.step('reload and replay tool intention/result from persistence', async () => {
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForSelector('[data-testid="tool-card-dot-controlled-read-1"]')
    const text = await actor.page.$eval('[data-testid="tool-card-dots-intent-controlled-read-1"]', (element) => element.textContent ?? '')
    if (!text.includes(intention)) throw new Error('persisted intention missing after reload')
    return { sessionId: primarySessionId, replayed: true }
  })
} catch (error) { thrown = error } finally {
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
  await page.evaluate(() => [...document.querySelectorAll('[data-testid^="workspace-new-session-"]')].find((item) => !item.hasAttribute('disabled'))?.click())
  await page.waitForSelector('[data-testid="new-session-dialog"]')
  await clickByTestId(page, 'new-session-create')
  await page.waitForFunction((oldId) => {
    const next = new URL(location.href).searchParams.get('sessionId')
    return Boolean(next && next !== oldId)
  }, {}, previous)
  await page.waitForSelector('[data-testid="new-session-dialog"]', { hidden: true })
  await page.waitForSelector('[data-testid="dialog-overlay"]', { hidden: true })
  return new URL(page.url()).searchParams.get('sessionId')
}
async function selectSession(page, id) {
  const selector = `[data-testid="session-row"][data-session-id="${id}"]`
  await page.waitForSelector(selector)
  const rows = await page.$$(selector)
  let visible
  for (const row of rows) {
    if (await row.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.pointerEvents !== 'none'
    })) { visible = row; break }
  }
  if (!visible) throw new Error(`no visible Session row for ${id}`)
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
function sendSse(res, value) { res.write(`data: ${JSON.stringify(value)}\n\n`) }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

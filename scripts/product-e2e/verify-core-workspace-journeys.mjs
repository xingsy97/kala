#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProductE2EHarness, clickByTestId, runCommand, sha256File, startProcess, waitFor, waitForHttp } from './harness.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const bundle = join(root, 'release', 'bundle-dashboard-with-runtime.cjs')
const executorAsset = join(root, 'release', 'runlab-executor-linux-x64')
const port = Number(process.env.PRODUCT_E2E_CORE_PORT ?? 3195)
const origin = `http://127.0.0.1:${port}`
const stateRoot = mkdtempSync(join(tmpdir(), 'runlab-e2e-core-state-'))
const home = join(stateRoot, 'home')
const sessionsDir = join(stateRoot, 'sessions')
const workspace = join(stateRoot, 'workspace')
const workspaceIdFile = join(stateRoot, 'workspace-id')
const token = `core-e2e-${process.pid}-${Date.now()}`
const prompt = `Core E2E custom prompt ${Date.now()}\n\nWhen referencing a file, use [filename](path/to/this/file).`
const harness = new ProductE2EHarness({ name: 'core-workspace-journeys' })
const hostLogs = []
const executorLogs = []
let actor
let sessionId
let result
let thrown

mkdirSync(home, { recursive: true })
mkdirSync(sessionsDir, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'e2e-visible.txt'), 'FILES_E2E_VISIBLE\n', 'utf8')

function startHost(label) {
  const child = startProcess(bundle, [], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      HOST_LISTEN_HOST: '127.0.0.1',
      HOST_PORT: String(port),
      SESSIONS_DIR: sessionsDir,
      AGENT_KERNEL_ARTIFACTS_DIR: join(stateRoot, 'artifacts'),
      EXECUTOR_TOKENS: JSON.stringify([{ token }]),
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'e2e-unused',
    },
  })
  harness.registerProcess(label, child, hostLogs)
  return child
}

try {
  if (!existsSync(bundle) || !existsSync(executorAsset)) throw new Error('production release assets are missing')
  await harness.start()
  harness.registerResource('state-root', stateRoot, async () => rmSync(stateRoot, { recursive: true, force: true }))

  await harness.step('start production Host and Executor artifacts', async () => {
    const host = startHost('production-host-initial')
    await waitForHttp(`${origin}/install`)
    const executor = startProcess(executorAsset, ['--host', origin, '--sandbox-root', workspace], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        HOST_URL: origin,
        EXECUTOR_TOKEN: token,
        WORKSPACE_NAME: 'core-e2e-workspace',
        AGENT_KERNEL_WORKSPACE_ID_FILE: workspaceIdFile,
      },
    })
    harness.registerProcess('production-executor', executor, executorLogs)
    await waitFor(() => executorLogs.some((line) => line.includes('executor announced; awaiting tool calls')), { timeoutMs: 30_000, name: 'Executor announce' })
    return { hostPid: host.pid, executorPid: executor.pid, bundleSha256: sha256File(bundle), executorSha256: sha256File(executorAsset) }
  })

  actor = await harness.newActor('operator')
  await harness.step('create Session from real online Workspace and select exact ACK id', async () => {
    await actor.page.goto(origin, { waitUntil: 'networkidle2' })
    await actor.page.waitForSelector('[data-testid="workspace-row"][data-online="true"]')
    await actor.page.evaluate(() => {
      const button = [...document.querySelectorAll('[data-testid^="workspace-new-session-"]')].find((item) => !item.hasAttribute('disabled'))
      button?.click()
    })
    await actor.page.waitForSelector('[data-testid="new-session-dialog"]')
    await clickByTestId(actor.page, 'new-session-create')
    await actor.page.waitForFunction(() => new URL(location.href).searchParams.has('sessionId'))
    sessionId = new URL(actor.page.url()).searchParams.get('sessionId')
    await actor.page.waitForSelector('[data-testid="session-selected-marker"]')
    const selected = await actor.page.$eval('[data-testid="session-selected-marker"]', (element) => element.closest('[data-testid="session-row"]')?.getAttribute('data-session-id'))
    if (!sessionId || selected !== sessionId) throw new Error(`created Session ${sessionId} but selected ${selected}`)
    return { sessionId, url: actor.page.url(), selected }
  })

  await harness.step('reload and restore the same Session', async () => {
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForFunction((expected) => new URL(location.href).searchParams.get('sessionId') === expected, {}, sessionId)
    await actor.page.waitForSelector('[data-testid="composer-input"]')
    const marker = await actor.page.$('[data-testid="session-selected-marker"]')
    if (!marker) throw new Error('selected Session marker missing after reload')
    return { sessionId, restored: true }
  })

  await harness.step('send real Chromium keyboard input through Host and Executor PTY', async () => {
    await clickByTestId(actor.page, 'terminal-toggle')
    await actor.page.waitForSelector('[data-testid="session-terminal-panel"]')
    await actor.page.evaluate(() => {
      const panel = document.querySelector('[data-testid="session-terminal-panel"]')
      const start = [...(panel?.querySelectorAll('button') ?? [])].find((button) => /start|启动/iu.test(button.textContent ?? ''))
      start?.click()
    })
    await actor.page.waitForFunction(() => /running|运行/iu.test(document.querySelector('[data-testid="terminal-status"]')?.textContent ?? ''), { timeout: 30_000 })
    await actor.page.waitForSelector('.xterm-helper-textarea')
    await actor.page.click('.xterm-helper-textarea')
    await actor.page.keyboard.type("printf 'TERMINAL_E2E_OK\\n'\n")
    await actor.page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('TERMINAL_E2E_OK'), { timeout: 30_000 })
    const output = await actor.page.$eval('.xterm-rows', (element) => element.textContent ?? '')
    return { status: 'running', outputTail: output.slice(-500) }
  })

  await harness.step('read real Workspace file through Files UI', async () => {
    await clickByTestId(actor.page, 'right-panel-files-tab')
    await actor.page.waitForSelector('[data-testid="session-files-panel"]')
    await actor.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="session-file-file"]')].some((item) => item.textContent?.includes('e2e-visible.txt')), { timeout: 30_000 })
    await actor.page.evaluate(() => [...document.querySelectorAll('[data-testid="session-file-file"]')].find((item) => item.textContent?.includes('e2e-visible.txt'))?.click())
    await actor.page.waitForFunction(() => document.body.innerText.includes('FILES_E2E_VISIBLE'), { timeout: 30_000 })
    return { path: join(workspace, 'e2e-visible.txt'), visibleContents: true }
  })

  await harness.step('save custom system prompt through production Settings UI', async () => {
    await clickByTestId(actor.page, 'app-shell-nav-settings-icon')
    await actor.page.waitForSelector('[data-testid="settings-dialog"]')
    await clickByTestId(actor.page, 'settings-tab-agent')
    await actor.page.waitForSelector('[data-testid="settings-agent-preset-custom"]')
    const selected = await actor.page.$eval('[data-testid="settings-agent-preset-custom"]', (element) => element.getAttribute('aria-pressed') === 'true')
    if (!selected) await clickByTestId(actor.page, 'settings-agent-preset-custom')
    await actor.page.waitForSelector('[data-testid="settings-agent-custom-prompt"]')
    await actor.page.click('[data-testid="settings-agent-custom-prompt"]')
    await actor.page.keyboard.down('Control')
    await actor.page.keyboard.press('KeyA')
    await actor.page.keyboard.up('Control')
    await actor.page.keyboard.type(prompt)
    await actor.page.waitForFunction(() => !document.querySelector('[data-testid="settings-agent-custom-prompt-save"]')?.disabled)
    await clickByTestId(actor.page, 'settings-agent-custom-prompt-save')
    const settings = await waitFor(async () => {
      const payload = await fetch(`${origin}/settings`, { cache: 'no-store' }).then((response) => response.json())
      return payload.agentPrompt?.selectedPreset === 'custom' && payload.agentPrompt?.customPrompt === prompt ? payload : undefined
    }, { timeoutMs: 30_000, name: 'custom prompt settings response' })
    const settingsPath = settings.agentPrompt.configPath
    const persisted = await waitFor(() => existsSync(settingsPath) && JSON.parse(readFileSync(settingsPath, 'utf8')).customSystemPrompt === prompt, { timeoutMs: 30_000, name: 'custom prompt persistence' })
    return { settingsPath, persisted: Boolean(persisted), promptLength: prompt.length }
  })

  await harness.step('restart Host and prove custom prompt plus Session survive', async () => {
    const initial = harness.resources.find((item) => item.kind === 'process' && item.id === 'production-host-initial')
    const expectedErrorStart = actor.consoleErrors.length
    await initial.cleanup()
    initial.cleaned = true
    startHost('production-host-restarted')
    await waitForHttp(`${origin}/settings`)
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForFunction((expected) => new URL(location.href).searchParams.get('sessionId') === expected, {}, sessionId)
    await clickByTestId(actor.page, 'app-shell-nav-settings-icon')
    await clickByTestId(actor.page, 'settings-tab-agent')
    await actor.page.waitForSelector('[data-testid="settings-agent-custom-prompt"]')
    const restoredPrompt = await actor.page.$eval('[data-testid="settings-agent-custom-prompt"]', (element) => element.value)
    if (restoredPrompt !== prompt) throw new Error('custom prompt did not survive Host restart')
    const restartErrors = actor.consoleErrors.slice(expectedErrorStart)
    if (restartErrors.some((message) => !message.includes('ERR_CONNECTION_REFUSED'))) {
      throw new Error(`unexpected console error during restart: ${restartErrors.join(' | ')}`)
    }
    actor.consoleErrors.splice(expectedErrorStart)
    return { sessionId, promptRestored: true, expectedTransientConnectionErrors: restartErrors.length }
  })

  await harness.screenshot(actor, 'core-journeys-complete')
} catch (error) {
  thrown = error
} finally {
  result = await harness.finalize({
    revision: (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true })).stdout.trim(),
    artifacts: { host: sha256File(bundle), executor: sha256File(executorAsset) },
    controlledBoundaries: [],
    untestedExternalCapabilities: ['model-provider request content is covered by a separate controlled-protocol journey'],
    sessionId,
    hostLogTail: hostLogs.slice(-80),
    executorLogTail: executorLogs.slice(-80),
  })
}

if (!thrown) {
  try { harness.assertClean(result.report) } catch (error) { thrown = error }
}
if (thrown) {
  console.error(thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown))
  console.error(`Evidence: ${result?.evidenceRoot ?? '<unavailable>'}`)
  process.exit(1)
}
console.log(`PASS core-workspace-journeys system E2E\nEvidence: ${result.evidenceRoot}`)

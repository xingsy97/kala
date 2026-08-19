#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
writeFileSync(join(workspace, 'e2e-binary.bin'), Buffer.from([0, 255, 1, 254, 2, 253]))
writeFileSync(join(workspace, 'e2e-data.csv'), `name,note,value\nAda,"hello, world",=1+1\n${Array.from({ length: 1_050 }, (_, index) => `row-${index},note-${index},${index}`).join('\n')}\n`, 'utf8')
writeFileSync(join(workspace, 'e2e-events.jsonl'), '{"kind":"ready","ok":true}\ninvalid-json\n{"kind":"done","ok":false}\n', 'utf8')
writeFileSync(join(workspace, 'e2e-config.yaml'), 'server:\n  port: 3195\n', 'utf8')
writeFileSync(join(workspace, 'e2e-config.toml'), '[server]\nport = 3195\n', 'utf8')
writeFileSync(join(workspace, 'e2e-unsafe.xml'), '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>\n', 'utf8')
writeFileSync(join(workspace, 'e2e-app.log'), '\u001b[31mERROR\u001b[0m failed\nINFO ready\n', 'utf8')
writeFileSync(join(workspace, 'e2e-change.patch'), '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', 'utf8')
writeFileSync(join(workspace, 'e2e-preview.md'), '[bad](javascript:alert(1))\n\n![remote](https://example.invalid/tracker.png)\n\n```mermaid\ngraph TD; A-->B\n```\n', 'utf8')
writeFileSync(join(workspace, 'e2e-report.pdf'), Buffer.from('JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK', 'base64'))
execFileSync('git', ['init', '-q'], { cwd: workspace })
execFileSync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: workspace })
execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: workspace })
execFileSync('git', ['add', 'e2e-visible.txt'], { cwd: workspace })
execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: workspace })
writeFileSync(join(workspace, 'e2e-visible.txt'), 'FILES_E2E_VISIBLE\nGIT_DIFF_VISIBLE\n', 'utf8')

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
    if (!sessionId) throw new Error('created Session ACK id missing from URL')
    const rowSelector = `[data-testid="session-row"][data-session-id="${sessionId}"]`
    await actor.page.waitForSelector(rowSelector)
    await actor.page.waitForSelector('[data-testid="composer-input"]')
    const selected = await actor.page.$eval(rowSelector, (element) => element.classList.contains('bg-accent'))
    if (!selected) throw new Error(`created Session ${sessionId} row is not selected`)
    return { sessionId, url: actor.page.url(), selected }
  })

  await harness.step('reload and restore the same Session', async () => {
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForFunction((expected) => new URL(location.href).searchParams.get('sessionId') === expected, {}, sessionId)
    await actor.page.waitForSelector('[data-testid="composer-input"]')
    const selectedRow = await actor.page.$(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    if (!selectedRow || !(await selectedRow.evaluate((element) => element.classList.contains('bg-accent')))) throw new Error('selected Session row missing after reload')
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
    await actor.page.keyboard.type("printf 'TERMINAL_E2E_OK\\n'")
    await actor.page.keyboard.press('Enter')
    await actor.page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('TERMINAL_E2E_OK'), { timeout: 30_000 })
    const output = await actor.page.$eval('.xterm-rows', (element) => element.textContent ?? '')
    return { status: 'running', outputTail: output.slice(-500) }
  })

  await harness.step('resize, kill, restart, and reuse the real PTY', async () => {
    await actor.page.setViewport({ width: 1180, height: 760 })
    await sleep(300)
    await actor.page.evaluate(() => {
      const panel = document.querySelector('[data-testid="session-terminal-panel"]')
      const kill = [...(panel?.querySelectorAll('button') ?? [])].find((button) => /kill|终止/iu.test(button.getAttribute('title') ?? button.getAttribute('aria-label') ?? ''))
      kill?.click()
    })
    await actor.page.waitForFunction(() => /exited|已退出/iu.test(document.querySelector('[data-testid="terminal-status"]')?.textContent ?? ''), { timeout: 30_000 })
    await actor.page.evaluate(() => {
      const panel = document.querySelector('[data-testid="session-terminal-panel"]')
      const restart = [...(panel?.querySelectorAll('button') ?? [])].find((button) => /restart|重新启动|重启/iu.test(button.getAttribute('title') ?? button.getAttribute('aria-label') ?? ''))
      restart?.click()
    })
    await actor.page.waitForFunction(() => /running|运行/iu.test(document.querySelector('[data-testid="terminal-status"]')?.textContent ?? ''), { timeout: 30_000 })
    await actor.page.click('.xterm-helper-textarea')
    await actor.page.keyboard.type("printf 'TERMINAL_RESTART_OK\\n'")
    await actor.page.keyboard.press('Enter')
    await actor.page.waitForFunction(() => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('TERMINAL_RESTART_OK'), { timeout: 30_000 })
    return { resized: true, killed: true, restarted: true, reused: true }
  })

  await harness.step('read and download real Workspace files through Files UI', async () => {
    await clickByTestId(actor.page, 'right-panel-files-tab')
    await actor.page.waitForSelector('[data-testid="session-files-panel"]')
    await actor.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="session-file-file"]')].some((item) => item.textContent?.includes('e2e-visible.txt')), { timeout: 30_000 })
    await actor.page.evaluate(() => [...document.querySelectorAll('[data-testid="session-file-file"]')].find((item) => item.textContent?.includes('e2e-visible.txt'))?.click())
    await actor.page.waitForFunction(() => document.body.innerText.includes('FILES_E2E_VISIBLE'), { timeout: 30_000 })
    const binaryRow = await findFileRow(actor.page, 'e2e-binary.bin')
    await binaryRow.click()
    await actor.page.evaluate(() => {
      window.__runlabDownload = null
      window.showSaveFilePicker = async (options) => ({
        createWritable: async () => ({
          write: async (blob) => { window.__runlabDownload = { name: options.suggestedName, bytes: [...new Uint8Array(await blob.arrayBuffer())] } },
          close: async () => {},
        }),
      })
    })
    const freshBinaryRow = await findFileRow(actor.page, 'e2e-binary.bin')
    await freshBinaryRow.evaluate((element) => element.parentElement?.querySelector('button[aria-label^="Download "]')?.click())
    const downloaded = await actor.page.waitForFunction(() => Boolean(window.__runlabDownload?.bytes), { timeout: 30_000 }).then(async () => await actor.page.evaluate(() => window.__runlabDownload))
    if (downloaded.name !== 'e2e-binary.bin' || JSON.stringify(downloaded.bytes) !== JSON.stringify([0, 255, 1, 254, 2, 253])) throw new Error(`download bytes mismatch: ${JSON.stringify(downloaded)}`)
    const close = await actor.page.$('[data-testid="session-file-view-close"]')
    if (close) {
      await close.click()
      await actor.page.waitForSelector('[data-testid="session-file-view-dialog"]', { hidden: true })
    }
    return { path: join(workspace, 'e2e-visible.txt'), visibleContents: true, binaryHandled: true, downloaded }
  })

  await harness.step('preview structured and document files through real filesystem RPC', async () => {
    const pdfViewerEnabled = await actor.page.evaluate(() => navigator.pdfViewerEnabled === true)
    let csvRenderedRows = 0
    const cases = [
      ['e2e-data.csv', 'session-file-table-preview', 'hello, world'],
      ['e2e-events.jsonl', 'session-file-record-preview', 'Invalid JSON on Line 2'],
      ['e2e-config.yaml', 'session-file-outline-preview', '3195'],
      ['e2e-config.toml', 'session-file-outline-preview', 'server'],
      ['e2e-unsafe.xml', 'session-file-outline-preview', 'DOCTYPE and ENTITY declarations are disabled'],
      ['e2e-app.log', 'session-file-log-preview', 'ERROR failed'],
      ['e2e-change.patch', 'session-file-diff-preview', '+new'],
      ['e2e-preview.md', 'session-file-markdown-preview', '[Image blocked in preview: remote]'],
      ['e2e-report.pdf', 'session-file-pdf-fallback', 'PDF ready for read-only preview'],
    ]
    for (const [name, testId, text] of cases) {
      const row = await findFileRow(actor.page, name)
      await row.evaluate((element) => element.click())
      await actor.page.waitForSelector('[data-testid="session-file-view-dialog"]', { visible: true, timeout: 30_000 })
      await actor.page.waitForSelector(`[data-testid="${testId}"]`, { timeout: 30_000 })
      if (text) await actor.page.waitForFunction((expected) => document.body.innerText.includes(expected), { timeout: 30_000 }, text)
      if (name === 'e2e-data.csv') {
        await actor.page.waitForFunction(() => document.body.innerText.includes('rows and 0 columns omitted by preview limits'))
        csvRenderedRows = await actor.page.$$eval('[data-testid="session-file-table-rows"] [data-item-index]', (items) => items.length)
        if (csvRenderedRows <= 0 || csvRenderedRows >= 100) throw new Error(`CSV virtualization budget failed: ${csvRenderedRows} rendered rows`)
        await actor.page.click('button[aria-label="Show source"]')
        await actor.page.waitForFunction(() => document.body.innerText.includes('name,note,value'))
        await actor.page.click('button[aria-label="Show structured preview"]')
        await actor.page.waitForSelector('[data-testid="session-file-table-preview"]')
      }
      if (name === 'e2e-preview.md') {
        const unsafeLink = await actor.page.$('[data-testid="session-file-markdown-preview"] a[href^="javascript:"]')
        const externalImage = await actor.page.$('[data-testid="session-file-markdown-preview"] img')
        const mermaidSvg = await actor.page.$('[data-testid="session-file-markdown-preview"] svg')
        if (unsafeLink || externalImage || mermaidSvg) throw new Error('Markdown file preview exposed active content')
      }
      if (name === 'e2e-report.pdf') {
        const download = await actor.page.$('button[aria-label="Download file"]')
        if (!download) throw new Error('PDF fallback omitted Download file action')
      }
      await actor.page.click('[data-testid="session-file-view-close"]')
      await actor.page.waitForSelector('[data-testid="session-file-view-dialog"]', { hidden: true })
    }
    return { formats: cases.map(([name]) => name), realFilesystemRpc: true, csvTotalDataRows: 1_051, csvRenderedRows, markdownActiveContentBlocked: true, pdfViewerEnabled, pdfDefaultFallbackVerified: true }
  })

  await harness.step('use Files and Terminal through the real mobile Tools drawer', async () => {
    await actor.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
    await actor.page.waitForSelector('[data-testid="inspector-toggle"]')
    await actor.page.click('[data-testid="inspector-toggle"]')
    await actor.page.waitForSelector('[data-testid="inspector-drawer-mobile"]', { visible: true })
    await sleep(250)
    const drawer = await actor.page.$eval('[data-testid="inspector-drawer-mobile"]', (element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width, viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }
    })
    if (drawer.left < -1 || drawer.right > drawer.viewportWidth + 1 || drawer.documentWidth > drawer.viewportWidth + 1) throw new Error(`mobile Tools drawer overflow: ${JSON.stringify(drawer)}`)
    const tabHeights = await actor.page.$$eval('[role="tablist"][aria-label="Workspace tools"] [role="tab"]', (tabs) => tabs.map((tab) => tab.getBoundingClientRect().height))
    if (tabHeights.length !== 4 || tabHeights.some((height) => height < 44)) throw new Error(`mobile Tool tabs are not touch-sized: ${JSON.stringify(tabHeights)}`)

    await actor.page.click('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-terminal-tab"]')
    await actor.page.waitForSelector('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-terminal-content"]', { visible: true })
    await actor.page.waitForFunction(() => document.querySelector('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-terminal-tab"]')?.getAttribute('aria-selected') === 'true')
    const terminalControls = await actor.page.$$eval('[data-testid="inspector-drawer-mobile"] [data-testid="terminal-toolbar"] button, [data-testid="inspector-drawer-mobile"] [data-testid="terminal-touch-keys"] button', (buttons) => buttons.map((button) => ({ label: button.getAttribute('aria-label') ?? button.textContent ?? '', height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width })))
    if (terminalControls.length < 7 || terminalControls.some((control) => control.height < 44 || control.width < 44)) throw new Error(`mobile Terminal controls are not touch-sized: ${JSON.stringify(terminalControls)}`)

    await actor.page.click('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-files-tab"]')
    await actor.page.waitForSelector('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-files-content"] [data-testid="session-files-panel"]', { visible: true })
    await actor.page.click('[data-testid="inspector-drawer-mobile"] [aria-label="Refresh files"]')
    await sleep(150)
    const csvRow = await findFileRow(actor.page, 'e2e-data.csv', '[data-testid="inspector-drawer-mobile"]')
    await csvRow.evaluate((element) => element.click())
    await actor.page.waitForSelector('[data-testid="session-file-table-preview"]')
    const table = await actor.page.$eval('[data-testid="session-file-table-preview"]', (element) => ({ pageWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth, scrollable: Array.from(element.querySelectorAll('*')).some((child) => child.scrollWidth > child.clientWidth + 1) }))
    if (table.pageWidth > table.viewportWidth + 1 || !table.scrollable) throw new Error(`mobile CSV table contract failed: ${JSON.stringify(table)}`)
    await actor.page.click('[data-testid="session-file-view-close"]')
    await actor.page.waitForSelector('[data-testid="session-file-view-dialog"]', { hidden: true })
    await actor.page.setViewport({ width: 1180, height: 760, deviceScaleFactor: 1, isMobile: false, hasTouch: false })
    return { drawer, tabHeights, terminalControls, csvHorizontallyScrollable: true }
  })

  await harness.step('show real Git status and diff through Source Control UI', async () => {
    await clickByTestId(actor.page, 'right-panel-git-tab')
    await actor.page.waitForSelector('[data-testid="source-control-panel"]')
    await actor.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="source-control-file"]')].some((item) => item.textContent?.includes('e2e-visible.txt')), { timeout: 30_000 })
    await actor.page.evaluate(() => [...document.querySelectorAll('[data-testid="source-control-file"]')].find((item) => item.textContent?.includes('e2e-visible.txt'))?.click())
    await actor.page.waitForSelector('[data-testid="source-control-diff-dialog"]')
    await actor.page.waitForFunction(() => document.body.innerText.includes('GIT_DIFF_VISIBLE'), { timeout: 30_000 })
    return { repo: workspace, modifiedFile: 'e2e-visible.txt', diffVisible: true }
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
    const expectedRequestFailureStart = actor.requestFailures.length
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
    const restartRequestFailures = actor.requestFailures.slice(expectedRequestFailureStart)
    if (restartRequestFailures.some((item) => !item.error.includes('ERR_CONNECTION_REFUSED'))) {
      throw new Error(`unexpected request failure during restart: ${JSON.stringify(restartRequestFailures)}`)
    }
    actor.consoleErrors.splice(expectedErrorStart)
    actor.requestFailures.splice(expectedRequestFailureStart)
    return { sessionId, promptRestored: true, expectedTransientConnectionErrors: restartErrors.length, expectedTransientRequestFailures: restartRequestFailures.length }
  })

  const expectedMonacoAborts = actor.requestFailures.filter((item) => item.error === 'net::ERR_ABORTED' && item.url.includes('monaco-editor') && item.url.includes('editor.worker'))
  actor.requestFailures = actor.requestFailures.filter((item) => !expectedMonacoAborts.includes(item))
  const expectedMonacoPageErrors = actor.pageErrors.filter((message) => message === 'Error: Uncaught (in promise) Canceled: Canceled')
  actor.pageErrors = actor.pageErrors.filter((message) => !expectedMonacoPageErrors.includes(message))
  await harness.step('account for controlled preview capability fallbacks', async () => ({ expectedMonacoWorkerAborts: expectedMonacoAborts.length, expectedMonacoPageErrors: expectedMonacoPageErrors.length }))
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

async function findFileRow(page, name, scope = '') {
  const rows = await page.$$(`${scope} [data-testid="session-file-file"]`.trim())
  for (const rowButton of rows) {
    if (await rowButton.evaluate((element, expected) => element.textContent?.includes(expected), name)) return rowButton
  }
  throw new Error(`file row not found: ${name}`)
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

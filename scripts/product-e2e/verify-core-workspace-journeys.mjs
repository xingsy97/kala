#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProductE2EHarness, clickByTestId, clickElement, clickFirstVisible, hoverAncestorAndClickFirst, runCommand, sha256File, startProcess, waitFor, waitForHttp } from './harness.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const bundle = join(root, 'release', 'kala-dashboard-with-runtime.cjs')
const executorAsset = join(root, 'release', 'kala-executor.cjs')
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
for (let index = 0; index < 12; index += 1) mkdirSync(join(workspace, `e2e-dir-${String(index).padStart(2, '0')}`))
mkdirSync(join(workspace, 'zz-e2e-column'))
for (let index = 0; index < 12; index += 1) writeFileSync(join(workspace, 'zz-e2e-column', `item-${String(index).padStart(2, '0')}.txt`), `${index}\n`, 'utf8')
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
      KALA_BIND_HOST: '127.0.0.1',
      KALA_PORT: String(port),
      KALA_SESSIONS_DIR: sessionsDir,
      KALA_ARTIFACTS_DIR: join(stateRoot, 'artifacts'),
      KALA_EXECUTOR_TOKENS: JSON.stringify([{ token }]),
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
        KALA_WORKSPACE_ID_FILE: workspaceIdFile,
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
    await hoverAncestorAndClickFirst(actor.page, '[data-testid^="workspace-new-session-"]', '[data-testid="workspace-row"]', { description: 'New Session for online Workspace' })
    await actor.page.waitForSelector('[data-testid="new-session-dialog"]')
    await harness.screenshot(actor, 'new-session-picker')
    await actor.page.waitForSelector('[data-testid="finder-column"]', { timeout: 15_000 })
    const finderText = await actor.page.$eval('[data-testid="directory-picker-finder"]', (finder) => finder.textContent ?? '')
    if (!finderText.includes('e2e-visible.txt')) {
      await harness.screenshot(actor, 'new-session-picker-missing-files')
      throw new Error(`Create Session picker omitted workspace files: ${finderText.slice(0, 1_000)}`)
    }
    const pickerLayout = await actor.page.$eval('[data-testid="new-session-dialog"]', (dialog) => {
      const options = dialog.querySelector('[data-testid="new-session-options"]')?.getBoundingClientRect()
      const finder = dialog.querySelector('[data-testid="directory-picker-finder"]')?.getBoundingClientRect()
      return { optionsHeight: options?.height ?? 0, finderHeight: finder?.height ?? 0 }
    })
    if (pickerLayout.optionsHeight > 56 || pickerLayout.finderHeight < 160) {
      throw new Error(`Create Session picker is vertically cramped: ${JSON.stringify(pickerLayout)}`)
    }
    const firstColumnScroll = await actor.page.$('[data-testid="finder-column-scroll"]')
    if (!firstColumnScroll) throw new Error('first Finder column has no independent scroll container')
    await firstColumnScroll.hover()
    await actor.page.mouse.wheel({ deltaY: 4_000 })
    await actor.page.waitForFunction(() => (document.querySelector('[data-testid="finder-column-scroll"]')?.scrollTop ?? 0) > 0)
    await clickFirstVisible(actor.page, '[data-testid="finder-dir"]', { text: 'zz-e2e-column', description: 'last directory in first Finder column' })
    await actor.page.waitForFunction(() => document.querySelectorAll('[data-testid="finder-column-scroll"]').length === 2)
    const columnScrollTops = await actor.page.$$eval('[data-testid="finder-column-scroll"]', (columns) => columns.map((column) => column.scrollTop))
    if (!(columnScrollTops[0] > 0) || columnScrollTops[1] !== 0) {
      throw new Error(`Finder columns do not preserve independent scroll positions: ${JSON.stringify(columnScrollTops)}`)
    }
    await clickByTestId(actor.page, 'new-session-close')
    await actor.page.waitForSelector('[data-testid="new-session-dialog"]', { hidden: true })
    await hoverAncestorAndClickFirst(actor.page, '[data-testid^="workspace-new-session-"]', '[data-testid="workspace-row"]', { description: 'Reopen new Session for online Workspace' })
    await actor.page.waitForSelector('[data-testid="new-session-dialog"]')
    await actor.page.waitForFunction((expectedRoot) =>
      document.querySelector('[data-testid="new-session-cwd-input"]')?.value === expectedRoot
      && document.querySelectorAll('[data-testid="finder-column"]').length === 1
      && [...document.querySelectorAll('[data-testid="finder-file"]')].some((entry) => entry.textContent?.includes('e2e-visible.txt')), {}, workspace)
    await clickByTestId(actor.page, 'new-session-mode-dag')
    await clickByTestId(actor.page, 'new-session-create')
    await actor.page.waitForFunction(() => new URL(location.href).searchParams.has('sessionId'))
    sessionId = new URL(actor.page.url()).searchParams.get('sessionId')
    if (!sessionId) throw new Error('created Session ACK id missing from URL')
    const rowSelector = `[data-testid="session-row"][data-session-id="${sessionId}"]`
    await actor.page.waitForSelector(rowSelector)
    await actor.page.waitForSelector('[data-testid="composer-input"]')
    await actor.page.waitForSelector('[data-testid="dag-run-canvas"]')
    const dagSurface = await actor.page.$eval('[data-testid="dag-run-panel"]', (element) => ({
      height: element.getBoundingClientRect().height,
      text: element.textContent ?? '',
    }))
    if (dagSurface.height < 190 || !dagSurface.text.includes('Waiting for DAG plan')) {
      throw new Error(`DAG-First surface is not prominent: ${JSON.stringify(dagSurface)}`)
    }
    const selected = await actor.page.$eval(rowSelector, (element) => element.getAttribute('data-selected') === 'true')
    if (!selected) throw new Error(`created Session ${sessionId} row is not selected`)
    return { sessionId, url: actor.page.url(), selected, pickerLayout, columnScrollTops, dagSurface }
  })

  await harness.step('reload and restore the same Session', async () => {
    await actor.page.reload({ waitUntil: 'networkidle2' })
    await actor.page.waitForFunction((expected) => new URL(location.href).searchParams.get('sessionId') === expected, {}, sessionId)
    await actor.page.waitForSelector('[data-testid="composer-input"]')
    await actor.page.waitForSelector('[data-testid="dag-run-canvas"]')
    await sleep(1_000)
    const selectedRow = await actor.page.$(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    if (!selectedRow || !(await selectedRow.evaluate((element) => element.getAttribute('data-selected') === 'true'))) throw new Error('selected Session row missing after reload')
    return { sessionId, restored: true }
  })

  await harness.step('send real Chromium keyboard input through Host and Executor PTY', async () => {
    const inspectorPanel = await actor.page.$('[data-testid="inspector-panel"]')
    if (!inspectorPanel || !await inspectorPanel.isVisible()) {
      await clickFirstVisible(actor.page, '[data-testid="sidebar-toggle"]', { description: 'Open inspector', timeoutMs: 30_000 })
    }
    await actor.page.waitForSelector('[data-testid="inspector-panel"]', { visible: true })
    await clickFirstVisible(actor.page, '[data-testid="inspector-panel"] [data-testid="right-panel-terminal-tab"]', { description: 'Terminal tab', timeoutMs: 30_000 })
    await sleep(1_000)
    await harness.screenshot(actor, 'terminal-tab-selected')
    await actor.page.waitForFunction(() => document.querySelector('[data-testid="inspector-panel"] [data-testid="right-panel-terminal-tab"]')?.getAttribute('aria-selected') === 'true')
    const terminalPanelSelector = '[data-testid="inspector-panel"] [data-testid="right-panel-terminal-content"][aria-hidden="false"]'
    await actor.page.waitForFunction((panelSelector) => {
      const button = document.querySelector(`${panelSelector} [data-testid="terminal-start"]`)
      return button instanceof HTMLButtonElement && !button.disabled
    }, { timeout: 30_000 }, terminalPanelSelector)
    await clickFirstVisible(actor.page, `${terminalPanelSelector} [data-testid="terminal-start"]`, { description: 'Start terminal', timeoutMs: 30_000 })
    try {
      await waitFor(async () => {
        const states = await actor.page.$$eval(`${terminalPanelSelector} [data-testid="session-terminal-panel"]`, (panels) => panels.map((panel) => ({
          status: panel.getAttribute('data-terminal-status'),
          text: panel.querySelector('[data-testid="terminal-status"]')?.textContent ?? '',
          visible: panel.getBoundingClientRect().width > 0 && panel.getBoundingClientRect().height > 0,
        })))
        if (states.some((state) => state.visible && /running|运行/iu.test(state.text))) return true
        throw new Error(`terminal did not enter running state: ${JSON.stringify(states)}`)
      }, { timeoutMs: 30_000, name: 'terminal running state' })
    } catch (error) {
      await harness.screenshot(actor, 'terminal-start-failure')
      throw error
    }
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
    await clickFirstVisible(actor.page, '[data-testid="terminal-kill"]', { description: 'Kill terminal' })
    await actor.page.waitForFunction(() => /exited|已退出/iu.test(document.querySelector('[data-testid="terminal-status"]')?.textContent ?? ''), { timeout: 30_000 })
    await clickFirstVisible(actor.page, '[data-testid="terminal-restart"]', { description: 'Restart terminal' })
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
    await actor.page.waitForSelector('[data-testid="session-files-panel"] [role="tree"] [role="treeitem"]')
    await actor.page.focus('[data-testid="session-files-panel"] [role="tree"]')
    await actor.page.keyboard.press('End')
    await actor.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="session-file-file"]')].some((item) => item.textContent?.includes('e2e-visible.txt')), { timeout: 30_000 })
    await clickFirstVisible(actor.page, '[data-testid="session-file-file"]', { textIncludes: 'e2e-visible.txt', description: 'e2e-visible.txt file' })
    await actor.page.waitForFunction(() => document.body.innerText.includes('FILES_E2E_VISIBLE'), { timeout: 30_000 })
    await clickByTestId(actor.page, 'session-file-view-close')
    await actor.page.waitForSelector('[data-testid="session-file-view-dialog"]', { hidden: true })
    await actor.page.waitForFunction(() => document.querySelectorAll('[data-testid="dialog-overlay"]').length === 0)
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
    await freshBinaryRow.hover()
    const binaryParentHandle = await freshBinaryRow.evaluateHandle((element) => element.parentElement)
    const binaryParent = binaryParentHandle.asElement()
    await clickElement(await binaryParent?.$('button[aria-label^="Download "]'), 'Download e2e-binary.bin')
    const downloaded = await actor.page.waitForFunction(() => Boolean(window.__runlabDownload?.bytes), { timeout: 30_000 }).then(async () => await actor.page.evaluate(() => window.__runlabDownload))
    if (downloaded.name !== 'e2e-binary.bin' || JSON.stringify(downloaded.bytes) !== JSON.stringify([0, 255, 1, 254, 2, 253])) throw new Error(`download bytes mismatch: ${JSON.stringify(downloaded)}`)
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
      await clickElement(row, `Open ${name}`)
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
        const activeEmbed = await actor.page.$('[data-testid="session-file-markdown-preview"] script, [data-testid="session-file-markdown-preview"] iframe, [data-testid="session-file-markdown-preview"] object, [data-testid="session-file-markdown-preview"] embed')
        if (unsafeLink || externalImage || activeEmbed) throw new Error('Markdown file preview exposed active content')
      }
      if (name === 'e2e-report.pdf') {
        const download = await actor.page.$('button[aria-label="Download file"]')
        if (!download) throw new Error('PDF fallback omitted Download file action')
      }
      await actor.page.click('[data-testid="session-file-view-close"]')
      await actor.page.waitForSelector('[data-testid="session-file-view-dialog"]', { hidden: true })
      await actor.page.waitForFunction(() => document.querySelectorAll('[data-testid="dialog-overlay"]').length === 0)
    }
    return { formats: cases.map(([name]) => name), realFilesystemRpc: true, csvTotalDataRows: 1_051, csvRenderedRows, markdownActiveContentBlocked: true, pdfViewerEnabled, pdfDefaultFallbackVerified: true }
  })

  await harness.step('use Files and Terminal through the real mobile Tools drawer', async () => {
    await actor.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
    await clickByTestId(actor.page, 'sidebar-toggle')
    await actor.page.waitForSelector('[data-testid="inspector-drawer-mobile"]', { visible: true })
    await sleep(250)
    const drawer = await actor.page.$eval('[data-testid="inspector-drawer-mobile"]', (element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width, viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }
    })
    if (drawer.left < -1 || drawer.right > drawer.viewportWidth + 1 || drawer.documentWidth > drawer.viewportWidth + 1) throw new Error(`mobile Tools drawer overflow: ${JSON.stringify(drawer)}`)
    const tabHeights = await actor.page.$$eval('[role="tablist"][aria-label="Workspace tools"] [role="tab"]', (tabs) => tabs.map((tab) => tab.getBoundingClientRect().height))
    if (tabHeights.length !== 4 || tabHeights.some((height) => height < 44)) throw new Error(`mobile Tool tabs are not touch-sized: ${JSON.stringify(tabHeights)}`)

    await clickFirstVisible(actor.page, '[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-terminal-tab"]', { description: 'Mobile terminal tab' })
    await actor.page.waitForFunction(() => document.querySelector('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-terminal-tab"]')?.getAttribute('aria-selected') === 'true')
    await actor.page.waitForSelector('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-terminal-content"][aria-hidden="false"]')
    const terminalControls = await actor.page.$$eval('[data-testid="inspector-drawer-mobile"] [data-testid="terminal-toolbar"] button, [data-testid="inspector-drawer-mobile"] [data-testid="terminal-touch-keys"] button', (buttons) => buttons.map((button) => ({ label: button.getAttribute('aria-label') ?? button.textContent ?? '', height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width })))
    if (terminalControls.length < 7 || terminalControls.some((control) => control.height < 44 || control.width < 44)) throw new Error(`mobile Terminal controls are not touch-sized: ${JSON.stringify(terminalControls)}`)

    await actor.page.click('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-files-tab"]')
    await actor.page.waitForSelector('[data-testid="inspector-drawer-mobile"] [data-testid="right-panel-files-content"] [data-testid="session-files-panel"]', { visible: true })
    await actor.page.click('[data-testid="inspector-drawer-mobile"] [aria-label="Refresh files"]')
    await sleep(150)
    const csvRow = await findFileRow(actor.page, 'e2e-data.csv', '[data-testid="inspector-drawer-mobile"]')
    await clickElement(csvRow, 'Open mobile e2e-data.csv')
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
    await clickFirstVisible(actor.page, '[data-testid="source-control-file"]', { textIncludes: 'e2e-visible.txt', description: 'e2e-visible.txt source control row' })
    await actor.page.waitForSelector('[data-testid="source-control-diff-dialog"]')
    await actor.page.waitForFunction(() => document.body.innerText.includes('GIT_DIFF_VISIBLE'), { timeout: 30_000 })
    await actor.page.keyboard.press('Escape')
    await actor.page.waitForSelector('[data-testid="source-control-diff-dialog"]', { hidden: true })
    await actor.page.waitForFunction(() => document.querySelectorAll('[data-testid="dialog-overlay"]').length === 0)
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
  const rowSelector = `${scope} [data-testid="session-file-file"]`.trim()
  let rows = await page.$$(rowSelector)
  for (const rowButton of rows) {
    if (await rowButton.evaluate((element, expected) => element.textContent?.includes(expected), name)) return rowButton
  }
  const treeSelector = `${scope} [role="tree"]`.trim()
  await page.focus(treeSelector)
  await page.keyboard.press('End')
  await page.waitForFunction(
    (selector, expected) => [...document.querySelectorAll(selector)].some((element) => element.textContent?.includes(expected)),
    { timeout: 30_000 },
    rowSelector,
    name,
  )
  rows = await page.$$(rowSelector)
  for (const rowButton of rows) {
    if (await rowButton.evaluate((element, expected) => element.textContent?.includes(expected), name)) return rowButton
  }
  throw new Error(`file row not found: ${name}`)
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

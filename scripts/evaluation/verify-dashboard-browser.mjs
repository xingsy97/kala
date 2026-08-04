#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = resolve(new URL('../..', import.meta.url).pathname)
const port = 42190 + Math.floor(Math.random() * 500)
const origin = 'http://127.0.0.1:' + String(port)
const exactSliceHash = 'a'.repeat(64)
const comparisonSliceHash = 'c'.repeat(64)
const deletionImpactHash = 'b'.repeat(64)
const routes = [
  { id: 'overview', path: '/', label: 'Overview' },
  { id: 'library', path: '/library', label: 'Test Library' },
  { id: 'runs', path: '/runs', label: 'Runs' },
  { id: 'leaderboard', path: '/leaderboard', label: 'Leaderboard' },
  { id: 'analysis', path: '/analysis', label: 'Analysis' },
  { id: 'defects', path: '/defects', label: 'Defects' },
  { id: 'regression', path: '/regression', label: 'Regression' },
  { id: 'insights', path: '/insights', label: 'Insights' },
  { id: 'reports', path: '/reports', label: 'Reports' },
  { id: 'administration', path: '/administration', label: 'Administration' },
]
const scenarios = [
  { id: 'loading', expected: 'loading' },
  { id: 'ready', expected: 'ready' },
  { id: 'empty', expected: 'empty' },
  { id: 'partial', expected: 'partial' },
  { id: 'error', expected: 'error' },
  { id: 'unsupported-capability', expected: 'unsupported' },
  { id: 'unsupported-protocol', expected: 'unsupported' },
]
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1000 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
]
const serverOutput = { stdout: '', stderr: '' }
const server = spawn(process.execPath, [join(root, 'scripts/evaluation/dashboard-fixture-server.mjs'), join(root, 'packages/eval-dashboard/dist'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', (chunk) => { serverOutput.stdout += String(chunk) })
server.stderr.on('data', (chunk) => { serverOutput.stderr += String(chunk) })
let browser

try {
  await waitForServer(origin)
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, protocolTimeout: 120_000, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const stateMatrix = []
  const responsive = []
  const largePages = []
  const telemetry = { pageErrors: [], consoleErrors: [], httpErrors: [], requestFailures: [] }

  for (const route of routes) {
    const page = await instrumentedPage(browser, telemetry, viewports[0])
    for (const scenario of scenarios) {
      page.__acceptanceContext = route.id + ':' + scenario.id
      const started = now()
      await page.goto(routeUrl(route, scenario.id), { waitUntil: 'domcontentloaded', timeout: 15_000 })
      await waitForRouteState(page, route.id, scenario.expected)
      const snapshot = await pageSnapshot(page)
      snapshot.loadMs = now() - started
      snapshot.scenario = scenario.id
      snapshot.expected = scenario.expected
      snapshot.expectedRoute = route.id
      if (scenario.id === 'loading') await waitForRouteState(page, route.id, 'ready')
      if (scenario.id === 'error') {
        await page.evaluate(() => { document.cookie = 'dashboard-fixture=ready; Path=/; SameSite=Lax' })
        await page.click('.status-panel button')
        await waitForRouteState(page, route.id, 'ready')
        snapshot.retryRecovered = true
      }
      stateMatrix.push(snapshot)
    }
    page.__acceptanceContext = route.id + ':offline'
    await page.goto(routeUrl(route, 'ready'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await waitForRouteState(page, route.id, 'ready')
    await page.setOfflineMode(true)
    await page.click('.top-actions button')
    await waitForRouteState(page, route.id, 'offline')
    const offline = await pageSnapshot(page)
    offline.scenario = 'offline'
    offline.expected = 'offline'
    offline.expectedRoute = route.id
    await page.setOfflineMode(false)
    await page.waitForFunction(() => navigator.onLine)
    await page.click('.status-panel button')
    await waitForRouteState(page, route.id, 'ready')
    offline.reconnectRecovered = true
    stateMatrix.push(offline)

    page.__acceptanceContext = route.id + ':stale'
    await page.evaluate(() => { document.cookie = 'dashboard-fixture=stale; Path=/; SameSite=Lax' })
    await page.click('.top-actions button')
    await waitForRouteState(page, route.id, 'stale')
    const stale = await pageSnapshot(page)
    stale.scenario = 'stale'
    stale.expected = 'stale'
    stale.expectedRoute = route.id
    stale.retainedAuthoritativeContent = await page.evaluate(() => document.querySelectorAll('table tbody tr').length > 0 || !!document.querySelector('.hero-card'))
    await page.evaluate(() => { document.cookie = 'dashboard-fixture=ready; Path=/; SameSite=Lax' })
    await page.click('.status-panel button')
    await waitForRouteState(page, route.id, 'ready')
    stale.retryRecovered = true
    stateMatrix.push(stale)
    await page.close()
  }

  for (const viewport of viewports) {
    for (const route of routes) {
      const page = await instrumentedPage(browser, telemetry, viewport)
      page.__acceptanceContext = route.id + ':responsive-' + viewport.name
      const started = now()
      await page.goto(routeUrl(route, 'ready'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
      await waitForRouteState(page, route.id, 'ready')
      const result = await page.evaluate(({ routeId, routeLabel }) => {
        const navButtons = [...document.querySelectorAll('nav button')]
        const regions = [...document.querySelectorAll('[role="region"]')]
        const active = document.querySelector('nav [aria-current="page"]')
        return {
          route: routeId,
          heading: document.querySelector('main h1')?.textContent?.trim(),
          navItems: navButtons.length,
          activeName: active?.getAttribute('aria-label'),
          navNames: navButtons.map((button) => button.getAttribute('aria-label')),
          rootHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          unnamedButtons: [...document.querySelectorAll('button')].filter((button) => !(button.getAttribute('aria-label') || button.textContent?.trim())).length,
          unlabeledInputs: [...document.querySelectorAll('input')].filter((input) => !input.closest('label') && !input.getAttribute('aria-label')).length,
          scrollRegionsKeyboardReachable: regions.every((region) => region.getAttribute('tabindex') === '0'),
          landmarks: { complementary: !!document.querySelector('aside[aria-label="Primary navigation"]'), navigation: !!document.querySelector('nav'), main: !!document.querySelector('main') },
          oneH1: document.querySelectorAll('h1').length === 1,
          routeMatches: document.querySelector('main')?.getAttribute('data-route') === routeId && document.querySelector('h1')?.textContent === routeLabel,
        }
      }, { routeId: route.id, routeLabel: route.label })
      responsive.push({ viewport: viewport.name, width: viewport.width, height: viewport.height, loadMs: now() - started, ...result })
      await page.close()
    }
  }

  for (const route of routes) {
    const page = await instrumentedPage(browser, telemetry, viewports[0])
    page.__acceptanceContext = route.id + ':large'
    const started = now()
    await page.goto(routeUrl(route, 'large'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await waitForRouteState(page, route.id, 'partial')
    const measured = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('table')]
      return {
        rows: tables.map((table) => table.querySelectorAll('tbody tr').length),
        virtualizedTables: [...document.querySelectorAll('.table-wrap')].map((region) => ({
          virtualized: region.getAttribute('data-virtualized') === 'true',
          totalRows: Number(region.getAttribute('data-total-rows') ?? '0'),
          renderedRows: Number(region.getAttribute('data-rendered-rows') ?? '0'),
        })),
        scrollableTables: [...document.querySelectorAll('.table-wrap')].every((region) => region.scrollWidth >= region.clientWidth && region.getAttribute('tabindex') === '0'),
        rootHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        partialNotice: document.body.textContent?.includes('first authoritative page') ?? false,
      }
    })
    largePages.push({ route: route.id, loadMs: now() - started, responsePageLimit: route.id === 'overview' ? 8 : 100, ...measured })
    await page.close()
  }

  const keyboard = await verifyKeyboardAndFocus(browser, telemetry)
  const leaderboard = await verifyLeaderboard(browser, telemetry)
  const liveEvents = await verifyLiveEventRecovery(browser, telemetry)
  const operatorCommands = await verifyOperatorCommands(browser, telemetry)
  const productWorkflows = await verifyProductWorkflows(browser, telemetry)
  const internationalization = await verifyInternationalization(browser, telemetry)
  const contrast = contrastAcceptance()
  const failures = validate({ stateMatrix, responsive, largePages, telemetry, keyboard, leaderboard, liveEvents, operatorCommands, productWorkflows, internationalization, contrast })
  if (failures.length) throw new Error('dashboard browser acceptance failed:\n' + failures.map((failure) => '- ' + failure).join('\n'))

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'fresh standalone production bundle and synthetic authoritative Control Plane; no Host session or historical artifact input',
    browser: { version: await browser.version(), executable: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true },
    budgets: { routeLoadMs: 3_000, maximumApiPageSize: 100, minimumTextContrast: 4.5 },
    routeInventory: routes,
    stateMatrix,
    responsive,
    largePages,
    keyboard,
    leaderboard,
    liveEvents,
    operatorCommands,
    productWorkflows,
    internationalization,
    contrast,
    telemetry,
    summary: { routes: routes.length, routeStateChecks: stateMatrix.length, responsiveChecks: responsive.length, largePageChecks: largePages.length, leaderboardPivots: leaderboard.pivots.length, liveEventRecoveryChecks: 1, operatorCommandChecks: 5, productWorkflowChecks: Object.keys(productWorkflows).length, failures: 0 },
    sourceHashes: await sourceHashes([
      'packages/eval-dashboard/src/app.tsx', 'packages/eval-dashboard/src/client.ts', 'packages/eval-dashboard/src/operator-session.ts', 'packages/eval-dashboard/src/routes.ts', 'packages/eval-dashboard/src/styles.css',
      'scripts/evaluation/dashboard-fixture-server.mjs', 'scripts/evaluation/verify-dashboard-browser.mjs',
    ]),
  }
  const output = option('--output')
  if (output) {
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  process.stdout.write(JSON.stringify({ ok: true, ...evidence.summary, output: output ? resolve(output) : undefined }) + '\n')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await Promise.race([new Promise((resolvePromise) => server.once('exit', resolvePromise)), delay(2_000)])
  if (serverOutput.stderr.trim()) process.stderr.write(serverOutput.stderr)
}

async function instrumentedPage(activeBrowser, telemetry, viewport) {
  const page = await activeBrowser.newPage()
  page.__acceptanceContext = 'setup'
  await page.setViewport(viewport)
  await page.setCacheEnabled(false)
  page.on('pageerror', (error) => telemetry.pageErrors.push({ context: page.__acceptanceContext, message: String(error) }))
  page.on('console', (message) => { if (message.type() === 'error') telemetry.consoleErrors.push({ context: page.__acceptanceContext, message: message.text() }) })
  page.on('response', (response) => { if (response.status() >= 400) telemetry.httpErrors.push({ context: page.__acceptanceContext, status: response.status(), url: response.url() }) })
  page.on('requestfailed', (request) => telemetry.requestFailures.push({ context: page.__acceptanceContext, url: request.url(), error: request.failure()?.errorText }))
  return page
}

async function verifyKeyboardAndFocus(activeBrowser, telemetry) {
  const page = await instrumentedPage(activeBrowser, telemetry, viewports[0])
  page.__acceptanceContext = 'keyboard'
  await page.goto(routeUrl(routes[2], 'ready'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  await page.waitForSelector('.trace-panel[data-trace-state="ready"]')
  await page.keyboard.press('Tab')
  const skip = await page.evaluate(() => ({ className: document.activeElement?.className, outline: getComputedStyle(document.activeElement).outlineStyle, top: getComputedStyle(document.activeElement).top }))
  await page.keyboard.press('Enter')
  const skippedToMain = await page.evaluate(() => document.activeElement?.id === 'main')
  await page.evaluate(() => document.querySelector('nav button[aria-label="Test Library"]')?.focus())
  const navOutline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => location.pathname === '/library' && document.querySelector('main')?.getAttribute('data-route') === 'library')
  const keyboardNavigation = await page.evaluate(() => document.querySelector('nav [aria-current="page"]')?.getAttribute('aria-label'))
  await page.close()
  return { firstTabTarget: skip.className, skipLinkVisibleTop: skip.top, skipLinkOutline: skip.outline, skippedToMain, navFocusOutline: navOutline, keyboardNavigation }
}

async function verifyLeaderboard(activeBrowser, telemetry) {
  const page = await instrumentedPage(activeBrowser, telemetry, viewports[0])
  page.__acceptanceContext = 'leaderboard-pivots'
  const requests = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/v1/query') || request.method() !== 'POST') return
    try {
      const query = JSON.parse(request.postData() ?? '{}')
      if (query.resource === 'leaderboard') requests.push(query)
    } catch {}
  })
  await page.goto(routeUrl(routes[3], 'ready'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'leaderboard', 'ready')
  const pivots = []
  for (const [index, pivot] of ['model', 'agent_type', 'test_dataset'].entries()) {
    await page.click('.segmented button:nth-child(' + String(index + 1) + ')')
    const before = requests.length
    await page.click('.filter-bar .primary')
    await waitFor(() => requests.length > before, 5_000, 'leaderboard request for ' + pivot)
    await page.waitForFunction((expected) => new URLSearchParams(location.search).get('pivot') === expected, {}, pivot)
    pivots.push(await page.evaluate((expected) => ({
      pivot: expected,
      pressed: document.querySelector('.segmented [aria-pressed="true"]')?.textContent?.trim(),
      urlPivot: new URLSearchParams(location.search).get('pivot'),
      urlSlice: new URLSearchParams(location.search).get('sliceManifestHash'),
      exactSlice: document.querySelector('[data-slice-manifest-hash]')?.getAttribute('data-slice-manifest-hash'),
      badge: document.querySelector('.slice-badge')?.textContent?.replace(/\s+/gu, ' ').trim(),
      rows: document.querySelectorAll('table tbody tr').length,
      csvDownload: document.querySelector('.leaderboard-exports a[download$=".csv"]')?.getAttribute('download'),
      jsonDownload: document.querySelector('.leaderboard-exports a[download$=".json"]')?.getAttribute('download'),
    }), pivot))
  }
  await page.click('.row-expander')
  const expansion = await page.evaluate(() => ({ links: [...document.querySelectorAll('.leaderboard-details a')].map((link) => ({ text: link.textContent?.trim(), href: link.getAttribute('href') })), comparabilityKey: document.querySelector('.leaderboard-details code')?.textContent }))

  await page.select('.leaderboard-filters label:nth-of-type(1) select', 'audit')
  await page.select('.leaderboard-filters label:nth-of-type(2) select', 'codex')
  await page.type('.leaderboard-filters label:nth-of-type(3) input', 'fixture-model')
  await page.select('.leaderboard-filters label:nth-of-type(4) select', 'cost')
  await page.select('.leaderboard-filters label:nth-of-type(5) select', 'asc')
  const requestsBeforeAudit = requests.length
  await page.click('.leaderboard-filters .primary')
  await waitFor(() => requests.length > requestsBeforeAudit, 5_000, 'filtered Leaderboard audit request')
  await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'audit')
  const audit = await page.evaluate(() => ({
    url: Object.fromEntries(new URLSearchParams(location.search)),
    view: document.querySelector('[data-view]')?.getAttribute('data-view'),
    heading: [...document.querySelectorAll('.panel-heading h2')].find((element) => element.textContent?.includes('Invalidated'))?.textContent,
    ranks: [...document.querySelectorAll('.leaderboard-table tbody tr:not(.leaderboard-details):not(.virtual-spacer) td:first-child')].map((cell) => cell.textContent?.trim()),
    statuses: [...document.querySelectorAll('.leaderboard-table tbody tr:not(.leaderboard-details):not(.virtual-spacer) td:last-child')].map((cell) => cell.textContent?.trim()),
  }))

  const comparisonInput = '.exploratory-comparison input'
  await page.type(comparisonInput, comparisonSliceHash)
  const requestsBeforePreview = requests.length
  await clickButton(page, 'Preview warning')
  const warning = await page.$eval('.comparability-warning', (element) => element.textContent?.replace(/\s+/gu, ' ').trim())
  const requestsAfterPreview = requests.length
  await clickButton(page, 'I understand · load unranked comparison')
  await waitFor(() => requests.length > requestsAfterPreview, 5_000, 'unranked cross-slice comparison request')
  await page.waitForSelector('[data-comparison-slice]')
  const comparison = await page.evaluate(() => ({
    urlSlice: new URLSearchParams(location.search).get('compareSliceManifestHash'),
    requestedSlice: document.querySelector('[data-comparison-slice]')?.getAttribute('data-comparison-slice'),
    badge: document.querySelector('[data-comparison-slice] .slice-badge')?.textContent?.replace(/\s+/gu, ' ').trim(),
    ranks: [...document.querySelectorAll('[data-comparison-slice] .leaderboard-table tbody tr:not(.leaderboard-details):not(.virtual-spacer) td:first-child')].map((cell) => cell.textContent?.trim()),
  }))
  const result = { pivots, requests, querySliceHashes: [...new Set(requests.slice(0, 4).map((query) => query.sliceManifestHash))], expansion, audit, comparison: { ...comparison, warning, requestsBeforePreview, requestsAfterPreview } }
  await page.close()
  return result
}

async function verifyLiveEventRecovery(activeBrowser, telemetry) {
  const page = await instrumentedPage(activeBrowser, telemetry, viewports[0])
  page.__acceptanceContext = 'live-event-recovery'
  const eventRequests = []
  let authoritativeQueries = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/events') eventRequests.push({ runId: url.searchParams.get('runId'), after: url.searchParams.get('after') })
    if (url.pathname === '/api/v1/query' && request.method() === 'POST') authoritativeQueries += 1
  })
  await page.goto(routeUrl(routes[2], 'live'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-live-sequence') === '2' && document.querySelector('main')?.getAttribute('data-live-state') === 'connected', { timeout: 10_000 })
  const result = await page.evaluate(() => ({ sequence: document.querySelector('main')?.getAttribute('data-live-sequence'), liveState: document.querySelector('main')?.getAttribute('data-live-state') }))
  await page.close()
  return { ...result, authoritativeQueries, eventRequests, droppedSequenceDetected: eventRequests.length >= 2 && eventRequests[0]?.after === '0' && eventRequests[1]?.after === '0', resumedAfterSequence: eventRequests.some((request) => request.after === '2') }
}

async function verifyOperatorCommands(activeBrowser, telemetry) {
  await fetch(origin + '/api/v1/fixture/reset', { method: 'POST' })
  const page = await instrumentedPage(activeBrowser, telemetry, viewports[0])
  page.__acceptanceContext = 'operator-commands'
  await page.goto(routeUrl(routes[2], 'ready'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  const sessionBeforeReload = await page.$eval('.operator-strip', (element) => element.getAttribute('data-operator-session'))
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  const sessionAfterReload = await page.$eval('.operator-strip', (element) => element.getAttribute('data-operator-session'))

  await clickButton(page, 'Cancel run')
  await page.waitForSelector('.confirmation-dialog')
  const cancelBeforeConfirmation = (await fixtureState()).receivedCommands.length
  await typeConfirmation(page, 'cancel:wrong-run')
  const cancelWrongConfirmationDisabled = await buttonDisabled(page, 'Confirm cancel')
  const cancelAfterWrongConfirmation = (await fixtureState()).receivedCommands.length
  await typeConfirmation(page, 'cancel:browser-run-1')
  await clickButton(page, 'Confirm cancel')
  await page.waitForSelector('.command-status.committed')
  const afterCancel = await fixtureState()

  await clickButton(page, 'Publish run')
  await page.waitForSelector('.confirmation-dialog')
  const publishBeforeConfirmation = (await fixtureState()).receivedCommands.length
  const publishInitiallyDisabled = await buttonDisabled(page, 'Confirm publish')
  await typeConfirmation(page, 'publish:browser-run-1')
  await clickButton(page, 'Confirm publish')
  await page.waitForSelector('.command-status.committed')
  const afterPublish = await fixtureState()

  const queriesBeforeDelete = (await fixtureState()).receivedQueries.length
  await clickButton(page, 'Delete run')
  await page.waitForFunction((hash) => document.querySelector('.impact-preview')?.textContent?.includes(hash), {}, deletionImpactHash)
  const afterImpact = await fixtureState()
  const deleteBeforeConfirmation = afterImpact.receivedCommands.length
  await typeConfirmation(page, 'delete:browser-run-1')
  await clickButton(page, 'Confirm delete')
  await page.waitForSelector('.command-status.committed')
  const afterDelete = await fixtureState()

  await page.goto(routeUrl(routes[2], 'protected-delete'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  await clickButton(page, 'Delete run')
  await page.waitForFunction(() => document.querySelector('.impact-preview')?.textContent?.includes('release-baseline'))
  await typeConfirmation(page, 'delete:browser-run-1')
  const protectedDeleteDisabled = await buttonDisabled(page, 'Confirm delete')
  const afterProtectedDelete = await fixtureState()

  page.__acceptanceContext = 'operator-commands:retryable-failure'
  await page.goto(routeUrl(routes[2], 'command-failure-once'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  await clickButton(page, 'Cancel run')
  await typeConfirmation(page, 'cancel:browser-run-1')
  await clickButton(page, 'Confirm cancel')
  await page.waitForSelector('.command-status.failed')
  const afterFailure = await fixtureState()
  const failedCommand = afterFailure.receivedCommands.at(-1)?.command
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  const failedStateRestored = await page.$eval('.command-status', (element) => element.getAttribute('data-command-state'))
  await clickButton(page, 'Retry same command')
  await page.waitForSelector('.command-status.committed')
  const afterRetry = await fixtureState()
  const retriedCommand = afterRetry.receivedCommands.at(-1)?.command
  const committedStateRestoredBeforeRefresh = await page.$eval('.command-status', (element) => element.getAttribute('data-command-state'))
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  const committedStateRestoredAfterRefresh = await page.$eval('.command-status', (element) => element.getAttribute('data-command-state'))
  await page.close()

  const deleteCommand = afterDelete.receivedCommands.find((entry) => entry.command.type === 'run.delete')?.command
  return {
    sessionBeforeReload, sessionAfterReload,
    cancel: { beforeConfirmation: cancelBeforeConfirmation, afterWrongConfirmation: cancelAfterWrongConfirmation, wrongConfirmationDisabled: cancelWrongConfirmationDisabled, command: afterCancel.receivedCommands.at(-1)?.command, authoritativeRunQueries: afterCancel.receivedQueries.filter((entry) => entry.query.resource === 'runs').length },
    publish: { beforeConfirmation: publishBeforeConfirmation, initiallyDisabled: publishInitiallyDisabled, command: afterPublish.receivedCommands.at(-1)?.command },
    deletion: { queriesBefore: queriesBeforeDelete, impactQueried: afterImpact.receivedQueries.some((entry) => entry.query.resource === 'deletion-impact' && entry.query.runId === 'browser-run-1'), beforeConfirmation: deleteBeforeConfirmation, command: deleteCommand, protectedDeleteDisabled, commandsAfterProtectedDelete: afterProtectedDelete.receivedCommands.length },
    retry: { failedStateRestored, committedStateRestoredBeforeRefresh, committedStateRestoredAfterRefresh, firstIdempotencyKey: failedCommand?.idempotencyKey, retryIdempotencyKey: retriedCommand?.idempotencyKey, sameCommand: JSON.stringify(failedCommand) === JSON.stringify(retriedCommand), attempts: afterRetry.receivedCommands.filter((entry) => entry.scenario === 'command-failure-once' && entry.command.idempotencyKey === failedCommand?.idempotencyKey).length },
  }
}

async function verifyProductWorkflows(activeBrowser, telemetry) {
  const page = await instrumentedPage(activeBrowser, telemetry, viewports[0])
  page.__acceptanceContext = 'product-workflows'
  await page.goto(routeUrl(routes[2], 'ready'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  await page.waitForSelector('.run-detail[data-selected-run="browser-run-1"]')
  await page.waitForSelector('.trace-panel[data-trace-state="ready"]')
  const runDetails = await page.evaluate(() => ({
    selectedRun: document.querySelector('.run-detail')?.getAttribute('data-selected-run'),
    selectedTrial: document.querySelector('.run-detail')?.getAttribute('data-selected-trial'),
    trialRows: document.querySelector('.run-detail .table-wrap')?.getAttribute('data-total-rows'),
    artifactLinks: document.querySelectorAll('.artifact-links a').length,
    traceState: document.querySelector('.trace-panel')?.getAttribute('data-trace-state'),
    traceVisualHidden: document.querySelector('.trace-strip')?.getAttribute('aria-hidden'),
    traceRows: document.querySelector('.trace-panel .table-wrap')?.getAttribute('data-total-rows'),
    traceRenderedRows: document.querySelector('.trace-panel .table-wrap')?.getAttribute('data-rendered-rows'),
    traceTableKeyboardReachable: document.querySelector('.trace-panel .table-wrap')?.getAttribute('tabindex'),
    immutablePreviewEntry: !![...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'New run specification'),
  }))
  await page.goto(routeUrl(routes[2], 'trace-large'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'runs', 'ready')
  await page.waitForSelector('.trace-panel[data-trace-state="ready"]')
  const largeTrace = await page.evaluate(() => ({
    totalRows: Number(document.querySelector('.trace-panel .table-wrap')?.getAttribute('data-total-rows') ?? '0'),
    renderedRows: Number(document.querySelector('.trace-panel .table-wrap')?.getAttribute('data-rendered-rows') ?? '0'),
    virtualized: document.querySelector('.trace-panel .table-wrap')?.getAttribute('data-virtualized'),
    keyboardReachable: document.querySelector('.trace-panel .table-wrap')?.getAttribute('tabindex'),
  }))

  const workflows = {}
  for (const routeId of ['analysis', 'defects', 'regression', 'insights', 'reports', 'administration']) {
    const route = routes.find((candidate) => candidate.id === routeId)
    await page.goto(routeUrl(route, 'ready'), { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await waitForRouteState(page, routeId, 'ready')
    workflows[routeId] = await page.evaluate((id) => ({
      route: document.querySelector('main')?.getAttribute('data-route'),
      panels: document.querySelectorAll('.panel').length,
      commandWorkflow: !!document.querySelector('.command-workflow'),
      supportedCommandText: document.querySelector('.command-workflow > p')?.textContent,
      reportDownloads: id === 'reports' ? document.querySelectorAll('.download-grid a').length : undefined,
      retentionVisible: id === 'administration' ? document.body.textContent?.includes('Retention & artifact policy') : undefined,
    }), routeId)
  }
  await page.close()
  return { runDetails, largeTrace, ...workflows }
}

async function verifyInternationalization(activeBrowser, telemetry) {
  const page = await instrumentedPage(activeBrowser, telemetry, viewports[0])
  page.__acceptanceContext = 'internationalization'
  await page.goto(origin + '/leaderboard?fixture=ready&locale=zh-CN&pivot=model&sliceManifestHash=' + exactSliceHash, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await waitForRouteState(page, 'leaderboard', 'ready')
  const initial = await page.evaluate(() => ({ language: document.documentElement.lang, heading: document.querySelector('h1')?.textContent, activeNav: document.querySelector('[aria-current="page"]')?.getAttribute('aria-label'), selector: document.querySelector('.locale-selector select')?.value }))
  await page.select('.locale-selector select', 'en')
  await page.waitForFunction(() => document.documentElement.lang === 'en' && document.querySelector('h1')?.textContent === 'Leaderboard')
  const switched = await page.evaluate(() => ({ language: document.documentElement.lang, heading: document.querySelector('h1')?.textContent, stored: localStorage.getItem('agent-eval-locale') }))
  await page.close()
  return { initial, switched }
}

async function fixtureState() {
  const response = await fetch(origin + '/api/v1/fixture/state')
  if (!response.ok) throw new Error('fixture state request failed')
  return await response.json()
}

async function clickButton(page, text) {
  await page.waitForFunction((label) => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === label && !button.disabled), {}, text)
  await page.evaluate((label) => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)?.click(), text)
}

async function buttonDisabled(page, text) {
  return await page.evaluate((label) => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)?.disabled, text)
}

async function typeConfirmation(page, value) {
  await page.click('.confirmation-dialog input')
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.type('.confirmation-dialog input', value)
}

function validate(result) {
  const failures = []
  for (const entry of result.stateMatrix) {
    if (entry.route !== entry.expectedRoute) failures.push('state matrix rendered wrong route for ' + entry.expectedRoute + ':' + entry.scenario)
    if (entry.loadState !== entry.expected) failures.push(entry.expectedRoute + ':' + entry.scenario + ' expected ' + entry.expected + ', got ' + entry.loadState)
    if (entry.scenario === 'loading' && entry.ariaBusy !== 'true') failures.push(entry.expectedRoute + ':loading did not expose aria-busy')
    if (entry.scenario === 'error' && !entry.retryRecovered) failures.push(entry.expectedRoute + ':error did not recover through retry')
    if (entry.scenario === 'offline' && !entry.reconnectRecovered) failures.push(entry.expectedRoute + ':offline did not recover after reconnect')
    if (entry.scenario === 'stale' && (!entry.retainedAuthoritativeContent || !entry.retryRecovered || !entry.status?.includes('Stale data'))) failures.push(entry.expectedRoute + ':stale did not retain authoritative data and recover through retry')
  }
  for (const entry of result.responsive) {
    if (!entry.routeMatches || entry.navItems !== 10 || entry.rootHorizontalOverflow || entry.unnamedButtons || entry.unlabeledInputs || !entry.scrollRegionsKeyboardReachable || !entry.oneH1 || Object.values(entry.landmarks).some((value) => !value)) failures.push('responsive/a11y failure: ' + JSON.stringify(entry))
    if (entry.loadMs > 3_000) failures.push(entry.route + ':' + entry.viewport + ' exceeded route load budget: ' + String(entry.loadMs))
  }
  for (const entry of result.largePages) {
    if (entry.loadMs > 3_000 || entry.responsePageLimit > 100 || entry.rootHorizontalOverflow || !entry.partialNotice || !entry.scrollableTables) failures.push('large-page performance failure: ' + JSON.stringify(entry))
    if (entry.route !== 'overview' && !entry.virtualizedTables.some((table) => table.virtualized && table.totalRows >= 100 && table.renderedRows < table.totalRows)) failures.push('large-page virtualization failure: ' + JSON.stringify(entry))
  }
  if (result.keyboard.firstTabTarget !== 'skip-link' || result.keyboard.skipLinkOutline === 'none' || result.keyboard.skippedToMain !== true || result.keyboard.navFocusOutline === 'none' || result.keyboard.keyboardNavigation !== 'Test Library') failures.push('keyboard/focus acceptance failed: ' + JSON.stringify(result.keyboard))
  if (result.leaderboard.pivots.length !== 3 || result.leaderboard.querySliceHashes.length !== 1 || result.leaderboard.querySliceHashes[0] !== exactSliceHash) failures.push('leaderboard queries did not preserve one exact slice')
  for (const pivot of result.leaderboard.pivots) {
    if (pivot.urlPivot !== pivot.pivot || pivot.urlSlice !== exactSliceHash || pivot.exactSlice !== exactSliceHash || pivot.rows < 1 || !pivot.badge?.includes('sampled subset') || !pivot.badge.includes('500/5000') || !pivot.badge.includes('10%') || !pivot.badge.includes('seed 42') || !pivot.badge.includes('language=python') || pivot.csvDownload !== 'leaderboard-' + exactSliceHash + '.csv' || pivot.jsonDownload !== 'leaderboard-' + exactSliceHash + '.json') failures.push('leaderboard pivot provenance failure: ' + JSON.stringify(pivot))
  }
  if (result.leaderboard.expansion.links.length !== 4 || !result.leaderboard.expansion.links.some((link) => link.text === 'Contributing runs' && link.href?.startsWith('/runs?runId=')) || !result.leaderboard.expansion.links.some((link) => link.text === 'Methodology' && link.href?.startsWith('/reports?runId=')) || !result.leaderboard.expansion.comparabilityKey?.includes(exactSliceHash)) failures.push('leaderboard row expansion/provenance links failed: ' + JSON.stringify(result.leaderboard.expansion))
  const audit = result.leaderboard.audit
  if (audit.view !== 'audit' || audit.url.view !== 'audit' || audit.url.agentType !== 'codex' || audit.url.modelId !== 'fixture-model' || audit.url.sortBy !== 'cost' || audit.url.sortDirection !== 'asc' || !audit.heading?.includes('Invalidated & superseded') || audit.ranks.some((rank) => rank !== '—') || audit.statuses.some((status) => status === 'active')) failures.push('leaderboard inactive audit/filter/sort failed: ' + JSON.stringify(audit))
  const comparison = result.leaderboard.comparison
  if (!comparison.warning?.includes('Not directly rank-comparable') || comparison.requestsBeforePreview !== comparison.requestsAfterPreview || comparison.urlSlice !== comparisonSliceHash || comparison.requestedSlice !== comparisonSliceHash || !comparison.badge?.includes('no shared rank') || comparison.ranks.some((rank) => rank !== '—')) failures.push('leaderboard warning-gated cross-slice exploration failed: ' + JSON.stringify(comparison))
  if (result.liveEvents.sequence !== '2' || result.liveEvents.liveState !== 'connected' || result.liveEvents.authoritativeQueries < 2 || !result.liveEvents.droppedSequenceDetected || !result.liveEvents.resumedAfterSequence) failures.push('live event dropped-sequence recovery failed: ' + JSON.stringify(result.liveEvents))
  const operator = result.operatorCommands
  if (!operator.sessionBeforeReload || operator.sessionBeforeReload !== operator.sessionAfterReload) failures.push('operator session did not survive refresh: ' + JSON.stringify(operator))
  if (operator.cancel.beforeConfirmation !== 0 || operator.cancel.afterWrongConfirmation !== 0 || !operator.cancel.wrongConfirmationDisabled || operator.cancel.command?.type !== 'run.cancel' || operator.cancel.authoritativeRunQueries < 2) failures.push('cancel confirmation/authoritative refresh failed: ' + JSON.stringify(operator.cancel))
  if (operator.publish.beforeConfirmation !== 1 || !operator.publish.initiallyDisabled || operator.publish.command?.type !== 'leaderboard.publish') failures.push('publish confirmation failed: ' + JSON.stringify(operator.publish))
  if (!operator.deletion.impactQueried || operator.deletion.beforeConfirmation !== 2 || operator.deletion.command?.type !== 'run.delete' || operator.deletion.command?.expectedImpactHash !== deletionImpactHash || operator.deletion.command?.confirmation !== 'delete:browser-run-1' || !operator.deletion.protectedDeleteDisabled || operator.deletion.commandsAfterProtectedDelete !== 3) failures.push('delete impact/confirmation failed: ' + JSON.stringify(operator.deletion))
  if (operator.retry.failedStateRestored !== 'failed' || operator.retry.committedStateRestoredBeforeRefresh !== 'committed' || operator.retry.committedStateRestoredAfterRefresh !== 'committed' || !operator.retry.sameCommand || operator.retry.firstIdempotencyKey !== operator.retry.retryIdempotencyKey || operator.retry.attempts !== 2) failures.push('operator retry continuity failed: ' + JSON.stringify(operator.retry))
  const workflows = result.productWorkflows
  if (workflows.runDetails.selectedRun !== 'browser-run-1' || !workflows.runDetails.selectedTrial || Number(workflows.runDetails.trialRows) < 1 || workflows.runDetails.artifactLinks < 1 || workflows.runDetails.traceState !== 'ready' || Number(workflows.runDetails.traceRows) < 1 || Number(workflows.runDetails.traceRenderedRows) !== Number(workflows.runDetails.traceRows) || workflows.runDetails.traceVisualHidden !== 'true' || workflows.runDetails.traceTableKeyboardReachable !== '0' || !workflows.runDetails.immutablePreviewEntry) failures.push('run detail/trace/immutable creation workflow failed: ' + JSON.stringify(workflows.runDetails))
  if (workflows.largeTrace.totalRows < 100 || workflows.largeTrace.renderedRows >= workflows.largeTrace.totalRows || workflows.largeTrace.virtualized !== 'true' || workflows.largeTrace.keyboardReachable !== '0') failures.push('large normalized trace virtualization failed: ' + JSON.stringify(workflows.largeTrace))
  if (result.internationalization.initial.language !== 'zh-CN' || result.internationalization.initial.heading !== '排行榜' || result.internationalization.initial.activeNav !== '排行榜' || result.internationalization.initial.selector !== 'zh-CN' || result.internationalization.switched.language !== 'en' || result.internationalization.switched.heading !== 'Leaderboard' || result.internationalization.switched.stored !== 'en') failures.push('internationalization-ready chrome failed: ' + JSON.stringify(result.internationalization))
  for (const route of ['analysis', 'defects', 'regression', 'insights', 'reports', 'administration']) {
    const workflow = workflows[route]
    if (workflow.route !== route || workflow.panels < 2 || !workflow.commandWorkflow || !workflow.supportedCommandText || workflow.supportedCommandText.endsWith('none advertised')) failures.push(route + ' product workflow failed: ' + JSON.stringify(workflow))
  }
  if (workflows.reports.reportDownloads !== 7 || workflows.administration.retentionVisible !== true) failures.push('report download or administration governance workflow failed: ' + JSON.stringify({ reports: workflows.reports, administration: workflows.administration }))
  if (Object.values(result.contrast.ratios).some((ratio) => ratio < 4.5)) failures.push('text contrast tokens are below 4.5:1')
  if (result.telemetry.pageErrors.length) failures.push('browser page errors: ' + JSON.stringify(result.telemetry.pageErrors))
  const expectedRetryFailure = (entry) => entry.context === 'operator-commands:retryable-failure' && (!entry.url || entry.url.endsWith('/api/v1/commands'))
  const expectedStaleHttp = (entry) => entry.context.endsWith(':stale') && entry.status === 503 && entry.url.endsWith('/api/v1/query')
  const expectedStaleConsole = (entry) => entry.context.endsWith(':stale') && entry.message.includes('status of 503')
  const unexpectedHttp = result.telemetry.httpErrors.filter((entry) => !entry.context.endsWith(':error') && !expectedStaleHttp(entry) && !expectedRetryFailure(entry))
  const unexpectedConsole = result.telemetry.consoleErrors.filter((entry) => !entry.context.endsWith(':error') && !entry.context.endsWith(':offline') && !expectedStaleConsole(entry) && !expectedRetryFailure(entry))
  const unexpectedFailures = result.telemetry.requestFailures.filter((entry) => !entry.context.endsWith(':offline') && !(entry.url.includes('/api/v1/events') && entry.error === 'net::ERR_ABORTED'))
  if (unexpectedHttp.length) failures.push('unexpected HTTP errors: ' + JSON.stringify(unexpectedHttp))
  if (unexpectedConsole.length) failures.push('unexpected console errors: ' + JSON.stringify(unexpectedConsole))
  if (unexpectedFailures.length) failures.push('unexpected request failures: ' + JSON.stringify(unexpectedFailures))
  return failures
}

async function pageSnapshot(page) {
  return await page.evaluate(() => {
    const main = document.querySelector('main')
    return {
      route: main?.getAttribute('data-route'),
      loadState: main?.getAttribute('data-load-state'),
      ariaBusy: main?.getAttribute('aria-busy'),
      heading: main?.querySelector('h1')?.textContent?.trim(),
      status: document.querySelector('.status-panel')?.textContent?.replace(/\s+/gu, ' ').trim(),
    }
  })
}

function routeUrl(route, scenario) {
  const url = new URL(route.path, origin)
  url.searchParams.set('fixture', scenario)
  if (route.id === 'leaderboard') {
    url.searchParams.set('pivot', 'model')
    url.searchParams.set('sliceManifestHash', exactSliceHash)
  }
  return url.href
}

async function waitForRouteState(page, route, state) {
  try {
    await page.waitForFunction((expectedRoute, expectedState) => {
      const main = document.querySelector('main')
      return main?.getAttribute('data-route') === expectedRoute && main?.getAttribute('data-load-state') === expectedState
    }, { timeout: 10_000 }, route, state)
  } catch (error) {
    const actual = await page.evaluate(() => ({ route: document.querySelector('main')?.getAttribute('data-route'), state: document.querySelector('main')?.getAttribute('data-load-state'), status: document.querySelector('.status-panel')?.textContent?.replace(/\s+/gu, ' ').trim() }))
    throw new Error('waiting for route=' + route + ' state=' + state + ' failed; actual=' + JSON.stringify(actual), { cause: error })
  }
}

async function waitForServer(url) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('dashboard fixture server exited early: ' + serverOutput.stderr)
    try { if ((await fetch(url)).ok) return } catch {}
    await delay(50)
  }
  throw new Error('dashboard fixture server did not start')
}

async function waitFor(predicate, timeout, description) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error('timed out waiting for ' + description)
}

function contrastAcceptance() {
  const background = '#07100f'
  return { background, ratios: { ink: contrast('#edf7f2', background), muted: contrast('#8da39d', background), green: contrast('#8af0c5', background), amber: contrast('#f2bc66', background) } }
}
function contrast(foreground, background) {
  const left = luminance(foreground)
  const right = luminance(background)
  return Math.round(((Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)) * 100) / 100
}
function luminance(hex) {
  return [1, 3, 5]
    .map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
}
async function sourceHashes(paths) {
  return await Promise.all(paths.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })))
}
function option(name) {
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) return process.argv[index + 1]
    if (process.argv[index]?.startsWith(name + '=')) return process.argv[index].slice(name.length + 1)
  }
}
function now() { return Math.round(performance.now()) }
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }

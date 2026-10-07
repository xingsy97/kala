#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { loginWithPassword, waitFor } from '../../product-e2e/harness.mjs'

const required = (name) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value }
const email = required('PRIVATE_CLOUD_TEST_EMAIL')
const password = required('PRIVATE_CLOUD_TEST_PASSWORD')
const marker = required('PRIVATE_CLOUD_WORKSPACE_MARKER')
if (!/^[A-Z0-9_-]+$/u.test(marker)) throw new Error('PRIVATE_CLOUD_WORKSPACE_MARKER must contain only uppercase letters, digits, underscores, or hyphens')
const workspaceRoot = resolve(required('PRIVATE_CLOUD_TEST_WORKSPACE_ROOT'))
const workspaceName = required('PRIVATE_CLOUD_TEST_WORKSPACE_NAME')
const screenshot = process.env.PRIVATE_CLOUD_EVIDENCE_SCREENSHOT?.trim()
const markerPath = join(workspaceRoot, `marker-${marker}.txt`)
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await loginWithPassword(page, { productOrigin: 'http://localhost:13001', loginName: email, password })
  await page.waitForFunction((name) => [...document.querySelectorAll('[data-testid=workspace-row]')].some((row) => row.textContent?.includes(name) && row.querySelector('[data-testid^=workspace-new-session-]')), { timeout: 60_000 }, workspaceName)
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[data-testid=workspace-row]')].find((entry) => entry.textContent?.includes(name) && entry.querySelector('[data-testid^=workspace-new-session-]'))
    row.querySelector('[data-testid^=workspace-new-session-]').click()
  }, workspaceName)
  await page.waitForFunction(() => { const create = document.querySelector('[data-testid=new-session-create]'); return create && !create.disabled }, { timeout: 60_000 })
  await page.click('[data-testid=new-session-create]')
  await page.waitForSelector('[data-testid=composer-input]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid=session-selected-marker]', { timeout: 60_000 })
  const sessionId = await page.evaluate(() => document.querySelector('[data-testid=session-selected-marker]')?.closest('[data-testid=session-row]')?.getAttribute('data-session-id'))
  if (!sessionId) throw new Error('created Workspace Session has no selected catalog entry')
  await page.waitForFunction(() => document.querySelector('[data-testid=connection-status], [data-testid=sidebar-connection-status]')?.getAttribute('data-status') === 'ready', { timeout: 60_000 })
  await page.type('[data-testid=composer-input]', `Use the write_file tool to create ${markerPath} containing exactly ${marker}. Then reply exactly ${marker}.`)
  await page.waitForFunction(() => { const send = document.querySelector('[data-testid=composer-send]'); return send && !send.disabled }, { timeout: 30_000 })
  await page.click('[data-testid=composer-send]')
  const approval = await waitFor(async () => {
    if (existsSync(markerPath)) return 'already-approved'
    return await page.evaluate((path) => [...document.querySelectorAll('[data-testid=approval-card]')].some((card) =>
      card.textContent?.includes('write_file') && card.textContent?.includes(path) &&
      card.querySelector('[data-testid=approval-approve]')?.getClientRects().length), markerPath) ? 'approval' : undefined
  }, { timeoutMs: 120_000, name: 'expected visible file-write approval or completed write' })
  if (approval === 'approval') {
    const approved = await page.evaluate((path) => {
      const card = [...document.querySelectorAll('[data-testid=approval-card]')].find((entry) =>
        entry.textContent?.includes('write_file') && entry.textContent?.includes(path) &&
        entry.querySelector('[data-testid=approval-approve]')?.getClientRects().length)
      const button = card?.querySelector('[data-testid=approval-approve]')
      if (!button) return false
      button.click()
      return true
    }, markerPath)
    if (!approved) throw new Error('target write_file approval disappeared before click')
  }
  await waitFor(() => readFileSync(markerPath, 'utf8') === marker, { timeoutMs: 180_000, intervalMs: 250, name: 'Executor write_file created the exact marker content' })
  await page.waitForFunction((expected) => document.body.innerText.split(expected).length - 1 >= 2, { timeout: 180_000 }, marker)
  const report = await page.evaluate(async () => ({
    origin: location.origin,
    benchmarkVisible: !!document.querySelector('[data-testid=app-shell-nav-benchmarks]'),
    explorerVisible: !!document.querySelector('[data-testid=explorer-panel]'),
    sessionFilesVisible: !!document.querySelector('[data-testid=session-files-panel]'),
    workspaceOffline: document.body.innerText.includes('Workspace executor is offline'),
    capabilities: await fetch('/runtime/capabilities').then((response) => response.json()),
  }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction((id) => [...document.querySelectorAll('[data-testid=session-row]')].some((row) => row.getAttribute('data-session-id') === id), { timeout: 60_000 }, sessionId)
  await page.evaluate((id) => [...document.querySelectorAll('[data-testid=session-row]')].find((row) => row.getAttribute('data-session-id') === id)?.click(), sessionId)
  await page.waitForFunction((expected) => document.body.innerText.includes(expected), { timeout: 60_000 }, marker)
  if (screenshot) await page.screenshot({ path: screenshot })
  const ok = report.origin === 'http://localhost:13001' && !report.benchmarkVisible && report.explorerVisible && report.sessionFilesVisible && !report.workspaceOffline && report.capabilities.product === 'private-cloud' && report.capabilities.deployment?.tenancy === 'multi-tenant' && errors.length === 0
  console.log(JSON.stringify({ ok, workspaceConnected: !report.workspaceOffline, fileWrittenByExecutor: true, replyPersistedAfterReload: true, explorerVisible: report.explorerVisible, sessionFilesVisible: report.sessionFilesVisible, capabilitiesVerified: report.capabilities.product === 'private-cloud', errors }))
  if (!ok) process.exitCode = 1
} finally { await browser.close() }

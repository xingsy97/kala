import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import puppeteer from 'puppeteer-core'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const outputRoot = resolve(repositoryRoot, 'packages/website/public/assets/product')
const prototypeUrl = process.env.PROTOTYPE_URL ?? 'http://127.0.0.1:4179/'
const chromiumPath = process.env.CHROMIUM_PATH ?? '/snap/bin/chromium'
const fixtureNow = Date.parse('2026-10-02T08:00:00.000Z')
const captures = []
let server

if (!await isReady(prototypeUrl)) {
  server = spawn(process.execPath, [await repositoryViteBin(),
    '--config',
    'vite.prototype.config.ts',
    '--host',
    '0.0.0.0',
    '--port',
    '4179',
  ], {
    cwd: resolve(repositoryRoot, 'packages/dashboard'),
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=8192' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForReady(prototypeUrl, server)
}

await mkdir(outputRoot, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: chromiumPath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
})

try {
  for (const theme of ['light', 'dark']) {
    const themedName = (name) => theme === 'light' ? `${name}.webp` : `${name}-dark.webp`
    await captureDesktop(browser, {
    name: themedName('hero-workbench'),
    theme,
    height: 900,
    sessionId: 'prototype-active',
    readySelector: '[data-testid="composer"]',
    verify: async (page) => {
      const files = await page.$eval('[data-testid="session-files-panel"]', (node) => node.textContent ?? '')
      if (files.includes('Loading files') || !files.includes('package.json')) {
        throw new Error(`prototype file fixture is not ready: ${files}`)
      }
      if (!await page.$('[data-testid="task-graph-trigger"]')) {
        throw new Error('prototype overview task graph access is not visible')
      }
    },
  })
    await captureDesktop(browser, {
    name: themedName('task-graph'),
    theme,
    height: 900,
    sessionId: 'prototype-active',
    readySelector: '[data-testid="task-graph-trigger"]',
    prepare: async (page) => {
      await page.$eval('[data-testid="task-graph-trigger"]', (node) => node.click())
      await page.waitForSelector('[data-testid="task-graph-popover"]', { visible: true })
      await page.$eval('[data-testid="task-graph-size-toggle"]', (node) => node.click())
      await page.waitForFunction(() => document.querySelector('[data-testid="task-graph-popover"]')?.getAttribute('data-expanded') === 'true')
    },
    verify: async (page) => {
      const graph = await page.$eval('[data-testid="task-graph-popover"]', (node) => node.textContent ?? '')
      if (!graph.includes('Approve production release') || !graph.includes('Audit keyboard and screen reader UX')) {
        throw new Error(`prototype task graph fixture is invalid: ${graph}`)
      }
      const expanded = await page.$eval('[data-testid="task-graph-popover"]', (node) => node.getAttribute('data-expanded'))
      if (expanded !== 'true') throw new Error('prototype task graph did not enter full-screen mode')
    },
  })
    await captureDesktop(browser, {
    name: themedName('ask-user-workflow'),
    theme,
    height: 900,
    sessionId: 'prototype-ask-user',
    readySelector: '[data-testid="ask-user-choice-card"]',
  })
    await captureDesktop(browser, {
    name: themedName('subagent-activity'),
    theme,
    height: 900,
    sessionId: 'prototype-subagents',
    readySelector: '[data-testid="sub-agent-group-agent-running"]',
    prepare: async (page) => {
      const toggle = await page.$('[data-testid="sub-agent-toggle-agent-running"]')
      if (toggle) await toggle.click()
    },
    verify: async (page) => {
      const model = await page.$eval('[data-testid="model-picker"]', (node) => node.textContent ?? '')
      if (!model.includes('GPT 5.6')) throw new Error(`prototype model label is invalid: ${model}`)
    },
  })
    await captureTablet(browser, theme)
    await captureMobile(browser, theme)
  }
} finally {
  await browser.close()
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
    await Promise.race([
      new Promise((resolveExit) => server.once('exit', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ])
  }
}

for (const capture of captures) {
  const bytes = await readFile(resolve(outputRoot, capture.name))
  capture.sha256 = createHash('sha256').update(bytes).digest('hex')
  capture.bytes = bytes.byteLength
}
await writeFile(
  resolve(outputRoot, 'manifest.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    source: 'packages/dashboard production App with prototype transport fixtures',
    privacy: 'fictional product fixture data only',
    captures,
  }, null, 2)}\n`,
  'utf8',
)

async function captureDesktop(browserInstance, input) {
  const page = await browserInstance.newPage()
  const height = input.height ?? 960
  await freezeFixtureTime(page)
  await page.setViewport({ width: 1440, height, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: input.theme ?? 'light' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ])
  await openSession(page, input.sessionId, input.readySelector)
  await input.prepare?.(page)
  await settle(page)
  if (!await page.$('[data-testid="composer-full-shell"]')) {
    throw new Error(`prototype desktop capture is not using the full Composer: ${input.name}`)
  }
  if (!await page.$('[data-testid="user-message-navigation"]')) {
    throw new Error(`prototype desktop capture is missing user message navigation: ${input.name}`)
  }
  const largestToolGroup = await page.$$eval('[data-testid^="tool-card-dots-"][aria-label$=" tool calls"]', (nodes) => Math.max(
    0,
    ...nodes.map((node) => Number.parseInt(node.getAttribute('aria-label') ?? '0', 10)),
  ))
  if (largestToolGroup < 7) {
    throw new Error(`prototype desktop capture has an incomplete tool activity summary: ${input.name} (${largestToolGroup} calls)`)
  }
  await input.verify?.(page)
  const path = resolve(outputRoot, input.name)
  const target = input.screenshotSelector ? await page.$(input.screenshotSelector) : page
  if (!target) throw new Error(`screenshot target is missing: ${input.screenshotSelector}`)
  await target.screenshot({ path, type: 'webp', quality: 88 })
  captures.push({
    name: input.name,
    theme: input.theme ?? 'light',
    viewport: { width: 1440, height },
    sessionId: input.sessionId,
    ...(input.screenshotSelector ? { crop: input.screenshotSelector } : {}),
  })
  await page.close()
}

async function captureTablet(browserInstance, theme) {
  const page = await browserInstance.newPage()
  await freezeFixtureTime(page)
  await page.setViewport({ width: 834, height: 1112, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: theme },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ])
  await openSession(page, 'prototype-subagents', '[data-testid="composer"]')
  await settle(page)
  const name = theme === 'light' ? 'tablet-session.webp' : 'tablet-session-dark.webp'
  await page.screenshot({ path: resolve(outputRoot, name), type: 'webp', quality: 88 })
  captures.push({ name, theme, viewport: { width: 834, height: 1112 }, sessionId: 'prototype-subagents' })
  await page.close()
}

async function captureMobile(browserInstance, theme) {
  const page = await browserInstance.newPage()
  await freezeFixtureTime(page)
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: theme },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ])
  await openSession(page, 'prototype-subagents', '[data-testid="composer"]')
  await settle(page)
  const mobileState = await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="composer-simple-shell"]')
    const timing = [...document.querySelectorAll(
      '[data-testid="message-timestamp"], [data-testid*="-duration-"], [data-testid$="-elapsed"]',
    )].map((node) => {
      const rect = node.getBoundingClientRect()
      return { testId: node.getAttribute('data-testid'), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }).filter((rect) => rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight)
    const overlaps = []
    for (let first = 0; first < timing.length; first += 1) {
      for (let second = first + 1; second < timing.length; second += 1) {
        const a = timing[first]
        const b = timing[second]
        if (a && b && Math.min(a.right, b.right) > Math.max(a.left, b.left)
          && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) {
          overlaps.push([a.testId, b.testId])
        }
      }
    }
    return {
      simple: Boolean(shell),
      full: Boolean(document.querySelector('[data-testid="composer-full-shell"]')),
      shellHeight: shell?.getBoundingClientRect().height ?? 0,
      overlaps,
    }
  })
  if (!mobileState.simple || mobileState.full || mobileState.shellHeight > 64 || mobileState.overlaps.length > 0) {
    throw new Error(`mobile composer acceptance failed: ${JSON.stringify(mobileState)}`)
  }
  const name = theme === 'light' ? 'mobile-session.webp' : 'mobile-session-dark.webp'
  await page.screenshot({ path: resolve(outputRoot, name), type: 'webp', quality: 88 })
  captures.push({ name, theme, viewport: { width: 390, height: 844 }, sessionId: 'prototype-subagents' })
  await page.close()
}

async function openSession(page, sessionId, selector) {
  const target = new URL(prototypeUrl)
  target.searchParams.set('sessionId', sessionId)
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForSelector(selector, { visible: true, timeout: 30_000 })
  await page.evaluate(async () => {
    await document.fonts.ready
    document.querySelectorAll('[data-sonner-toast]').forEach((node) => node.remove())
  })
}

async function freezeFixtureTime(page) {
  await page.evaluateOnNewDocument((now) => {
    Date.now = () => now
  }, fixtureNow)
}

async function settle(page) {
  const viewport = page.viewport()
  if (viewport) await page.mouse.move(2, Math.floor(viewport.height / 2))
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
    `,
  })
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  await page.evaluate(() => {
    document.querySelectorAll('[data-sonner-toast]').forEach((node) => node.remove())
  })
}

async function isReady(url) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

async function repositoryViteBin() {
  const store = resolve(repositoryRoot, 'node_modules/.pnpm')
  const entries = await readdir(store)
  const version = 'vite@6.4.3_'
  const preferred = entries.find((entry) => entry.startsWith(`${version}@types+node@22.9.0_`))
    ?? entries.find((entry) => entry.startsWith(version))
  if (!preferred) throw new Error('repository Vite 6.4.3 is not installed')
  return resolve(store, preferred, 'node_modules/vite/bin/vite.js')
}

async function waitForReady(url, child) {
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk).slice(-4_000) })
  child.stderr.on('data', (chunk) => { output += String(chunk).slice(-4_000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`prototype server exited with ${child.exitCode}\n${output}`)
    if (await isReady(url)) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  }
  throw new Error(`prototype server did not become ready\n${output}`)
}

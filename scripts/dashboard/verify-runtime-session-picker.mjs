#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'

const origin = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:13000'
const chrome = process.env.CHROME_PATH ?? '/snap/bin/chromium'
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
  ]) {
    const page = await browser.newPage()
    await page.setViewport(viewport)
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.evaluate(() => localStorage.removeItem('ak-agent-runtime'))
    await openNewSession(page, viewport.name)
    await page.waitForSelector('[data-testid="new-session-runtime-kernel"]')
    await page.waitForSelector('[data-testid="new-session-runtime-copilot"]')
    await page.waitForSelector('[data-testid="finder-column"]', { timeout: 15_000 })
    await sleep(300)

    const result = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="new-session-dialog"]')
      const finder = document.querySelector('[data-testid="directory-picker-finder"]')
      const column = document.querySelector('[data-testid="finder-column"]')
      const create = document.querySelector('[data-testid="new-session-create"]')
      const rect = (element) => {
        const value = element?.getBoundingClientRect()
        return value ? { left: value.left, right: value.right, width: value.width, height: value.height } : null
      }
      return {
        viewportWidth: window.innerWidth,
        dialog: rect(dialog),
        finder: rect(finder),
        column: rect(column),
        create: rect(create),
        folderCount: document.querySelectorAll('[data-testid="finder-dir"]').length,
      }
    })

    if (!result.dialog || !result.finder || !result.column || !result.create) {
      throw new Error(`${viewport.name}: Session picker elements are missing`)
    }
    if (result.finder.height < 120 || result.folderCount === 0) {
      throw new Error(`${viewport.name}: directory structure is not visible: ${JSON.stringify(result)}`)
    }
    for (const [name, rect] of [['finder', result.finder], ['create', result.create]]) {
      if (rect.left < -1 || rect.right > result.viewportWidth + 1) {
        throw new Error(`${viewport.name}: ${name} overflows viewport: ${JSON.stringify(result)}`)
      }
    }
    if (viewport.name === 'desktop') {
      await page.click('[data-testid="new-session-runtime-copilot"]')
      const storedRuntime = await page.evaluate(() => localStorage.getItem('ak-agent-runtime'))
      if (storedRuntime !== 'copilot') {
        throw new Error(`desktop: runtime preference was not persisted: ${storedRuntime}`)
      }
      await page.click('[data-testid="new-session-close"]')
      await page.waitForSelector('[data-testid="new-session-dialog"]', { hidden: true })
      await openNewSession(page, viewport.name)
      const remembered = await page.$eval(
        '[data-testid="new-session-runtime-copilot"]',
        (element) => element.getAttribute('aria-checked'),
      )
      if (remembered !== 'true') {
        throw new Error('desktop: persisted Copilot runtime was not restored')
      }
    }
    console.log(JSON.stringify({ viewport: viewport.name, ...result }))
    await page.close()
  }
} finally {
  await browser.close()
}

async function openNewSession(page, viewportName) {
  if (viewportName === 'mobile') {
    await page.waitForSelector('[data-testid="explorer-toggle"]')
    await page.click('[data-testid="explorer-toggle"]')
    await page.waitForSelector('[data-testid="explorer-drawer"]')
  }
  await page.waitForSelector('[data-testid^="workspace-new-session-"]', { timeout: 30_000 })
  await sleep(500)
  const opened = await page.$$eval('[data-testid^="workspace-new-session-"]', (buttons, mobile) => {
    const button = mobile
      ? buttons.find((candidate) => !candidate.disabled && candidate.offsetParent)
      : buttons.find((candidate) => !candidate.disabled)
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return Boolean(button)
  }, viewportName === 'mobile')
  if (!opened) throw new Error(`${viewportName}: no online Workspace can create a Session`)
  await page.waitForSelector('[data-testid="new-session-dialog"]')
}

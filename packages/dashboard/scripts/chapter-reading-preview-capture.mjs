import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const origin = 'http://127.0.0.1:4179'
const output = resolve(process.cwd(), '../../artifacts/chapter-reading-real')
await mkdir(output, { recursive: true })
const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] })
const errors = []
try {
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setRequestInterception(true)
  page.on('request', (request) => { if (new URL(request.url()).origin !== origin) void request.abort(); else void request.continue() })
  const requireNode = async (selector) => { await page.waitForSelector(selector, { visible: true, timeout: 35_000 }) }
  const navigateTo = async (selector) => {
    await page.$eval(selector, (node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await new Promise((resolve) => setTimeout(resolve, 180))
    // Virtuoso's retained bottom anchor can override scrollIntoView on resize or content swap.
    for (let attempt = 0; attempt < 5; attempt++) {
      const distance = await page.$eval(selector, (node) => node.getBoundingClientRect().top - innerHeight * 0.45)
      if (Math.abs(distance) < 120) break
      await page.mouse.move(190, 320)
      await page.mouse.wheel({ deltaY: distance })
      await new Promise((resolve) => setTimeout(resolve, 140))
    }
  }
  const assertChapterAtTop = async (heading) => {
    await page.waitForFunction((title) => {
      const row = document.querySelector('[data-testid="chapter-navigation"]')?.closest('[data-testid="assistant-content-column"]')
      const chapter = row?.querySelector('[data-testid="chapter-body"] h2')
      const rect = chapter?.getBoundingClientRect()
      const navigation = row?.querySelector('[data-testid="chapter-navigation"]')?.getBoundingClientRect()
      return chapter?.textContent?.includes(title) && rect && navigation
        && rect.top >= 0 && rect.top < innerHeight * 0.6 && navigation.top >= 0 && navigation.top < innerHeight * 0.6
    }, { timeout: 5000 }, heading)
  }
  const capture = async (filename) => {
    const state = await page.evaluate((filename) => ({
      width: document.documentElement.scrollWidth, viewport: innerWidth,
      inMessage: Boolean(document.querySelector('[data-testid="assistant-content-column"] [data-testid="chapter-reader"]')),
      inRealPanel: Boolean(document.querySelector('[data-testid="chat-panel"] [data-testid="virtual-transcript"]')),
      composer: Boolean(document.querySelector('[data-testid="composer"]')),
      targetRect: document.querySelector(filename.includes('contents') ? '[data-testid="chapter-toc"]' : filename.includes('end') ? '[data-testid="chapter-footer"]' : '[data-testid="chapter-navigation"]')?.getBoundingClientRect().toJSON(),
      visibleTarget: (() => {
        const selector = filename.includes('contents') ? '[data-testid="chapter-toc"]' : filename.includes('end') ? '[data-testid="chapter-footer"]' : '[data-testid="chapter-navigation"]'
        const rect = document.querySelector(selector)?.getBoundingClientRect()
        return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 && rect.left >= 0 && rect.right <= innerWidth)
      })(),
    }), filename)
    if (!state.inMessage || !state.inRealPanel || !state.composer || !state.visibleTarget || state.width > state.viewport + 1) throw Error(`Not a real Dashboard chat render: ${filename} ${JSON.stringify(state)}`)
    await page.screenshot({ path: `${output}/${filename}.png`, fullPage: false })
    console.log(`${output}/${filename}.png`)
  }
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.goto(`${origin}/?sessionId=prototype-chapters`, { waitUntil: 'domcontentloaded', timeout: 40_000 })
  for (const selector of ['[data-testid="explorer-surface"]', '[data-testid="chat-panel"]', '[data-testid="composer"]', '[data-testid="right-panel"]', '[data-testid="chapter-reader"]']) await requireNode(selector)
  await page.evaluate(async () => { await document.fonts.ready })
  await navigateTo('[data-testid="chapter-navigation"]')
  await capture('01-desktop-chapter-top')
  await page.click('[data-testid="chapter-toc-trigger"]')
  await requireNode('[data-testid="chapter-toc"]')
  await capture('02-desktop-contents')
  await page.click('[data-testid="chapter-select-1"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="chapter-body"] h2')?.textContent?.includes('将信息分成三个层次'))
  await navigateTo('[data-testid="chapter-footer"]')
  await capture('03-desktop-chapter-end')
  await page.click('[data-testid="chapter-next"]')
  await assertChapterAtTop('处理不同屏幕的边界')
  await capture('04-desktop-after-next')
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await new Promise((resolve) => setTimeout(resolve, 600)) // allow the virtual list to restore its viewport anchor after resize
  await navigateTo('[data-testid="chapter-navigation"]')
  await capture('05-mobile-chapter-top')
  await page.click('[data-testid="chapter-toc-trigger"]')
  await requireNode('[data-testid="chapter-toc"]')
  await capture('06-mobile-contents')
  await page.click('[data-testid="chapter-select-1"]')
  await navigateTo('[data-testid="chapter-footer"]')
  await capture('07-mobile-chapter-end')
  await page.click('[data-testid="chapter-next"]')
  await assertChapterAtTop('处理不同屏幕的边界')
  await capture('08-mobile-after-next')
  await page.setViewport({ width: 820, height: 1100, deviceScaleFactor: 1 })
  await navigateTo('[data-testid="chapter-navigation"]')
  await capture('09-tablet-chapter')
  await page.select('[data-testid="chapter-mode"]', 'continuous')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chapter-body"] h2').length === 4)
  await capture('10-tablet-continuous')
  if (errors.length) throw Error(`Browser runtime errors: ${errors.join(' | ')}`)
  console.log('Verified real App, real ChatPanel transcript, complete Composer, chapter interactions and viewport geometry.')
} finally { await browser.close() }

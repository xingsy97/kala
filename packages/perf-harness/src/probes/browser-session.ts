import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'

import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core'

import { resolveChromeExecutable } from '../fixtures/repo-paths.js'

/**
 * A browser session pointed at a running {@link import('../fixtures').LocalStack}.
 *
 * Deliberately uses a throwaway user-data-dir per session and disables the HTTP
 * cache. This matters: the dashboard registers a service worker, and a reused
 * profile will happily serve a *stale* bundle — which silently invalidates any
 * perf measurement. Every session here starts from a clean slate.
 */

export type BrowserSessionOptions = {
  /** Full dashboard URL to open (usually `LocalStack.dashboardUrl`). */
  url: string
  /**
   * Emulate a phone: mobile viewport + touch. When omitted a desktop viewport
   * is used.
   */
  mobile?: boolean
  /** Desktop viewport when not mobile. Defaults to 1400x900. */
  viewport?: { width: number; height: number }
  /**
   * CPU throttling multiplier (CDP `Emulation.setCPUThrottlingRate`). e.g. 6 to
   * approximate a mid-range phone on a fast dev machine. Omit for no throttle.
   */
  cpuThrottleRate?: number
  /** Extra Chrome args. */
  args?: readonly string[]
}

export type BrowserSession = {
  readonly browser: Browser
  readonly page: Page
  readonly cdp: CDPSession
  /** Wait until the composer input is present (the app is interactive). */
  waitForComposer(timeoutMs?: number): Promise<void>
  /** Type a prompt into the composer and press Enter to send it. */
  sendPrompt(text: string): Promise<void>
  /** Close the browser and clean up the throwaway profile. */
  close(): Promise<void>
}

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** Launch Chrome, open the dashboard, and return a controllable session. */
export async function openDashboard(options: BrowserSessionOptions): Promise<BrowserSession> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'ak-perf-chrome-'))
  const browser = await puppeteer.launch({
    executablePath: resolveChromeExecutable(),
    headless: true,
    userDataDir,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(options.args ?? [])],
  })
  const page = await browser.newPage()
  await page.setCacheEnabled(false)

  if (options.mobile) {
    await page.emulate({
      viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
      userAgent: MOBILE_UA,
    })
  } else {
    await page.setViewport(options.viewport ?? { width: 1400, height: 900 })
  }

  const cdp = await page.target().createCDPSession()
  if (options.cpuThrottleRate && options.cpuThrottleRate > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottleRate })
  }

  // tsx/esbuild compiles our in-page functions with `keepNames`, which injects
  // a `__name(...)` helper. That helper doesn't exist in the browser, so any
  // `page.evaluate(fn)` whose body has a named function/arrow throws
  // "__name is not defined". Define a no-op shim in every document/context so
  // probe callbacks run unchanged.
  await page.evaluateOnNewDocument(() => {
    const g = globalThis as unknown as { __name?: (fn: unknown) => unknown }
    if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn
  })

  await page.goto(options.url, { waitUntil: 'networkidle2' })

  let closed = false
  return {
    browser,
    page,
    cdp,
    async waitForComposer(timeoutMs = 20_000) {
      await page.waitForSelector('[data-testid="composer-input"], textarea', { timeout: timeoutMs })
    },
    async sendPrompt(text: string) {
      const input = (await page.$('[data-testid="composer-input"]')) ?? (await page.$('textarea'))
      if (!input) throw new Error('composer input not found')
      await input.click()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    },
    async close() {
      if (closed) return
      closed = true
      try { await browser.close() } catch { /* ignore */ }
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

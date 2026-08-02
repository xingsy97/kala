import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import puppeteer from 'puppeteer-core'

export class ProductE2EHarness {
  constructor(options = {}) {
    this.name = options.name ?? 'product-e2e'
    this.chromePath = options.chromePath ?? process.env.CHROME_PATH ?? '/snap/bin/chromium'
    this.headless = options.headless ?? true
    this.evidenceRoot = options.evidenceRoot ?? join(tmpdir(), `agent-runlab-program-${Date.now()}`)
    this.browser = null
    this.contexts = []
    this.resources = []
    this.steps = []
    this.failures = []
  }

  async start() {
    await mkdir(this.evidenceRoot, { recursive: true })
    this.browser = await puppeteer.launch({ executablePath: this.chromePath, headless: this.headless, protocolTimeout: 120_000, args: ['--no-sandbox'] })
    return this
  }

  async newActor(name, viewport = { width: 1440, height: 900 }) {
    if (!this.browser) throw new Error('harness is not started')
    const context = await this.browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport(viewport)
    page.setDefaultTimeout(60_000)
    const actor = { name, context, page, requests: [], responses: [], consoleErrors: [], pageErrors: [] }
    page.on('request', (request) => actor.requests.push({ method: request.method(), url: request.url(), navigation: request.isNavigationRequest() }))
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().includes('favicon')) actor.responses.push({ status: response.status(), url: response.url() })
    })
    page.on('console', (message) => { if (message.type() === 'error') actor.consoleErrors.push(message.text()) })
    page.on('pageerror', (error) => actor.pageErrors.push(String(error)))
    this.contexts.push(actor)
    return actor
  }

  async step(name, action, verify) {
    const startedAt = Date.now()
    try {
      const value = await action()
      const evidence = verify ? await verify(value) : value
      this.steps.push({ name, ok: true, durationMs: Date.now() - startedAt, evidence: serializable(evidence) })
      return value
    } catch (error) {
      const failure = { name, ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.stack ?? error.message : String(error) }
      this.steps.push(failure)
      this.failures.push(failure)
      throw error
    }
  }

  registerResource(kind, id, cleanup) {
    this.resources.push({ kind, id, cleanup, cleaned: false })
  }

  async screenshot(actor, name, options = {}) {
    const path = join(this.evidenceRoot, `${safeName(actor.name)}-${safeName(name)}.png`)
    await actor.page.screenshot({ path, fullPage: options.fullPage ?? false })
    return path
  }

  async finalize(extra = {}) {
    const cleanup = []
    for (const resource of [...this.resources].reverse()) {
      try {
        await resource.cleanup()
        resource.cleaned = true
        cleanup.push({ kind: resource.kind, id: resource.id, ok: true })
      } catch (error) {
        const entry = { kind: resource.kind, id: resource.id, ok: false, error: String(error) }
        cleanup.push(entry)
        this.failures.push({ name: `cleanup:${resource.kind}:${resource.id}`, ok: false, error: String(error) })
      }
    }
    const actors = this.contexts.map((actor) => ({
      name: actor.name,
      url: actor.page.url(),
      failedResponses: actor.responses,
      consoleErrors: actor.consoleErrors,
      pageErrors: actor.pageErrors,
    }))
    const report = { name: this.name, generatedAt: new Date().toISOString(), steps: this.steps, actors, cleanup, failures: this.failures, ...extra }
    const reportPath = join(this.evidenceRoot, 'report.json')
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    for (const actor of this.contexts) await actor.context.close().catch(() => {})
    await this.browser?.close().catch(() => {})
    this.browser = null
    return { report, reportPath, evidenceRoot: this.evidenceRoot }
  }

  assertClean(report) {
    const actorFailures = report.actors.flatMap((actor) => [
      ...actor.failedResponses.map((item) => `${actor.name}: HTTP ${item.status} ${item.url}`),
      ...actor.consoleErrors.map((item) => `${actor.name}: console ${item}`),
      ...actor.pageErrors.map((item) => `${actor.name}: page ${item}`),
    ])
    const failures = [...report.failures.map((item) => `${item.name}: ${item.error}`), ...actorFailures]
    if (failures.length > 0) throw new Error(`product E2E failed:\n${failures.join('\n')}`)
  }
}

export async function clickByTestId(page, testId) {
  await page.waitForSelector(`[data-testid="${testId}"]`)
  await page.$eval(`[data-testid="${testId}"]`, (element) => element.click())
}

export async function waitForText(page, text, timeout = 60_000) {
  await page.waitForFunction((expected) => document.body.innerText.includes(expected), { timeout }, text)
}

export async function loginWithPassword(page, { productOrigin, loginName, password }) {
  await page.goto(`${productOrigin}/auth/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[name=loginName]')
  // ZITADEL's login app hydrates after the input first appears and can replace
  // that node once. Wait for hydration before entering credentials.
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  await typeStableValue(page, 'input[name=loginName]', loginName)
  await submitVisibleForm(page, 'input[name=loginName]')
  await page.waitForSelector('input[name=password]')
  await typeStableValue(page, 'input[name=password]', password)
  await submitVisibleForm(page, 'input[name=password]')
  await new Promise((resolve) => setTimeout(resolve, 800))
  let effectivePassword = password
  if (page.url().includes('/password/change')) {
    effectivePassword = `${password}N2!`
    const fields = await page.$$('input[type=password]')
    if (fields.length === 0) throw new Error('password-change form has no password inputs')
    const values = fields.length >= 3 ? [password, effectivePassword, effectivePassword] : [effectivePassword, effectivePassword]
    for (let index = 0; index < Math.min(fields.length, values.length); index += 1) {
      await fields[index].type(values[index])
    }
    await page.$$eval('button', (buttons) => buttons.find((button) => !button.disabled && /continue|change|save/iu.test(button.textContent ?? ''))?.click())
  }
  await page.waitForSelector('[data-testid=app-shell-nav]')
  return effectivePassword
}

async function typeStableValue(page, selector, value) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForSelector(selector)
    await page.click(selector)
    await page.keyboard.type(value)
    if (await page.$eval(selector, (input) => input.value).catch(() => '') === value) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`input value did not stabilize: ${selector}`)
}

async function submitVisibleForm(page, selector) {
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => !button.disabled && /continue|next|sign in/iu.test(button.textContent ?? '')))
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => !candidate.disabled && /continue|next|sign in/iu.test(candidate.textContent ?? ''))
    button?.click()
    return Boolean(button)
  })
  if (!clicked) throw new Error(`missing submit button for: ${selector}`)
}

function safeName(value) { return value.replace(/[^a-zA-Z0-9_-]+/gu, '-') }
function serializable(value) {
  if (value === undefined) return null
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}

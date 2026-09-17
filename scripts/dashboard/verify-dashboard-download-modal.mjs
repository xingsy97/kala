#!/usr/bin/env node
// Read-only live Host; optional local built Dashboard interception before deployment.
// pnpm --dir packages/host exec tsx ../../scripts/dashboard/verify-dashboard-download-modal.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import { aptInstallSnippet } from '../../packages/dashboard/public/downloads/desktop/apt-snippet.js'
import { desktopInstallCommands, desktopLocalInstallCommands } from '../../packages/dashboard/public/downloads/desktop/release-data.js'

const origin = process.env.MODAL_ORIGIN ?? 'http://127.0.0.1:13000'
const root = resolve(import.meta.dirname, '../..')
const evidence = resolve(root, '.artifacts', process.env.MODAL_EVIDENCE ?? `download-modal-${Date.now()}`)
const dist = process.env.MODAL_LOCAL_DIST ? resolve(root, 'packages/dashboard/dist') : null
await mkdir(evidence, { recursive: true })
const release = JSON.parse(await readFile(resolve(root, 'packages/dashboard/public/downloads/desktop/release.json'), 'utf8'))
const fixtureApt = { schemaVersion: 1, url: 'https://packages.example.org/desktop', fingerprint: 'a'.repeat(40) }
const expectedApt = aptInstallSnippet(fixtureApt)
const expectedDeb = desktopInstallCommands(release, origin)
const steps = [], errors = [], mutations = []
const id = (value) => `[data-testid="${value}"]`
let browser, fixture = 'real', targets = 0
const result = {}
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium',
    headless: true, userDataDir: resolve(evidence, 'chrome-profile'),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  const cdp = await page.createCDPSession()
  const downloads = resolve(evidence, 'downloads')
  await mkdir(downloads, { recursive: true })
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true })
  browser.on('targetcreated', () => { targets++ })
  page.setDefaultTimeout(20_000)
  await page.setBypassServiceWorker(true)
  await page.setRequestInterception(true)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('request', async (request) => {
    const url = new URL(request.url())
    if (url.origin !== origin) return request.continue()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !url.pathname.startsWith('/socket.io/')) {
      if (['/user/session-tabs', '/push/activity'].includes(url.pathname)) return request.respond({ status: 204 })
      mutations.push(`${request.method()} ${url.pathname}`)
      return request.abort()
    }
    if (url.pathname === '/downloads/desktop/release.json' && ['missing', 'malformed', 'loading', 'network'].includes(fixture)) {
      if (fixture === 'loading') await sleep(1200)
      if (fixture === 'network') return request.abort()
      if (fixture === 'missing') return request.respond({ status: 404, body: '' })
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture === 'malformed' ? { ...release, artifact: { ...release.artifact, file: '../bad.deb' } } : release) })
    }
    if (fixture === 'html' && request.method() === 'HEAD' && url.pathname.endsWith('.deb')) return request.respond({ status: 200, contentType: 'text/html', body: '' })
    if (fixture === 'missing-file' && request.method() === 'HEAD' && url.pathname.endsWith('.dependencies.json')) return request.respond({ status: 404, body: '' })
    if (url.pathname === '/downloads/desktop/apt-install.json' && ['apt-valid', 'apt-invalid'].includes(fixture)) {
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture === 'apt-valid' ? fixtureApt : { ...fixtureApt, fingerprint: 'bad' }) })
    }
    if (dist && (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/downloads/desktop/'))) {
      const path = resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`)
      assert(path.startsWith(`${dist}/`))
      try {
        const bytes = await readFile(path)
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain' }[extname(path)] ?? 'application/octet-stream'
        return request.respond({ status: 200, contentType: type, body: request.method() === 'HEAD' ? '' : bytes })
      } catch { return request.respond({ status: 404, body: '' }) }
    }
    return request.continue()
  })
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('i18nextLng', 'en'); localStorage.setItem('ak-explorer-open', 'true'); localStorage.setItem('ak-theme', 'system')
    if (!sessionStorage.getItem('ak-download-test')) {
      localStorage.setItem('ak-dashboard-language', 'en')
      sessionStorage.setItem('ak-download-test', 'true')
    }
    window.__modalCopied = null
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__modalCopied = text } } })
  })
  const step = async (name, fn) => { await fn(); steps.push(name); console.log(`PASS ${name}`) }
  const open = async () => {
    await page.click(id('app-shell-download-desktop'))
    await page.waitForSelector(id('desktop-download-dialog'), { visible: true })
  }
  const ready = async () => {
    await page.waitForSelector(id('desktop-download-deb'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-download-dialog"]')?.textContent.includes('Checking approved APT'))
    await sleep(180)
  }
  const close = async (method = 'escape') => {
    if (method === 'escape') await page.keyboard.press('Escape')
    else if (method === 'outside') await page.mouse.click(3, 3)
    else await page.click('[aria-label="Close desktop downloads"]')
    await page.waitForSelector(id('desktop-download-dialog'), { hidden: true })
    await page.waitForFunction(() => !document.querySelector('[data-testid="dialog-overlay"]'))
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'app-shell-download-desktop')
  }
  const bounds = async () => {
    const rect = await page.$eval(id('desktop-download-dialog'), (element) => {
      const r = element.getBoundingClientRect(), body = element.querySelector('[data-testid="desktop-download-body"]')
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, overflow: getComputedStyle(body).overflowY, bodyHeight: body.clientHeight, bodyScroll: body.scrollHeight, background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, pageOverflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert(rect.left >= -1 && rect.right <= rect.width + 1 && rect.top >= -1 && rect.bottom <= rect.height + 1, JSON.stringify(rect))
    assert.equal(rect.overflow, 'auto')
    assert.equal(rect.pageOverflow, false)
    return rect
  }
  let session
  await step('open modal follows live window resizing without remounting or losing copy access', async () => {
    await page.setViewport({ width: 1440, height: 1000 })
    await page.goto(origin, { waitUntil: 'networkidle2' })
    await page.waitForSelector(id('composer-input'), { visible: true })
    const route = page.url()
    await open(); await ready()
    await page.evaluate(() => { window.__resizingModal = document.querySelector('[data-testid="desktop-download-dialog"]') })
    const measurements = []
    for (const [width, height] of [[1440, 1000], [1024, 700], [800, 600], [640, 360], [390, 844], [844, 390], [320, 480], [1440, 1000]]) {
      await page.setViewport({ width, height })
      await sleep(200)
      assert(await page.evaluate(() => window.__resizingModal === document.querySelector('[data-testid="desktop-download-dialog"]')))
      assert.equal(page.url(), route)
      const rect = await bounds()
      const size = await page.$eval(id('desktop-download-dialog'), (element) => {
        const rect = element.getBoundingClientRect()
        return { width: rect.width, height: rect.height, rem: parseFloat(getComputedStyle(document.documentElement).fontSize), overflow: element.scrollWidth > element.clientWidth }
      })
      assert.equal(size.overflow, false)
      assert(size.width >= Math.min(width - 2 * size.rem - 2, 1000), `Dialog does not use available width: ${JSON.stringify(size)}`)
      assert(size.height >= Math.min(height - 2 * size.rem - 2, 870), `Dialog does not use available height: ${JSON.stringify(size)}`)
      await page.click(id('copy-desktop-command'))
      assert.equal(await page.evaluate(() => window.__modalCopied), expectedDeb)
      if (width === 1440 && height === 1000) {
        await writeFile(resolve(evidence, 'copied-install.sh'), await page.evaluate(() => window.__modalCopied), { mode: 0o600 })
      }
      const closeRect = await page.$eval('[aria-label="Close desktop downloads"]', (element) => element.getBoundingClientRect().toJSON())
      assert(closeRect.top >= 0 && closeRect.bottom <= height, 'Close action must remain in viewport')
      measurements.push({ viewportWidth: width, viewportHeight: height, ...size, bodyHeight: rect.bodyHeight })
      await page.screenshot({ path: resolve(evidence, `resize-${width}-${height}.png`) })
    }
    assert(measurements[0].width > measurements[2].width + 150)
    assert(measurements[0].height > measurements[2].height + 250)
    result.resize = measurements
    await close()
  })
  await page.setViewport({ width: 1600, height: 1000 })
  await page.waitForSelector(id('session-row'))
  session = await page.$$eval('[data-testid="session-row"]', (rows) => rows.find((row) => row.getAttribute('data-session-id'))?.getAttribute('data-session-id'))
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000, isMobile: width === 390, hasTouch: width === 390 })
    await page.goto(origin, { waitUntil: 'networkidle2' })
    await page.waitForSelector(id('composer-input'), { visible: true })
    session ??= await page.$$eval('[data-testid="session-row"]', (rows) => rows.find((row) => row.getAttribute('data-session-id'))?.getAttribute('data-session-id'))
    assert(session, 'A real existing session must be available for preservation verification')
    await page.goto(`${origin}/?sessionId=${encodeURIComponent(session)}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(id('composer-input'), { visible: true })
    const route = page.url()
    const draft = `Unsent download modal verification ${width}`
    await page.click(id('composer-input'))
    await page.keyboard.down('Control')
    await page.keyboard.press('A')
    await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await page.type(id('composer-input'), draft)
    await page.evaluate(() => { window.__modalComposer = document.querySelector('[data-testid="composer-input"]') })
    const initialTargets = targets
    await step(`${width}px real session and unsent draft preserved; no route navigation or tabs`, async () => {
      await open(); await ready()
      assert.equal(page.url(), route)
      assert.equal(targets, initialTargets)
      assert.equal(await page.$eval(id('app-shell-download-desktop'), (element) => element.tagName), 'BUTTON')
      assert.equal(await page.$eval(id('desktop-download-dialog'), (element) => element.querySelectorAll('a[target]').length), 0)
      const text = await page.$eval(id('desktop-download-dialog'), (element) => element.textContent)
      for (const value of [release.version, 'Unsigned', 'RUSTSEC-2024-0429', 'not publisher signatures', 'does not enable automatic updates', 'Unavailable — a production signed APT']) assert(text.includes(value), value)
      assert.equal(await page.$('[role="tooltip"]'), null)
      await page.click(id('copy-desktop-command'))
      assert.equal(await page.evaluate(() => window.__modalCopied), expectedDeb)
      assert(!expectedDeb.includes('apt remove'))
      await close()
      assert.equal(page.url(), route)
      assert.equal(await page.$eval(id('composer-input'), (element) => element.value), draft)
      assert(await page.evaluate(() => window.__modalComposer === document.querySelector('[data-testid="composer-input"]')))
      await open(); await ready(); await close('outside')
      assert.equal(page.url(), route)
      assert.equal(targets, initialTargets)
      assert.equal(await page.$eval(id('composer-input'), (element) => element.value), draft)
    })
    await step(`${width}px native themed scroll bounds and help`, async () => {
      const colors = []
      for (const theme of ['light', 'dark']) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
        await page.waitForFunction((value) => document.documentElement.classList.contains('dark') === (value === 'dark'), {}, theme)
        await open(); await ready()
        await page.$$eval(`${id('desktop-download-dialog')} details`, (elements) => { for (const element of elements) element.open = true })
        result[`${width}-${theme}`] = await bounds()
        colors.push(result[`${width}-${theme}`].background)
        await page.screenshot({ path: resolve(evidence, `${width}-${theme}.png`) })
        await close('button')
      }
      assert.notEqual(colors[0], colors[1], 'Dialog should inherit light/dark theme')
      await open(); await ready()
      await page.click('[aria-label="About Connect securely"]')
      await page.waitForSelector('[role="tooltip"]', { visible: true })
      assert((await page.$eval('[role="tooltip"]', (element) => element.textContent)).includes('Workspace paths and terminals stay on the remote Runtime'))
      await page.keyboard.press('Escape')
      await page.waitForSelector('[role="tooltip"]', { hidden: true })
      assert(await page.$(id('desktop-download-dialog')))
      await close()
    })
  }
  await step('real download links yield package, dependency manifest and matching checksums', async () => {
    await open(); await ready()
    for (const [file, selector, expected] of [
      [release.artifact.file, id('desktop-download-deb'), release.artifact.sha256],
      [release.dependencies.file, `a[href="/downloads/desktop/${release.dependencies.file}"]`, release.dependencies.sha256],
      [release.checksums.file, `a[href="/downloads/desktop/${release.checksums.file}"]`, release.checksums.sha256],
    ]) {
      await page.click(selector)
      let bytes
      for (let i = 0; i < 100; i++) {
        try { bytes = await readFile(resolve(downloads, file)); break } catch { await sleep(100) }
      }
      assert(bytes, `Download absent: ${file}`)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
    }
    const sums = await readFile(resolve(downloads, release.checksums.file), 'utf8')
    assert(sums.includes(`${release.artifact.sha256}  ${release.artifact.file}`))
    assert(sums.includes(`${release.dependencies.sha256}  ${release.dependencies.file}`))
    result.downloadSha256 = release.artifact.sha256
    await close()
  })
  await step('downloaded-package flow copies a sandbox-safe local installer', async () => {
    await open(); await ready()
    await page.click('[data-testid="desktop-local-install"] summary')
    await page.click(id('copy-desktop-local-command'))
    const local = await page.evaluate(() => window.__modalCopied)
    assert.equal(local, desktopLocalInstallCommands(release))
    await writeFile(resolve(evidence, 'copied-local-install.sh'), local, { mode: 0o600 })
    await close()
  })
  await step('loading and release error fixtures disable downloads', async () => {
    fixture = 'loading'
    await open()
    await page.waitForFunction(() => document.querySelector('[data-testid="desktop-download-dialog"]')?.textContent.includes('Checking this deployment'))
    assert.equal(await page.$(id('desktop-download-deb')), null)
    assert(await page.$eval(id('desktop-download-dialog'), (element) => [...element.querySelectorAll('button')].some((button) => button.disabled && button.textContent.includes('Download Linux'))))
    await ready(); await close()
    for (fixture of ['missing', 'malformed', 'network', 'html', 'missing-file']) {
      await open()
      await page.waitForSelector(`${id('desktop-download-dialog')} [role="alert"]`)
      assert.equal(await page.$(id('desktop-download-deb')), null)
      assert.equal(await page.$eval(id('desktop-download-dialog'), (element) => element.querySelectorAll('a[download]').length), 0)
      await close()
    }
  })
  await step('approved APT fixture copies entire shared validated block; invalid config fails closed', async () => {
    fixture = 'apt-valid'
    await page.evaluate(() => {
      window.__modalCopied = null
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__modalCopied = text } } })
    })
    await open(); await ready()
    await page.click(id('copy-desktop-apt-command'))
    await page.waitForFunction(() => window.__modalCopied !== null)
    assert.equal(await page.evaluate(() => window.__modalCopied), expectedApt)
    assert.equal(await page.$eval('[aria-label="One-paste APT install"] pre', (element) => element.textContent), expectedApt)
    await bounds()
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Controlled clipboard denial') } })
    await page.click(id('copy-desktop-apt-command'))
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('Copy unavailable'))
    await close()
    fixture = 'apt-invalid'
    await open(); await ready()
    assert((await page.$eval('[role="alert"]', (element) => element.textContent)).includes('approved HTTPS URL'))
    assert.equal(await page.$(id('copy-desktop-apt-command')), null)
    await close()
    fixture = 'real'
  })
  await step('backwards-compatible standalone page uses the same actual release and commands', async () => {
    await page.goto(`${origin}/downloads/desktop/index.html`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('#available', { visible: true })
    assert.equal(await page.$eval('#deb', (element) => new URL(element.href).pathname), `/downloads/desktop/${release.artifact.file}`)
    assert((await page.$eval('#commands', (element) => element.textContent)).includes(`${release.artifact.sha256}  ${release.artifact.file}`))
    await page.$eval('#deb-copy', (element) => element.scrollIntoView({ block: 'center' }))
    await sleep(200)
    await page.click('#deb-copy')
    assert.equal(await page.evaluate(() => window.__modalCopied), expectedDeb)
  })
  await step('Chinese desktop/mobile localize warnings, hidden command help and copy feedback', async () => {
    await page.evaluate(() => localStorage.setItem('ak-dashboard-language', 'zh'))
    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000, isMobile: width === 390, hasTouch: width === 390 })
      await page.goto(`${origin}/?sessionId=${encodeURIComponent(session)}`, { waitUntil: 'networkidle2' })
      await page.waitForSelector(id('composer-input'), { visible: true })
      await open(); await ready()
      await page.waitForFunction(() => document.querySelector('[data-testid="desktop-download-dialog"]')?.textContent.includes('尚未配置生产环境签名 APT'))
      const text = await page.$eval(id('desktop-download-dialog'), (element) => element.textContent)
      assert(text.includes('未签名的候选版本'))
      assert(text.includes('下载并安装 .deb'))
      assert(!text.includes('浏览器不能安装软件包'))
      await page.click(id('copy-desktop-command'))
      assert.equal(await page.evaluate(() => window.__modalCopied), expectedDeb)
      assert((await page.$eval(id('copy-desktop-command'), (element) => element.textContent)).includes('已复制'))
      result[`${width}-zh`] = await bounds()
      await page.screenshot({ path: resolve(evidence, `${width}-zh.png`) })
      await page.click('section[aria-label="下载并安装 .deb"] button[aria-expanded]')
      await page.waitForSelector('[role="tooltip"]', { visible: true })
      assert((await page.$eval('[role="tooltip"]', (element) => element.textContent)).includes('浏览器不能安装软件包'))
      await page.keyboard.press('Escape')
      await page.waitForSelector('[role="tooltip"]', { hidden: true })
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Controlled denial') } })
      await page.click(id('copy-desktop-command'))
      await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('无法复制'))
      await close()
    }
  })
  result.session = session
  assert.deepEqual(errors, [])
  assert.deepEqual(mutations, [])
  result.ok = true
} catch (error) {
  result.error = String(error.stack ?? error)
  console.error(result.error)
  const failedPage = (await browser?.pages())?.at(-1)
  if (failedPage) {
    await failedPage.screenshot({ path: resolve(evidence, 'failure.png') })
    result.failureLayout = await failedPage.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight, visual: visualViewport?.height, scroll: scrollY },
      button: document.querySelector('#deb-copy')?.getBoundingClientRect().toJSON(),
      overflow: { html: getComputedStyle(document.documentElement).overflow, body: getComputedStyle(document.body).overflow },
    }))
  }
  process.exitCode = 1
} finally {
  await browser?.close()
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ ...result, origin, localDist: dist, steps, errors, mutations, targets }, null, 2))
}

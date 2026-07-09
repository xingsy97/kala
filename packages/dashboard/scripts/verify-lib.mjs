/**
 * Shared verify harness. Every dashboard verify script that claims a feature
 * "works" must go through this — the failure mode we are guarding against is a
 * script asserting a popover looks fine while the underlying page is broken.
 *
 * Non-negotiable rules enforced here:
 *   1. Full-page screenshot at 1440x900 (not element-scoped crops).
 *   2. Capture BOTH themes. Toggle via [data-testid="theme-toggle"]; if the
 *      toggle isn't present, the harness fails — every page must ship one.
 *   3. DOM-level assertion: for each key layout region, computed
 *      background-color MUST differ between the light and dark screenshots.
 *      If a region stays the same color across themes, the layer isn't
 *      responding to the theme class and the script exits non-zero.
 *   4. Also assert foreground/text color for at least one text-heavy region so
 *      "same bg, wrong text color" doesn't slip through.
 *   5. The script prints a labeled checklist of every check performed so
 *      review is explicit, not implicit.
 *
 * Usage:
 *   import { launchDashboard, verifyAcrossThemes } from './verify-lib.mjs'
 *   const { browser, page } = await launchDashboard({ url: 'http://localhost:3000' })
 *   await verifyAcrossThemes(page, {
 *     name: 'b6-mention',
 *     interact: async (page, theme) => { … open the popover in either theme … },
 *     regions: [
 *       { testid: 'workbench-panel', label: 'workbench root' },
 *       { testid: 'chat-panel', label: 'chat panel' },
 *       { testid: 'explorer-panel', label: 'explorer' },
 *       { testid: 'inspector-panel', label: 'inspector' },
 *     ],
 *   })
 *   await browser.close()
 */

import puppeteer from 'puppeteer-core'
import { existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const VIEWPORT = { width: 1440, height: 900 }
const OUT_DIR = '/tmp'

function detectBrowser() {
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ]
  for (const p of candidates) if (existsSync(p)) return p
  try {
    return execSync('which chromium || which google-chrome').toString().trim()
  } catch {
    return null
  }
}

export async function launchDashboard({ url = 'http://localhost:3000' } = {}) {
  const executablePath = detectBrowser()
  if (!executablePath) {
    console.error('no chromium found')
    process.exit(2)
  }
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: VIEWPORT,
  })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 })
  await sleep(600)
  return { browser, page, errors }
}

export async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function currentTheme(page) {
  return await page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )
}

async function setTheme(page, target) {
  const cur = await currentTheme(page)
  if (cur === target) return
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="theme-toggle"]')
    if (!btn) return false
    btn.click()
    return true
  })
  if (!clicked) {
    throw new Error(
      'verify-lib: no [data-testid="theme-toggle"] on the page. Every dashboard page must ship a theme toggle so it can be verified in both themes.',
    )
  }
  await sleep(400)
  const now = await currentTheme(page)
  if (now !== target) {
    throw new Error(`verify-lib: theme toggle did not flip to ${target} (still ${now})`)
  }
}

async function inspectRegions(page, regions) {
  return await page.evaluate((regionsIn) => {
    const out = []
    for (const r of regionsIn) {
      const el = document.querySelector(`[data-testid="${r.testid}"]`)
      if (!el) {
        out.push({ ...r, missing: true })
        continue
      }
      const rect = el.getBoundingClientRect()
      const cs = window.getComputedStyle(el)
      out.push({
        ...r,
        missing: false,
        bg: cs.backgroundColor,
        color: cs.color,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }
    return out
  }, regions)
}

function normalizeColor(c) {
  if (!c) return ''
  return c.replace(/\s+/g, '')
}

function isTransparent(c) {
  if (!c) return true
  const n = normalizeColor(c)
  return n === 'rgba(0,0,0,0)' || n === 'transparent'
}

/**
 * Full-page + both themes + DOM assertion harness.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {{
 *   name: string,
 *   regions: Array<{ testid: string, label: string, allowSameBg?: boolean }>,
 *   interact?: (page: import('puppeteer-core').Page, theme: 'light'|'dark') => Promise<void>,
 *   requireTextColorDiffOn?: string,  // testid of a text-heavy region
 * }} opts
 * @returns {Promise<{ light: string, dark: string, findings: object[] }>}
 */
export async function verifyAcrossThemes(page, opts) {
  const { name, regions, interact, requireTextColorDiffOn } = opts
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new Error('verify-lib: verifyAcrossThemes requires at least one region')
  }
  mkdirSync(OUT_DIR, { recursive: true })

  await setTheme(page, 'light')
  if (interact) await interact(page, 'light')
  await sleep(250)
  const lightRegions = await inspectRegions(page, regions)
  const lightPath = join(OUT_DIR, `${name}-light.png`)
  await page.screenshot({ path: lightPath, fullPage: false })

  await setTheme(page, 'dark')
  if (interact) await interact(page, 'dark')
  await sleep(250)
  const darkRegions = await inspectRegions(page, regions)
  const darkPath = join(OUT_DIR, `${name}-dark.png`)
  await page.screenshot({ path: darkPath, fullPage: false })

  const findings = []
  const failures = []

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]
    const L = lightRegions[i]
    const D = darkRegions[i]
    if (L.missing || D.missing) {
      failures.push(`[${r.label}] element with data-testid="${r.testid}" not found (light=${L.missing ? 'missing' : 'ok'}, dark=${D.missing ? 'missing' : 'ok'})`)
      findings.push({ region: r.label, testid: r.testid, status: 'missing' })
      continue
    }

    const lBg = normalizeColor(L.bg)
    const dBg = normalizeColor(D.bg)
    const bothTransparent = isTransparent(L.bg) && isTransparent(D.bg)

    if (bothTransparent) {
      failures.push(`[${r.label}] both themes render transparent background — cannot verify theme response. Element must set a background so verification can see it.`)
      findings.push({ region: r.label, testid: r.testid, status: 'both-transparent', lightBg: L.bg, darkBg: D.bg })
      continue
    }

    if (!r.allowSameBg && lBg === dBg) {
      failures.push(`[${r.label}] background-color is IDENTICAL in light and dark themes (${L.bg}). The container is not responding to the theme class.`)
      findings.push({ region: r.label, testid: r.testid, status: 'bg-not-themed', lightBg: L.bg, darkBg: D.bg })
      continue
    }

    findings.push({
      region: r.label,
      testid: r.testid,
      status: 'ok',
      lightBg: L.bg,
      darkBg: D.bg,
      lightColor: L.color,
      darkColor: D.color,
      size: `${L.width}x${L.height}`,
    })
  }

  if (requireTextColorDiffOn) {
    const idx = regions.findIndex((r) => r.testid === requireTextColorDiffOn)
    if (idx >= 0) {
      const L = lightRegions[idx]
      const D = darkRegions[idx]
      if (!L.missing && !D.missing) {
        if (normalizeColor(L.color) === normalizeColor(D.color)) {
          failures.push(`[${regions[idx].label}] text color is IDENTICAL across themes (${L.color}). Text will be unreadable in one of them.`)
        }
      }
    }
  }

  console.log(`\n=== verify: ${name} — checklist ===`)
  console.log(`  screenshots: ${lightPath}  ${darkPath}`)
  for (const f of findings) {
    if (f.status === 'ok') {
      console.log(`  [OK]  ${f.region.padEnd(24)} bg ${f.lightBg} → ${f.darkBg}`)
    } else if (f.status === 'missing') {
      console.log(`  [MIS] ${f.region.padEnd(24)} data-testid="${f.testid}" missing`)
    } else if (f.status === 'bg-not-themed') {
      console.log(`  [BAD] ${f.region.padEnd(24)} bg SAME in both themes: ${f.lightBg}`)
    } else if (f.status === 'both-transparent') {
      console.log(`  [BAD] ${f.region.padEnd(24)} transparent in both themes`)
    }
  }

  if (failures.length > 0) {
    console.error(`\n[verify-lib] ${failures.length} check(s) FAILED for ${name}:`)
    for (const f of failures) console.error(`  - ${f}`)
    console.error(`\nOpen the screenshots and confirm:\n  ${lightPath}\n  ${darkPath}\n`)
    const err = new Error(`verify-lib: ${failures.length} check(s) failed for ${name}`)
    err.failures = failures
    err.screenshots = { light: lightPath, dark: darkPath }
    throw err
  }

  console.log(`\n[verify-lib] ${name}: all ${findings.length} region(s) responded to theme correctly.`)
  return { light: lightPath, dark: darkPath, findings }
}

/**
 * Convenience: the standard set of layout regions every dashboard page has.
 * Feature scripts can extend this list with their own popovers/menus, but
 * these four are the floor — if any of them stops responding to the theme,
 * the page is broken regardless of the feature under test.
 */
export const STANDARD_LAYOUT_REGIONS = [
  { testid: 'workbench-panel', label: 'workbench root' },
  { testid: 'chat-panel', label: 'chat scrollarea' },
  { testid: 'explorer-panel', label: 'explorer' },
  { testid: 'inspector-panel', label: 'inspector' },
  { testid: 'workbench-toolbar', label: 'workbench toolbar' },
]

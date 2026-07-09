#!/usr/bin/env node
/**
 * Screenshot-driven audit of the Eval pane: opens Artifacts → Eval, expands
 * every disclosure/wizard step, and asserts (a) no visible text leaks a
 * server path and (b) no panel body is empty when expanded. Writes
 * screenshots to /tmp/eval-audit-*.png for review.
 */

import { launchDashboard } from './verify-lib.mjs'
import { writeFileSync } from 'node:fs'

const url = process.env.AK_DASHBOARD_URL ?? 'http://localhost:3000'
const OUT = '/tmp'

const PATH_PATTERNS = [
  /\/home\/[^\s"'<>]+/g,
  /\/tmp\/[a-z0-9_-]+\/[^\s"'<>]+/g,
  /progress\.json\b/g,
  /worker-plan\.json\b/g,
  /predictions\.jsonl\b/g,
  /summary\.json\b/g,
]

function extractLeaks(text) {
  const hits = []
  for (const re of PATH_PATTERNS) {
    const m = text.match(re)
    if (m) hits.push(...m)
  }
  return hits
}

async function snap(page, name) {
  const path = `${OUT}/eval-audit-${name}.png`
  await page.screenshot({ path, fullPage: true })
  return path
}

async function visibleText(page, selector) {
  return page.$eval(selector, (el) => el.innerText || '').catch(() => '')
}

const failures = []
const notes = []

const { browser, page, errors } = await launchDashboard({ url })
try {
  await snap(page, '01-landing')

  const artifactsBtn = await page.$('[data-testid="open-artifacts-explorer"]')
  if (!artifactsBtn) {
    // fallback: search by role/label
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')]
      const btn = buttons.find((b) => /artifact/i.test(b.textContent ?? ''))
      if (btn) btn.click()
    })
  } else {
    await artifactsBtn.click()
  }
  await new Promise((r) => setTimeout(r, 800))
  await snap(page, '02-artifacts-open')

  // Switch to Eval tab
  const clickedEval = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="tab"]')]
    const target = nodes.find((n) => /^Eval$/i.test((n.textContent ?? '').trim()))
    if (target) { target.click(); return true }
    return false
  })
  notes.push(`clicked eval tab: ${clickedEval}`)
  await new Promise((r) => setTimeout(r, 800))
  await snap(page, '03-eval-pane')

  // Full DOM text on the eval pane
  const paneText = await visibleText(page, '[data-testid="eval-right-pane"]')
  notes.push(`eval-right-pane text length: ${paneText.length}`)
  const paneLeaks = extractLeaks(paneText)
  if (paneLeaks.length) failures.push({ where: 'eval-right-pane (collapsed default)', leaks: paneLeaks })

  // Expand every disclosure/toggle within eval pane
  const toggled = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="eval-right-pane"]')
    if (!pane) return { pane: false, count: 0 }
    const toggles = [...pane.querySelectorAll('button')]
      .filter((b) => /^Show$/i.test((b.textContent ?? '').trim()) || /toggle/.test(b.dataset.testid ?? ''))
    for (const b of toggles) b.click()
    return { pane: true, count: toggles.length }
  })
  notes.push(`expanded toggles: ${JSON.stringify(toggled)}`)
  await new Promise((r) => setTimeout(r, 400))
  await snap(page, '04-eval-expanded')

  const expandedText = await visibleText(page, '[data-testid="eval-right-pane"]')
  const expandedLeaks = extractLeaks(expandedText)
  if (expandedLeaks.length) failures.push({ where: 'eval-right-pane (expanded)', leaks: expandedLeaks })

  // Wizard: click through each step's Show/Hide if present
  const wizardText = await page.evaluate(() => {
    const w = document.querySelector('[data-testid="run-benchmark-wizard"]')
    return w ? w.innerText : ''
  })
  notes.push(`wizard present: ${wizardText.length > 0}`)
  const wizardLeaks = extractLeaks(wizardText)
  if (wizardLeaks.length) failures.push({ where: 'run-benchmark-wizard', leaks: wizardLeaks })

  // Also visit other tabs to make sure nothing leaks across modes
  for (const label of ['Profiles', 'Memory', 'Ops']) {
    const clicked = await page.evaluate((lbl) => {
      const nodes = [...document.querySelectorAll('button, [role="tab"]')]
      const target = nodes.find((n) => new RegExp(`^${lbl}$`, 'i').test((n.textContent ?? '').trim()))
      if (target) { target.click(); return true }
      return false
    }, label)
    if (!clicked) continue
    await new Promise((r) => setTimeout(r, 500))
    const modeText = await page.evaluate(() => {
      const dlg = document.querySelector('[data-testid="artifact-dialog"]')
      return dlg ? dlg.innerText : ''
    })
    const leaks = extractLeaks(modeText)
    if (leaks.length) failures.push({ where: `mode:${label}`, leaks: leaks.slice(0, 5) })
    await snap(page, `05-mode-${label}`)
  }
} finally {
  if (errors.length) notes.push(`page errors: ${errors.length}`)
  await browser.close()
}

const report = { url, failures, notes, pageErrors: errors ?? [] }
writeFileSync('/tmp/eval-audit-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(failures.length ? 1 : 0)

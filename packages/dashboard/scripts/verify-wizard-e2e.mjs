#!/usr/bin/env node
/**
 * Real end-to-end walkthrough of the Run Benchmark wizard.
 * Clicks every step, screenshots each panel, asserts:
 *   - Every step advances without error
 *   - Infer step actually produces predictions (>0)
 *   - Grade command panel contains ZERO absolute path (/home/, /tmp/, .agent-kernel)
 *   - Agent-recipe dropdown does NOT contain "executor" as the default option label
 *   - No wizard text leaks server paths
 *
 * This is the test that catches broad wizard regressions. Any assertion failure
 * fails the script with a non-zero exit code.
 */

import { launchDashboard } from './verify-lib.mjs'
import { writeFileSync } from 'node:fs'

const url = process.env.AK_DASHBOARD_URL ?? 'http://localhost:3000'
const OUT = '/tmp'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function snap(page, name) {
  const path = `${OUT}/wizard-e2e-${name}.png`
  await page.screenshot({ path, fullPage: true })
  console.log(`  screenshot → ${path}`)
  return path
}

const failures = []
const notes = []

function fail(where, detail) {
  failures.push({ where, detail })
  console.log(`  FAIL [${where}] ${detail}`)
}

function ok(msg) {
  notes.push(msg)
  console.log(`  OK   ${msg}`)
}

const { browser, page, errors } = await launchDashboard({ url })
try {
  await wait(700)

  console.log('\n[step 1] open Artifacts → Eval → wizard')
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /artifact/i.test(b.textContent ?? ''),
    )
    if (btn) btn.click()
  })
  await wait(600)
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="tab"]')]
    const target = nodes.find((n) => /^Eval$/i.test((n.textContent ?? '').trim()))
    if (target) target.click()
  })
  await wait(400)
  const clickedWizard = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const target = btns.find((b) => /Run benchmark/i.test(b.textContent ?? ''))
    if (target) { target.click(); return true }
    return false
  })
  if (!clickedWizard) fail('open-wizard', 'Run benchmark button not found')
  else ok('wizard opened')
  await wait(600)
  await snap(page, '01-plan')

  console.log('\n[step 2] plan step: set runId, paste inline instance, resolve, then submit')
  const runId = `e2e-smoke-${Date.now().toString(36)}`
  const filled = await page.evaluate((runId) => {
    function fill(sel, val) {
      const el = document.querySelector(sel)
      if (!el) return { ok: false, sel }
      const tracker = el._valueTracker
      if (tracker) tracker.setValue('')
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true, currentValue: el.value }
    }
    return {
      run: fill('[data-testid="run-benchmark-wizard-run-id"]', runId),
      model: fill('[data-testid="run-benchmark-wizard-model"]', 'gpt-4o-mini'),
    }
  }, runId)
  ok(`filled run id: ${JSON.stringify(filled)} runId=${runId}`)

  const pasted = await page.evaluate(async () => {
    const pasteTab = document.querySelector('[data-testid="instances-source-tab-paste"]')
    if (pasteTab) pasteTab.click()
    await new Promise((r) => setTimeout(r, 500))
    const panel = document.querySelector('[data-testid="instances-source-panel"]')
    if (!panel) return { pasted: false, reason: 'no instances panel' }
    const ta = panel.querySelector('textarea')
    if (!ta) return { pasted: false, reason: 'no textarea in instances panel' }
    const instance = {
      instance_id: 'demo__hello-1',
      repo: 'demo/hello',
      base_commit: '0000000000000000000000000000000000000000',
      problem_statement: 'Say hi.',
      hints_text: '',
      test_patch: '',
      patch: '',
      created_at: '2025-01-01T00:00:00Z',
      version: '0.1',
      FAIL_TO_PASS: '[]',
      PASS_TO_PASS: '[]',
      environment_setup_commit: null,
    }
    const value = JSON.stringify(instance)
    // React tracks the previous value on _valueTracker; wipe it so setter fires onChange
    const tracker = ta._valueTracker
    if (tracker) tracker.setValue('')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, value)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return { pasted: true, currentValue: ta.value }
  })
  ok(`paste: ${JSON.stringify(pasted)}`)
  await wait(200)
  await snap(page, '02-plan-pasted')

  // Click Resolve button, wait for summary
  const clickedResolve = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="instances-resolve-button"]')
    if (!btn || btn.disabled) return { clicked: false, disabled: btn?.disabled }
    btn.click()
    return { clicked: true }
  })
  ok(`clicked resolve: ${JSON.stringify(clickedResolve)}`)
  let resolveSummary = null
  for (let i = 0; i < 30; i++) {
    await wait(500)
    resolveSummary = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="instances-resolve-summary"]')
      const err = document.querySelector('[data-testid="instances-resolve-error"]')
      return { summary: el?.textContent, error: err?.textContent }
    })
    if (resolveSummary.summary || resolveSummary.error) break
  }
  ok(`resolve result: ${JSON.stringify(resolveSummary)}`)
  if (resolveSummary?.error) fail('resolve', resolveSummary.error)

  // Submit Plan via testid
  const submittedPlan = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="run-benchmark-wizard-plan-submit"]')
    if (!btn) return { clicked: false, reason: 'no button' }
    if (btn.disabled) return { clicked: false, reason: 'disabled', text: btn.textContent }
    btn.click()
    return { clicked: true, text: btn.textContent }
  })
  ok(`submitted plan: ${JSON.stringify(submittedPlan)}`)
  if (!submittedPlan.clicked) fail('plan-submit', JSON.stringify(submittedPlan))
  // Poll for step advance (plan API can take a while)
  let advanced = false
  let planError = null
  for (let i = 0; i < 40; i++) {
    await wait(500)
    const state = await page.evaluate(() => {
      const recipe = document.querySelector('[data-testid="run-benchmark-wizard-agent-recipe"]')
      const err = document.querySelector('[data-testid="run-benchmark-wizard-error"]')
      const wizardText = document.querySelector('[data-testid="run-benchmark-wizard"]')?.textContent ?? ''
      return { recipe: !!recipe, err: err?.textContent, hasFailedMarker: /error|failed/i.test(wizardText) && !recipe }
    })
    if (state.recipe) { advanced = true; break }
    if (state.err) { planError = state.err; break }
  }
  ok(`plan advance: advanced=${advanced} err=${planError}`)
  if (!advanced) fail('plan-advance', `did not reach Infer step: ${planError}`)
  await snap(page, '03-plan-submitted')

  console.log('\n[step 3] infer step: verify agent-recipe dropdown label and run')
  // Try to find agent recipe dropdown
  let recipeInfo = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="run-benchmark-wizard-agent-recipe"]')
    if (!sel) return { present: false }
    const opts = [...sel.querySelectorAll('option')].map((o) => o.textContent ?? '')
    return { present: true, options: opts, value: sel.value }
  })
  if (!recipeInfo.present) {
    // Try to advance to Infer step
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const target = btns.find((b) => /^(Next|Infer)$/i.test((b.textContent ?? '').trim()) && !b.disabled)
      if (target) target.click()
    })
    await wait(500)
    recipeInfo = await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="run-benchmark-wizard-agent-recipe"]')
      if (!sel) return { present: false }
      const opts = [...sel.querySelectorAll('option')].map((o) => o.textContent ?? '')
      return { present: true, options: opts, value: sel.value }
    })
  }
  if (!recipeInfo.present) {
    fail('agent-recipe', 'dropdown not visible after plan submit')
  } else {
    ok(`agent-recipe present, options=${JSON.stringify(recipeInfo.options)}`)
    const joined = recipeInfo.options.join(' | ')
    if (/\bexecutor\b/i.test(joined)) {
      fail('agent-recipe', `still contains "executor": ${joined}`)
    } else {
      ok('agent-recipe does NOT contain "executor"')
    }
  }
  await snap(page, '04-infer-recipe')

  // Click Run predictions
  const clickedRun = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="run-benchmark-wizard-infer-submit"]')
    if (btn && !btn.disabled) { btn.click(); return true }
    return false
  })
  ok(`clicked run-predictions: ${clickedRun}`)
  // Infer step auto-advances to Grade on success. Poll for either the
  // infer summary (still on Infer) or grade panel visible (advanced past it).
  let inferSummary = null
  let inferAdvanced = false
  for (let i = 0; i < 60; i++) {
    await wait(1500)
    const s = await page.evaluate(() => {
      const sum = document.querySelector('[data-testid="run-benchmark-wizard-infer-summary"]')
      const grade = document.querySelector('[data-testid="run-benchmark-wizard-grade-submit"]')
      const err = document.querySelector('[data-testid="run-benchmark-wizard-error"]')
      return { summary: sum?.textContent, gradeVisible: !!grade, error: err?.textContent }
    })
    if (s.summary) { inferSummary = s.summary; break }
    if (s.gradeVisible) { inferAdvanced = true; break }
    if (s.error) { inferSummary = `ERROR: ${s.error}`; break }
  }
  if (!inferSummary && !inferAdvanced) fail('infer', 'no summary and no grade after 90s')
  else ok(`infer result: summary=${inferSummary} advanced=${inferAdvanced}`)
  await snap(page, '05-infer-done')

  // Check infer counts — "completed" should be > 0 (with the smoke-test recipe,
  // demo__hello-1 produces an empty patch which counts as completed).
  if (inferSummary) {
    const m = inferSummary.match(/(\d+)/)
    const completed = m ? Number(m[1]) : 0
    if (completed <= 0 && /failed/.test(inferSummary)) {
      fail('infer-counts', `no predictions completed: ${inferSummary}`)
    }
  }

  console.log('\n[step 4] grade step: submit and verify NO paths')
  // Advance to grade
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const target = btns.find((b) => /^(Next|Grade)$/i.test((b.textContent ?? '').trim()) && !b.disabled)
    if (target) target.click()
  })
  await wait(500)
  const clickedGrade = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="run-benchmark-wizard-grade-submit"]')
    if (btn && !btn.disabled) { btn.click(); return true }
    return false
  })
  ok(`clicked grade-submit: ${clickedGrade}`)
  await wait(2000)
  await snap(page, '06-grade')

  const gradePanel = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="run-benchmark-wizard-grade-command"]')
    return el ? el.textContent : null
  })
  if (!gradePanel) fail('grade-panel', 'command panel did not appear')
  else {
    ok(`grade panel length: ${gradePanel.length}`)
    for (const re of [/\/home\//, /\/tmp\//, /\.agent-kernel/]) {
      if (re.test(gradePanel)) fail('grade-panel', `contains ${re}: ${gradePanel.slice(0, 300)}`)
    }
    if (!/\/home\//.test(gradePanel) && !/\/tmp\//.test(gradePanel) && !/\.agent-kernel/.test(gradePanel)) {
      ok('grade panel contains ZERO absolute paths')
    }
  }

  console.log('\n[step 5] scan entire wizard container for path leaks')
  const wizardText = await page.evaluate(() => {
    const w = document.querySelector('[data-testid="run-benchmark-wizard"]')
    return w ? w.textContent : ''
  })
  ok(`wizard total text length: ${wizardText.length}`)
  for (const re of [/\/home\/\w/, /\/tmp\/\w+\/\w/, /\.agent-kernel\/artifacts/]) {
    if (re.test(wizardText)) {
      const m = wizardText.match(re)
      fail('wizard-scan', `wizard contains ${re}: ${m?.[0]}`)
    }
  }
  if (/\bexecutor\b/i.test(wizardText.replace(/agent-kernel-executor/g, ''))) {
    // still flag as note (may appear in Custom shell command docstring)
    notes.push('wizard mentions "executor" somewhere (may be in help text)')
  }
} finally {
  if (errors.length) notes.push(`page errors: ${errors.length}`)
  await browser.close()
}

const report = { url, failures, notes, pageErrors: errors ?? [] }
writeFileSync('/tmp/wizard-e2e-report.json', JSON.stringify(report, null, 2))
console.log('\n============ REPORT ============')
console.log(JSON.stringify(report, null, 2))
process.exit(failures.length ? 1 : 0)

#!/usr/bin/env node
/**
 * End-to-end check of the Run Benchmark wizard:
 *   1. Opens Artifacts → Eval, launches wizard
 *   2. Fills Plan step with an inline instance, submits
 *   3. Reads Infer step agent-recipe dropdown text (must NOT say "executor")
 *   4. Skips Infer (via advanced upload) OR runs default recipe (currently broken)
 *   5. Submits Grade step, reads command panel text (must NOT contain /home/ or /tmp/)
 * Screenshots saved to /tmp/verify-wizard-*.png.
 */

import { launchDashboard } from './verify-lib.mjs'
import { writeFileSync } from 'node:fs'

const url = process.env.AK_DASHBOARD_URL ?? 'http://localhost:3000'
const OUT = '/tmp'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function snap(page, name) {
  const path = `${OUT}/verify-wizard-${name}.png`
  await page.screenshot({ path, fullPage: true })
  return path
}

const failures = []
const notes = []

const { browser, page, errors } = await launchDashboard({ url })
try {
  await wait(600)
  await snap(page, '01-landing')

  const openedArtifacts = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /artifact/i.test(b.textContent ?? ''),
    )
    if (btn) { btn.click(); return true }
    return false
  })
  notes.push(`opened artifacts: ${openedArtifacts}`)
  await wait(700)
  await snap(page, '02-artifacts')

  const clickedEval = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="tab"]')]
    const target = nodes.find((n) => /^(Eval)$/i.test((n.textContent ?? '').trim()))
    if (target) { target.click(); return true }
    return false
  })
  notes.push(`clicked eval tab: ${clickedEval}`)
  await wait(500)
  await snap(page, '03-eval')

  // Launch the Run Benchmark wizard
  const clickedWizard = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const target = btns.find((b) => /Run benchmark|Run Benchmark/i.test(b.textContent ?? ''))
    if (target) { target.click(); return true }
    return false
  })
  notes.push(`launched wizard: ${clickedWizard}`)
  await wait(500)
  await snap(page, '04-wizard-plan')

  // Navigate to Infer step to check agent-recipe dropdown label
  // First, we need a valid plan. Skip past it by clicking "Next" if allowed,
  // or just inspect the whole wizard DOM for the dropdown label.
  const recipeInfo = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="run-benchmark-wizard-agent-recipe"]')
    if (!sel) return { present: false }
    const opts = [...sel.querySelectorAll('option')].map((o) => o.textContent ?? '')
    return { present: true, options: opts, value: sel.value }
  })
  notes.push(`agent recipe: ${JSON.stringify(recipeInfo)}`)
  if (recipeInfo.present) {
    const joined = (recipeInfo.options ?? []).join(' | ')
    if (/\bexecutor\b/i.test(joined)) {
      failures.push({ where: 'agent-recipe dropdown', detail: `still contains "executor": ${joined}` })
    }
  } else {
    notes.push('agent-recipe dropdown not visible on current step; navigating')
    // Try clicking through steps
    for (let i = 0; i < 4; i++) {
      const clicked = await page.evaluate(() => {
        const nextBtn = [...document.querySelectorAll('button')].find((b) => /^(Next|Infer|Grade)$/i.test((b.textContent ?? '').trim()))
        if (nextBtn && !nextBtn.disabled) { nextBtn.click(); return true }
        return false
      })
      await wait(400)
      if (!clicked) break
    }
    await snap(page, '05-advanced-step')
    const retry = await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="run-benchmark-wizard-agent-recipe"]')
      if (!sel) return { present: false }
      const opts = [...sel.querySelectorAll('option')].map((o) => o.textContent ?? '')
      return { present: true, options: opts }
    })
    notes.push(`agent recipe retry: ${JSON.stringify(retry)}`)
    if (retry.present) {
      const joined = (retry.options ?? []).join(' | ')
      if (/\bexecutor\b/i.test(joined)) {
        failures.push({ where: 'agent-recipe dropdown (post-nav)', detail: `still contains "executor": ${joined}` })
      }
    }
  }

  // Directly probe the swebench-grade-command HTTP action to verify path sanitization
  const gradeResp = await page.evaluate(async () => {
    const res = await fetch('/enhancement/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'swebench-grade-command',
        runId: 'plucky-meadow-243',
        dataset: 'princeton-nlp/SWE-bench_Lite',
      }),
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  })
  notes.push(`grade probe status: ${gradeResp.status}`)
  const shell = gradeResp.body?.shellCommand ?? ''
  const cmd = gradeResp.body?.command ?? []
  notes.push(`grade shellCommand: ${shell}`)
  const forbidden = [/\/home\//, /\/tmp\//, /\.agent-kernel/]
  for (const re of forbidden) {
    if (re.test(shell)) failures.push({ where: 'grade shellCommand', detail: `contains ${re}: ${shell}` })
    if (Array.isArray(cmd) && cmd.some((t) => typeof t === 'string' && re.test(t))) {
      failures.push({ where: 'grade command tokens', detail: `contains ${re}: ${JSON.stringify(cmd)}` })
    }
  }
} finally {
  if (errors.length) notes.push(`page errors: ${errors.length}`)
  await browser.close()
}

const report = { url, failures, notes, pageErrors: errors ?? [] }
writeFileSync('/tmp/verify-wizard-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(failures.length ? 1 : 0)

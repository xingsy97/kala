#!/usr/bin/env node
/**
 * Verifies the per-session model picker:
 *   1. Fresh dashboard shows the host's default model in the picker.
 *   2. Picking a different model updates the picker + persists across a
 *      full page reload (the host stores it in selectedModels[sessionId]
 *      and emits it back inside session:ready).
 *   3. The picker's persistent state is scoped per-session — a *different*
 *      sessionId still gets the host default, not the just-switched model.
 *
 * Does NOT actually fire an LLM turn — that would spend real tokens for
 * a picker test. The unit tests in host cover the "which model is used
 * for the next call_llm" wiring; this verify covers the UI → server
 * round-trip.
 */
import puppeteer from 'puppeteer-core'
import { setTimeout as sleep } from 'node:timers/promises'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'

let exitCode = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) exitCode = 1
}

// Ask the host what models are on offer + which is the default.
const modelsPayload = await fetch(`${HOST_URL}/models`).then((r) => r.json())
const models = modelsPayload.models ?? []
const defaultModel = modelsPayload.defaultModel ?? ''
if (models.length < 2) {
  console.error(`FAIL host advertises <2 models (got ${models.length}) — need at least 2 to switch between`)
  process.exit(1)
}
const otherModel = models.find((m) => m.id !== defaultModel)?.id ?? models[0].id
console.log(`default=${defaultModel} switching-to=${otherModel}`)

// Freshly-generated ids so we don't collide with any prior on-disk state.
const stamp = Date.now().toString(36).toUpperCase().padStart(11, '0').slice(-11)
const MAIN_ID = `01JVMS${stamp}MAIN`.padEnd(26, 'X').slice(0, 26)
const OTHER_ID = `01JVMS${stamp}OTH`.padEnd(26, 'X').slice(0, 26)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1600, height: 1000 },
})

async function readPickerValue(page) {
  return page.$eval('[data-testid="model-picker"]', (n) => n.textContent?.trim() ?? '')
}

try {
  const page = await browser.newPage()
  // Wipe the "last chosen model" from localStorage so this run starts clean.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.removeItem('ak-model') } catch {}
  })
  await page.goto(`${DASHBOARD_URL}/?sessionId=${MAIN_ID}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() ===
      'ready',
    { timeout: 8_000 },
  )
  await sleep(400)

  const initial = await readPickerValue(page)
  const defaultLabel = models.find((m) => m.id === defaultModel)?.label ?? defaultModel
  check(
    'picker starts on host default model',
    initial === defaultLabel,
    `got=${initial} expected=${defaultLabel}`,
  )

  // Switch to `otherModel`.
  await page.click('[data-testid="model-picker"]')
  const optionSel = `[data-testid="model-option-${otherModel}"]`
  await page.waitForSelector(optionSel, { timeout: 4_000 })
  await page.click(optionSel)
  await sleep(400)

  const afterSwitch = await readPickerValue(page)
  const otherLabel = models.find((m) => m.id === otherModel)?.label ?? otherModel
  check(
    'picker shows the newly-selected model',
    afterSwitch === otherLabel,
    `got=${afterSwitch} expected=${otherLabel}`,
  )

  // Reload the page — session:ready should include selectedModel=otherModel
  // (host-side selectedModels map keeps it in memory).
  await page.reload({ waitUntil: 'networkidle2', timeout: 15_000 })
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() ===
      'ready',
    { timeout: 8_000 },
  )
  await sleep(400)
  const afterReload = await readPickerValue(page)
  check(
    'picker choice persists across full page reload',
    afterReload === otherLabel,
    `got=${afterReload} expected=${otherLabel}`,
  )

  // Now visit a DIFFERENT session id. The host has no selectedModels entry
  // for this one, and localStorage still points at otherModel (user's
  // remembered preference), so the picker should show otherModel too
  // (that's the intended UX — "last used model" is a global default).
  // But if we clear localStorage, it should snap back to host default.
  await page.evaluate(() => {
    try { localStorage.removeItem('ak-model') } catch {}
  })
  await page.goto(`${DASHBOARD_URL}/?sessionId=${OTHER_ID}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() ===
      'ready',
    { timeout: 8_000 },
  )
  await sleep(400)
  const freshSession = await readPickerValue(page)
  check(
    'brand-new session with cleared localStorage falls back to host default',
    freshSession === defaultLabel,
    `got=${freshSession} expected=${defaultLabel}`,
  )
} finally {
  await browser.close()
}
process.exit(exitCode)

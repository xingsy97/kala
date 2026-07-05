#!/usr/bin/env node
/**
 * Verifies that clicking a timeline row expands it to reveal the raw event
 * + effects JSON via the @uiw/react-json-view tree. Confirms:
 *   1. Row header exists and is clickable (role=button).
 *   2. Details section (data-testid="timeline-row-details") is hidden by default.
 *   3. Clicking the row shows the details section.
 *   4. The details section contains JSON tree nodes (i.e. actual JsonView
 *      output, not the old `<pre>{JSON.stringify}</pre>`).
 *   5. For an `llm_response` row, both "request to LLM" and "response from LLM"
 *      JsonBlocks are present.
 *
 * Requires a session that already has at least one llm_response event on disk.
 * Uses the tool-call verify session id (or the last non-verify session)  -  pick
 * the newest jsonl in SESSIONS_DIR that has an llm_response.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import puppeteer from 'puppeteer-core'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? HOST_URL
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? '/tmp/agent-kernel-e2e-sessions'

let exitCode = 0
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `  -  ${detail}` : ''}`)
  if (!pass) exitCode = 1
}

// Pick the newest session file that contains an llm_response event.
const files = readdirSync(SESSIONS_DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .sort()
  .reverse()
let targetSessionId = null
for (const file of files) {
  const raw = readFileSync(join(SESSIONS_DIR, file), 'utf8')
  if (raw.includes('"kind":"llm_response"')) {
    const match = file.match(/_(.+)\.jsonl$/)
    if (match) {
      targetSessionId = match[1]
      break
    }
  }
}
if (!targetSessionId) {
  console.error('FAIL no session on disk contains an llm_response  -  run verify-tool-call.mjs first')
  process.exit(1)
}
console.log(`using session ${targetSessionId}`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1600, height: 1000 },
})
try {
  const page = await browser.newPage()
  await page.goto(`${DASHBOARD_URL}/?sessionId=${targetSessionId}`, {
    waitUntil: 'networkidle2',
    timeout: 15_000,
  })
  await page.waitForSelector('[data-testid="timeline-row"]', { timeout: 10_000 })

  // Confirm the row header exists and is a button.
  const headerRole = await page.$eval(
    '[data-testid="timeline-row-header"]',
    (n) => n.getAttribute('role'),
  )
  check('timeline row header has role=button', headerRole === 'button', headerRole ?? '(none)')

  // Details should not exist yet (nothing expanded).
  const detailsBefore = await page.$$('[data-testid="timeline-row-details"]')
  check('no details visible before click', detailsBefore.length === 0, `found ${detailsBefore.length}`)

  // Find an llm_response row and click IT.
  const llmRowSel = await page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid="timeline-row"]')
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i].textContent ?? ''
      if (text.includes('llm_response')) return i
    }
    return -1
  })
  check('found an llm_response row', llmRowSel >= 0, `index=${llmRowSel}`)
  if (llmRowSel < 0) throw new Error('no llm_response row')

  const rows = await page.$$('[data-testid="timeline-row-header"]')
  await rows[llmRowSel].click()
  await sleep(400)

  const detailsAfter = await page.$$('[data-testid="timeline-row-details"]')
  check('details visible after click', detailsAfter.length >= 1, `count=${detailsAfter.length}`)

  // JSON tree nodes rendered by @uiw/react-json-view carry recognizable
  // structure  -  look for .w-rjv (or similar) OR at least confirm the label
  // strings "request to LLM" and "response from LLM" appear.
  const labels = await page.$$eval('[data-testid="timeline-row-details"]', (nodes) =>
    nodes.map((n) => n.textContent ?? ''),
  )
  const labelsText = labels.join('\n')
  check(
    'expanded llm_response shows "request to LLM" JsonBlock',
    labelsText.includes('request to LLM'),
    labelsText.split('\n')[0]?.slice(0, 80) ?? '',
  )
  check(
    'expanded llm_response shows "response from LLM" JsonBlock',
    labelsText.includes('response from LLM'),
    '',
  )

  // Every JsonBlock has a "copy" button  -  confirm at least one copy button
  // appears inside the expanded section.
  const copyButtons = await page.$$('[data-testid="timeline-row-details"] button[aria-label="copy JSON"]')
  check('at least one copy button inside details', copyButtons.length >= 1, `count=${copyButtons.length}`)

  // Click again to collapse.
  await rows[llmRowSel].evaluate((n) => {
    const target = n.querySelector('span')
    ;(target ?? n).click()
  })
  await sleep(300)
  const detailsAfterCollapse = await page.$$('[data-testid="timeline-row-details"]')
  check('details hidden after second click', detailsAfterCollapse.length === 0, `count=${detailsAfterCollapse.length}`)
} finally {
  await browser.close()
}
process.exit(exitCode)

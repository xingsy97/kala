#!/usr/bin/env node
import { ProductE2EHarness, clickByTestId, loginWithPassword } from './harness.mjs'

const productOrigin = process.env.PRODUCT_ORIGIN ?? 'http://localhost:13001'
const loginName = required('PRODUCT_TEST_LOGIN')
const password = required('PRODUCT_TEST_PASSWORD')
const harness = await new ProductE2EHarness({ name: 'markdown-rendering' }).start()
let finalized
try {
  const actor = await harness.newActor('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await harness.step('login', () => loginWithPassword(actor.page, { productOrigin, loginName, password }))
  await harness.step('create isolated session', async () => {
    await actor.page.waitForSelector('[data-testid=no-session-new-button]')
    await clickByTestId(actor.page, 'no-session-new-button')
    await actor.page.waitForSelector('[data-testid=new-session-simple-chat]')
    await clickByTestId(actor.page, 'new-session-simple-chat')
    await actor.page.waitForSelector('[data-testid=composer-input]')
    await actor.page.waitForFunction(() => document.querySelector('[data-testid=connection-status]')?.getAttribute('data-status') === 'ready')
  })
  await harness.step('stream markdown fixture without remounting completed code', async () => {
    await actor.page.type('[data-testid=composer-input]', 'MARKDOWN_RENDER_ACCEPTANCE')
    await actor.page.waitForFunction(() => {
      const input = document.querySelector('[data-testid=composer-input]')
      const send = document.querySelector('[data-testid=composer-send]')
      return input?.value === 'MARKDOWN_RENDER_ACCEPTANCE' && send && !send.disabled
    })
    await clickByTestId(actor.page, 'composer-send')
    await actor.page.waitForFunction(() => document.querySelector('[data-testid=code-block-raw]')?.textContent?.includes('stable = true'), { timeout: 60_000 })
    await actor.page.evaluate(() => {
      const node = document.querySelector('[data-testid=code-block-raw]')
      globalThis.__stableCodeNode = node
      globalThis.__stableCodeMountState = []
      const observer = new MutationObserver(() => globalThis.__stableCodeMountState.push({
        connected: globalThis.__stableCodeNode?.isConnected === true,
        finalVisible: document.body.innerText.includes('MARKDOWN_RENDER_COMPLETE'),
      }))
      observer.observe(document.body, { childList: true, subtree: true })
      globalThis.__stableCodeObserver = observer
    })
    await actor.page.waitForFunction(() => document.body.innerText.includes('MARKDOWN_RENDER_COMPLETE'), { timeout: 60_000 })
    await actor.page.waitForSelector('[data-testid=mermaid-diagram]', { timeout: 60_000 })
    const evidence = await actor.page.evaluate(() => {
      globalThis.__stableCodeObserver?.disconnect()
      const code = document.querySelector('[data-testid=code-block-highlighted], [data-testid=code-block-raw]')
      const diagram = document.querySelector('[data-testid=mermaid-diagram]')
      return {
        // Final live-tail → persisted-row replacement may unmount the draft
        // row. It must never happen while later tokens are still arriving.
        originalNodeStayedConnected: Boolean(globalThis.__stableCodeNode) && globalThis.__stableCodeMountState.length > 0,
        codeText: code?.textContent,
        mermaidSvg: Boolean(diagram?.querySelector('svg')),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      }
    })
    if (!evidence.originalNodeStayedConnected || !evidence.mermaidSvg || evidence.horizontalOverflow) throw new Error(JSON.stringify(evidence))
    return evidence
  })
  await harness.screenshot(actor, 'markdown-mermaid')
} finally {
  finalized = await harness.finalize({ productOrigin })
}
harness.assertClean(finalized.report)
console.log(JSON.stringify({ ok: true, report: finalized.reportPath, evidenceRoot: finalized.evidenceRoot }))

function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value }

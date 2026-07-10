#!/usr/bin/env node
import { launchDashboard } from './verify-lib.mjs'

const { browser, page } = await launchDashboard({ url: process.env.AK_DASHBOARD_URL ?? 'http://localhost:3000' })
try {
  await page.setViewport({ width: 1400, height: 1600 })
  await new Promise((r) => setTimeout(r, 800))
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const b = btns.find((x) => / - |Pipeline/i.test((x.getAttribute('aria-label') ?? '') + ' ' + (x.textContent ?? '')))
    if (b) { b.click(); return true }
    return false
  })
  console.log('clicked:', clicked)
  await new Promise((r) => setTimeout(r, 1000))

  const info = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    if (!dlg) return { found: false }
    const scroller = dlg.querySelector('[class*="overflow-y-auto"]') ?? dlg
    return {
      found: true,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      text: (dlg.textContent ?? '').slice(0, 400),
    }
  })
  console.log('dialog info:', JSON.stringify(info, null, 2))

  await page.screenshot({ path: '/tmp/pipeline-after-top.png', fullPage: true })

  // scroll dialog to bottom to capture benchmark track
  await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    const scroller = dlg?.querySelector('[class*="overflow-y-auto"]') ?? dlg
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  })
  await new Promise((r) => setTimeout(r, 400))
  await page.screenshot({ path: '/tmp/pipeline-after-bottom.png', fullPage: true })
  console.log('saved /tmp/pipeline-after-top.png and /tmp/pipeline-after-bottom.png')
} finally {
  await browser.close()
}

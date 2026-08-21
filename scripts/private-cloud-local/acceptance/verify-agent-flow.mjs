#!/usr/bin/env node
import puppeteer from 'puppeteer-core'
import { loginWithPassword } from '../../product-e2e/harness.mjs'
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 })
const email = process.env.PRIVATE_CLOUD_TEST_ALICE_EMAIL?.trim(); const password = process.env.PRIVATE_CLOUD_TEST_ALICE_PASSWORD?.trim(); if (!email || !password) throw new Error('PRIVATE_CLOUD_TEST_ALICE_EMAIL and PRIVATE_CLOUD_TEST_ALICE_PASSWORD are required')
await loginWithPassword(page, { productOrigin: 'http://localhost:13001', loginName: email, password }); await page.waitForSelector('[data-testid="app-shell-nav"]'); await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="composer-input"], [data-testid="composer-input-simple"], [data-testid="no-session-new-button"]')), { timeout: 30_000 })
let composer = await page.$('[data-testid="composer-input"], [data-testid="composer-input-simple"]')
if (!composer) {
  const newSession = await page.$('[data-testid="no-session-new-button"]')
  if (!newSession) throw new Error('Neither an active composer nor the new-session entry is available')
  await newSession.click()
  await page.waitForSelector('[data-testid="new-session-simple-chat"]')
  await page.click('[data-testid="new-session-simple-chat"]')
  await page.click('[data-testid="new-session-create"]')
  await page.waitForSelector('[data-testid="composer-input"], [data-testid="composer-input-simple"]', { timeout: 30_000 })
}
const marker = `AGENT_FLOW_${Date.now()}`
const inputSelector = await page.evaluate(() => document.querySelector('[data-testid="composer-input"]')?.offsetParent ? '[data-testid="composer-input"]' : '[data-testid="composer-input-simple"]')
await page.$eval(inputSelector, (input, text) => { if ('value' in input) input.value = text; else input.textContent = text; input.dispatchEvent(new Event('beforeinput', { bubbles: true })); input.dispatchEvent(new Event('input', { bubbles: true })) }, `Reply with exactly ${marker} and nothing else.`)
const typed = await page.$eval(inputSelector, (input) => 'value' in input ? input.value : input.textContent ?? '')
if (!typed.includes(marker)) throw new Error(`composer input did not retain marker: ${typed}`)
try { await page.waitForFunction(() => { const button = document.querySelector('[data-testid=composer-send]'); return button && !button.disabled }, { timeout: 20_000 }) } catch (error) { console.error(JSON.stringify(await page.evaluate(() => ({ mode: document.querySelector('[data-testid=composer-input-simple]')?.offsetParent ? 'simple' : 'advanced', simpleText: document.querySelector('[data-testid=composer-input-simple]')?.textContent, advancedValue: document.querySelector('[data-testid=composer-input]')?.value, send: [...document.querySelectorAll('[data-testid=composer-send]')].map(b => ({ disabled: b.disabled, visible: Boolean(b.offsetParent) })), body: document.body.innerText.slice(-600) })))); throw error }
await page.$eval('[data-testid="composer-send"]', (button) => button.click())
try { await page.waitForFunction((value) => ((document.querySelector('[data-testid=composer-input]')?.value ?? document.querySelector('[data-testid=composer-input-simple]')?.textContent ?? '') === '') && document.body.innerText.split(value).length - 1 >= 2, { timeout: 30_000 }, marker) } catch (error) { console.error(JSON.stringify(await page.evaluate((value) => ({ value, occurrences: document.body.innerText.split(value).length - 1, composer: document.querySelector('[data-testid=composer-input]')?.value, tail: document.body.innerText.slice(-1200) }), marker))); throw error }
console.log(JSON.stringify({ ok: true, url: page.url(), responseVisible: true, composerCleared: true, marker }))
await page.screenshot({ path: '/tmp/private-cloud-agent-flow.png', fullPage: false }); await browser.close()

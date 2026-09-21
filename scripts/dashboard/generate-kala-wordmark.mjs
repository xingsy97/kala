#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = resolve(import.meta.dirname, '../..')
const brandDir = resolve(root, 'packages/dashboard/public/brand')
await mkdir(brandDir, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 880, height: 440, deviceScaleFactor: 1 })
  for (const variant of ['', '-light']) {
    const svg = await readFile(resolve(brandDir, `kala-wordmark${variant}.svg`), 'utf8')
    await page.setContent(`<style>html,body{width:100%;height:100%;margin:0}svg{display:block;width:100%;height:100%}</style>${svg}`)
    await page.screenshot({ path: resolve(brandDir, `kala-wordmark${variant}.png`), omitBackground: true })
  }
  console.log('Generated Kala wordmark PNG assets.')
} finally {
  await browser.close()
}

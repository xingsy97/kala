#!/usr/bin/env node
// Run with: pnpm --dir packages/host exec tsx ../../scripts/dashboard/generate-app-icons.mjs
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { octopusSvg, octopusBadgeSvg } from '../../packages/dashboard/src/brand/octopus.ts'

const root = resolve(import.meta.dirname, '../..')
const web = resolve(root, 'packages/dashboard/public')
const desktop = resolve(root, 'packages/desktop/src-tauri/icons')
mkdirSync(resolve(web, 'icons'), { recursive: true })
mkdirSync(desktop, { recursive: true })

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  async function png(svg, size, path) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
    await page.setContent(`<style>html,body{width:100%;height:100%;margin:0}svg{display:block;width:100%;height:100%}</style>${svg}`)
    await page.screenshot({ path, omitBackground: true })
  }

  writeFileSync(resolve(web, 'favicon.svg'), octopusSvg('web') + '\n')
  writeFileSync(resolve(web, 'icons/octopus-web.svg'), octopusSvg('web') + '\n')
  writeFileSync(resolve(web, 'icons/octopus-desktop.svg'), octopusSvg('desktop') + '\n')
  writeFileSync(resolve(desktop, 'icon.svg'), octopusSvg('desktop') + '\n')
  for (const size of [192, 512]) {
    await png(octopusSvg('web'), size, resolve(web, `icons/icon-${size}.png`))
    await png(octopusSvg('web', { maskable: true }), size, resolve(web, `icons/maskable-${size}.png`))
    copyFileSync(resolve(web, `icons/icon-${size}.png`), resolve(web, `icons/octopus-web-${size}.png`))
    copyFileSync(resolve(web, `icons/maskable-${size}.png`), resolve(web, `icons/octopus-maskable-${size}.png`))
  }
  await png(octopusSvg('web', { maskable: true }), 180, resolve(web, 'icons/apple-touch-icon.png'))
  copyFileSync(resolve(web, 'icons/apple-touch-icon.png'), resolve(web, 'icons/octopus-touch.png'))
  await png(octopusBadgeSvg(), 72, resolve(web, 'icons/badge-72.png'))
  await png(octopusSvg('desktop'), 256, resolve(desktop, 'icon.png'))
  console.log('Generated web, maskable, touch, notification and desktop octopus icons.')
} finally {
  await browser.close()
}

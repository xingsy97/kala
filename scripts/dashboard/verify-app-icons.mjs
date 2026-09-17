#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = resolve(import.meta.dirname, '../..')
const publicDir = resolve(root, 'packages/dashboard/public')
const evidence = resolve(root, '.artifacts/octopus-icons')
await mkdir(evidence, { recursive: true })
const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  const manifest = JSON.parse(await readFile(resolve(publicDir, 'manifest.webmanifest'), 'utf8'))
  const cases = [
    ...manifest.icons.map((icon) => ({ path: resolve(publicDir, `.${icon.src}`), size: Number(icon.sizes.split('x')[0]), maskable: icon.purpose === 'maskable' })),
    { path: resolve(publicDir, 'icons/octopus-touch.png'), size: 180, maskable: true },
    { path: resolve(publicDir, 'icons/badge-72.png'), size: 72, badge: true },
    { path: resolve(root, 'packages/desktop/src-tauri/icons/icon.png'), size: 256, desktop: true },
  ]
  const results = []
  for (const item of cases) {
    const png = await readFile(item.path)
    assert.equal(png.readUInt32BE(16), item.size)
    assert.equal(png.readUInt32BE(20), item.size)
    assert.equal(png[24], 8)
    if (item.desktop || item.badge) assert.equal(png[25], 6)
    const pixels = await page.evaluate(async ({ data, maskable, badge }) => {
      const image = new Image()
      image.src = data
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = image.width
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const rgba = context.getImageData(0, 0, image.width, image.height).data
      let foreground = 0, outsideSafeArea = 0, transparent = 0, nonWhiteBadge = 0
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4
        if (rgba[i + 3] === 0) { transparent++; continue }
        if (badge && rgba[i + 3] > 127 && (rgba[i] < 250 || rgba[i + 1] < 250 || rgba[i + 2] < 250)) nonWhiteBadge++
        if (Math.max(Math.abs(rgba[i] - 23), Math.abs(rgba[i + 1] - 37), Math.abs(rgba[i + 2] - 56)) > 8) {
          foreground++
          if (maskable && Math.hypot(x + .5 - image.width / 2, y + .5 - image.height / 2) > image.width * .4) outsideSafeArea++
        }
      }
      return { foreground, outsideSafeArea, transparent, nonWhiteBadge }
    }, { data: `data:image/png;base64,${png.toString('base64')}`, maskable: Boolean(item.maskable), badge: Boolean(item.badge) })
    assert(pixels.foreground > item.size * item.size * .08, JSON.stringify(item))
    if (item.maskable) { assert.equal(pixels.outsideSafeArea, 0); assert.equal(pixels.transparent, 0) }
    if (item.badge) { assert(pixels.transparent > item.size * item.size * .5); assert.equal(pixels.nonWhiteBadge, 0) }
    results.push({ ...item, pixels })
  }
  const web = await readFile(resolve(publicDir, 'icons/octopus-web.svg'), 'utf8')
  const desktop = await readFile(resolve(publicDir, 'icons/octopus-desktop.svg'), 'utf8')
  assert.notEqual(web, desktop)
  await page.setViewport({ width: 620, height: 290 })
  await page.setContent(`<style>body{margin:0;background:#f2f4f7;display:flex;gap:24px;padding:24px;font:14px system-ui}.row{display:flex;align-items:center;gap:16px;height:90px}svg{width:100%;height:100%}</style>${[web, desktop].map((svg) => `<div>${[16,24,32,64,128].map((size) => `<span style="display:inline-block;width:${size}px;height:${size}px;margin:6px">${svg}</span>`).join('')}</div>`).join('')}`)
  await page.screenshot({ path: resolve(evidence, 'sizes.png') })
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify({ ok: true, results }, null, 2))
  console.log(`PASS ${cases.length} icon variants, PNG formats, maskable safe zones and transparent notification badge`)
} finally {
  await browser.close()
}

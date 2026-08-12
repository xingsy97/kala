import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import test from 'node:test'

const sw = readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8')
const root = new URL('../dist/', import.meta.url)
const urls = [...sw.matchAll(/"url":"([^"]+)"/gu)].map((match) => match[1])

test('production PWA precache stays within the shell budget', () => {
  assert.ok(urls.length > 0, 'expected an injected Workbox manifest')
  assert.ok(urls.length <= 20, `precache contains ${urls.length} entries`)
  assert.ok(urls.filter((url) => /assets\/index-[^/]+\.js$/u.test(url)).length <= 1, 'only the application entry JS may be precached')
  const totalBytes = urls.reduce((sum, url) => sum + statSync(new URL(url, root)).size, 0)
  assert.ok(totalBytes <= 3 * 1024 * 1024, `precache contains ${totalBytes} uncompressed bytes`)
  for (const forbidden of ['mermaid', 'cytoscape', 'SessionFilesPanel', 'SettingsDialog']) {
    assert.equal(urls.some((url) => url.includes(forbidden)), false, `${forbidden} must remain on-demand`)
  }
})

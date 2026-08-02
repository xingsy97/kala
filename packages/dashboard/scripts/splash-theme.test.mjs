import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')

test('cold-start splash resolves system theme before first paint', () => {
  assert.match(html, /t === 'system'/)
  assert.match(html, /prefers-color-scheme: dark/)
  assert.match(html, /classList\.toggle\('dark', dark\)/)
  assert.match(html, /style\.colorScheme = dark \? 'dark' : 'light'/)
})

test('cold-start splash uses readable branding sizes', () => {
  assert.match(html, /clamp\(22px, 4\.8vw, 30px\)/)
  assert.match(html, /width: 112px/)
  assert.match(html, /width: 64px/)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/sw.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const recovery = readFileSync(new URL('../src/lib/dashboard-version-recovery.ts', import.meta.url), 'utf8')

test('PWA navigation is network-first with a precached offline fallback', () => {
  assert.match(source, /fetch\(options\.request, \{ cache: 'no-store' \}\)/u)
  assert.match(source, /createHandlerBoundToURL\(APP_SHELL_URL\)/u)
})

test('stale Vite lazy chunks trigger one bounded recovery reload', () => {
  assert.match(main, /vite:preloadError/u)
  assert.match(main, /recoverStaleDashboard/u)
  assert.match(recovery, /storage\?\.getItem\(key\) === '1'/u)
  assert.match(recovery, /registration\?\.waiting/u)
  assert.match(recovery, /window\.location\.reload\(\)/u)
})

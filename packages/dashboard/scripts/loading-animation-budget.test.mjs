import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

test('loading animations stay compositor-only and avoid full-row paint sweeps', () => {
  assert.match(css, /\.ak-loading-spinner[\s\S]*will-change: transform/)
  assert.match(css, /@keyframes ak-loading-spinner-spin/)
  assert.doesNotMatch(css, /ak-loading-sweep|ak-explorer-loading-row::after/)
  assert.match(css, /\.ak-explorer-loading-row[\s\S]*contain: paint/)
})

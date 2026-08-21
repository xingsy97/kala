import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

test('chat transcript and composer share one width and responsive side-space contract', () => {
  const chat = css.match(/\.ak-chat-container \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  const composer = css.match(/\.ak-composer-container \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  assert.match(chat, /max-width: min\(var\(--ak-chat-content-width, 84rem\), 100%\)/)
  assert.match(composer, /max-width: min\(var\(--ak-chat-content-width, 84rem\), 100%\)/)
  assert.match(chat, /padding-left: var\(--ak-chat-side-space, 1rem\)/)
  assert.match(composer, /padding-left: var\(--ak-chat-side-space, 1rem\)/)
  assert.doesNotMatch(composer, /\+ 12rem/)
})

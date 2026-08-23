import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dashboardRoot = new URL('../', import.meta.url)

test('Monaco and its workers are served by the Dashboard bundle', async () => {
  const adapter = await readFile(new URL('src/lib/monaco.tsx', dashboardRoot), 'utf8')
  const fileViewer = await readFile(new URL('src/features/session-files/SessionFilesPanel.tsx', dashboardRoot), 'utf8')
  const sourceControl = await readFile(new URL('src/features/source-control/SourceControlPanel.tsx', dashboardRoot), 'utf8')

  assert.doesNotMatch(adapter, /@monaco-editor\/react/u)
  assert.match(adapter, /monaco\.editor\.create\(/u)
  assert.match(adapter, /editor\.worker\?worker/u)
  assert.match(adapter, /json\.worker\?worker/u)
  assert.match(adapter, /css\.worker\?worker/u)
  assert.match(adapter, /html\.worker\?worker/u)
  assert.match(adapter, /ts\.worker\?worker/u)
  assert.doesNotMatch(adapter, /https?:\/\//u)
  assert.match(fileViewer, /from '\.\.\/\.\.\/lib\/monaco\.js'/u)
  assert.match(sourceControl, /from '\.\.\/\.\.\/lib\/monaco\.js'/u)
  assert.doesNotMatch(fileViewer, /from '@monaco-editor\/react'/u)
  assert.doesNotMatch(sourceControl, /from '@monaco-editor\/react'/u)
})

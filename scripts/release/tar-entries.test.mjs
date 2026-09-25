import assert from 'node:assert/strict'
import test from 'node:test'

import { tarEntries } from './tar-entries.mjs'

const members = ['win32-x64/conpty.node', 'win32-x64/pty.node', 'win32-x64/winpty-agent.exe']

test('accepts exact Windows native archive members with LF, CRLF, or backslash listings', () => {
  for (const listing of [
    members.join('\n') + '\n',
    members.join('\r\n') + '\r\n',
    members.map((name) => name.replaceAll('/', '\\')).join('\r\n') + '\r\n',
  ]) {
    const entries = tarEntries(listing)
    for (const member of members) assert(entries.has(member))
  }
})

test('rejects missing or wrong-target ConPTY binaries even after listing normalization', () => {
  const entries = tarEntries('win32-arm64/conpty.node\r\nwin32-x64/pty.node\r\nwin32-x64/winpty-agent.exe\r\n')
  assert.equal(entries.has('win32-x64/conpty.node'), false)
  assert.equal(entries.has('win32-x64/pty.node'), true)
})
